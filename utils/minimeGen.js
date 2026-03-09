// utils/minimeGen.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI, toFile } = require('openai');
const sharp = require('sharp');
const uploadToS3 = require('../utils/s3Upload');

// ---------- helpers ----------
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}
function norm(s) {
  return String(s || '').replace(/[-_]+/g, ' ').trim().toLowerCase();
}
function mapFacialHairTokens(s) {
  const x = norm(s);
  if (!x || x === 'none') return null;
  if (x.includes('little') && x.includes('moustache')) return 'thin/pencil moustache';
  if (x.includes('little') && x.includes('beard')) return 'light stubble beard';
  if (x.includes('light') && x.includes('stubble')) return 'light stubble';
  if (x.includes('trimmed') && x.includes('moustache')) return 'trimmed moustache';
  if (x.includes('goatee')) return 'goatee';
  if (x.includes('full') && x.includes('beard')) return 'full beard';
  return x; // fallback keep as is
}
function parsePremadeMeta(u) {
  const out = { skinTone: null, hair: {}, facialHair: null };
  if (!u) return out;

  // 1) query param override
  try {
    const url = new URL(u);
    const fh = url.searchParams.get('fh') || url.searchParams.get('beard');
    const st = url.searchParams.get('skinTone');
    const stache = url.searchParams.get('moustache') || url.searchParams.get('stache');
    if (st) out.skinTone = norm(st);
    const parts = [fh, stache].filter(Boolean).map(mapFacialHairTokens).filter(Boolean);
    if (parts.length) out.facialHair = parts.join(', ');
  } catch (_) {}

  // 2) filename tokens
  const name = String(u).split('/').pop().toLowerCase().replace(/\.(png|jpe?g)$/,'');
  const tokens = name.split('_');

  // skinTone: "*skintone" / "*tone"
  for (const t of tokens) {
    if (t.endsWith('skintone')) { out.skinTone = norm(t.replace('skintone','')); break; }
    if (t.endsWith('tone'))     { out.skinTone = norm(t.replace('tone',''));     break; }
  }

  // hair: "... <style>-<color>-hair" OR "... <color> hair"
  const hairToken = tokens.find(t => /hair$/.test(t));
  if (hairToken) {
    const core = hairToken.replace(/-?hair$/,'');
    const [a,b] = core.split('-');
    if (b) { out.hair.style = norm(a); out.hair.color = norm(b); }
    else { out.hair.color = norm(a); }
  }

  // facial hair via explicit fragments: "...with-xxx" OR "...little-beard_little-moustache"
  const fhFrags = name
    .split('with-').pop() // if 'with-' exists, returns tail; else returns same name
    .split('_')
    .filter(t => /(moustache|beard|stubble|goatee)/.test(t));
  const mapped = fhFrags.map(mapFacialHairTokens).filter(Boolean);
  if (mapped.length) out.facialHair = mapped.join(', ');

  return out;
}

function mapGlasses(glassesKey) {
  if (!glassesKey || glassesKey === 'none') return null;
  if (typeof glassesKey === 'string' && glassesKey.startsWith('http')) return glassesKey;

  const GLASSES_MAP = {
    none: null,
    'wayfarer-black': 'matte black wayfarer eyeglasses, medium-thick frame',
    'round-gold': 'thin round gold metal eyeglasses',
    'aviator-silver': 'thin silver aviator eyeglasses',
    'rectangle-black': 'rectangular full-rim black eyeglasses, slim frame',
  };
  return GLASSES_MAP[glassesKey] || glassesKey;
}

function normalizeOutfit({ shirt, pant, shoes, glasses, lipstick, jewelry, bag,watch }) {
  return {
    shirt: shirt || 'basic solid color t-shirt',
    pant: pant || 'straight jeans',
    shoes: shoes || 'casual sneakers',
    glasses: mapGlasses(glasses),
    lipstick,
    jewelry,
    bag,
    watch
  };
}

function colorHintFromString(s) {
  const l = String(s).toLowerCase();
  if (l.includes('rose')) return 'rose gold';
  if (l.includes('gold')) return 'gold';
  if (l.includes('silver') || l.includes('stainless')) return 'silver';
  if (l.includes('black')) return 'black';
  if (l.includes('pink')) return 'pink';
  if (l.includes('red')) return 'red';
  if (l.includes('yellow')) return 'yellow';
  if (l.includes('green')) return 'green';
  if (l.includes('light-blue') || l.includes('lightblue')) return 'light blue';
  if (l.includes('blue')) return 'blue';
  if (l.includes('purple')) return 'purple';
  return null;
}
function isWatchRef(v) {
  const s = String(v || '').toLowerCase();
  return s.includes('/watches/') || s.includes('watch');
}

function accessoriesLines(o, isFeminine) {
  const bag = o.bag || 'none';

  // lipstick শুধু feminine এ দেখাবো
  const lips = isFeminine ? (o.lipstick || 'natural') : null;

  let necklace = 'none', earrings = 'none', wrist = 'none';

  // ✅ watch source: o.watch (if you later add) OR jewelry URL that looks like a watch
  const jewelryRaw = o.jewelry || '';
  const watchCandidate =
    (o.watch && String(o.watch).trim()) ? o.watch :
    (isWatchRef(jewelryRaw) ? jewelryRaw : null);

  // ✅ wrist watch instruction (works for masculine + feminine)
  if (watchCandidate) {
    wrist = isHttpUrl(watchCandidate)
      ? `EXACTLY match this watch image → ${watchCandidate}. Fit it on the wrist realistically, correct scale, not oversized.`
      : String(watchCandidate);
  }

  // ✅ feminine-only jewelry interpretation (necklace/earrings)
  if (isFeminine && jewelryRaw && !isWatchRef(jewelryRaw)) {
    const raw = String(jewelryRaw).toLowerCase();
    if (raw.includes('chain') || raw.includes('necklace')) necklace = 'plain thin chain necklace (no pendant)';
    if (raw.includes('earring')) earrings = 'small stud earrings';
  }

  return `
# ACCESSORIES
${isFeminine ? `- Lipstick: ${lips}
- Necklace: ${necklace}
- Earrings: ${earrings}` : ''}
- Wrist: ${wrist}
- Bag: ${bag}
`.trim();
}



// Map weight (1-4) and height (S/M/L) to explicit body descriptions
function describeBodyShape(weight, height) {
  const weightDesc = {
    1: { build: 'very slim and thin', detail: 'narrow shoulders, thin arms, flat stomach, thin legs, petite/lean frame' },
    2: { build: 'average/moderate', detail: 'normal shoulder width, lightly toned arms, flat-to-slight stomach, average legs' },
    3: { build: 'slightly heavy/curvy', detail: 'broader shoulders, thicker arms, noticeable belly, fuller thighs and legs' },
    4: { build: 'heavy/plus-size', detail: 'wide shoulders, thick arms, round belly, wide hips, thick legs, large frame' },
  };
  const heightDesc = {
    S: { label: 'short', ratio: 'shorter than average, compact proportions' },
    M: { label: 'medium/average', ratio: 'average height, standard proportions' },
    L: { label: 'tall', ratio: 'taller than average, elongated proportions' },
  };
  const w = weightDesc[weight] || weightDesc[2];
  const h = heightDesc[height] || heightDesc['M'];
  return { weightBuild: w.build, weightDetail: w.detail, heightLabel: h.label, heightRatio: h.ratio };
}

function buildMinimePrompt({ isFeminine, outfit, facialHair, skinToneHint, hairHint, bodyWeight, bodyHeight }) {
  const o = outfit || {};
  const noGlasses = !o.glasses;

  const glassesLine = noGlasses
    ? `- Glasses: none (REMOVE any eyewear from the face reference; no frames, lenses, reflections or shadows).`
    : (typeof o.glasses === 'string' && o.glasses.startsWith('http')
        ? `- Glasses: EXACTLY match this image → ${o.glasses}.
           Replace/override any eyewear present in the face reference.
           Use the same frame SHAPE and COLOR from the image.
           Do NOT switch to black/gray frames if the image has color.`
        : `- Glasses: ${o.glasses} (must be clearly visible, correctly aligned with the eyes).`);

  const facialHairLines = (!facialHair || facialHair === 'none')
    ? `- Facial hair: none; keep CLEAN-SHAVEN with no moustache and no stubble.`
    : `- Facial hair: ${facialHair}; ADD as specified even if the face reference is clean-shaven; keep neat and match hair color.`;

  // Build explicit body shape description from metadata
  const bodyDesc = describeBodyShape(bodyWeight, bodyHeight);
  const bodyShapeSection = `
# BODY SHAPE — THIS IS THE HIGHEST PRIORITY CONSTRAINT
One of the reference images is a body shape silhouette. The character's body MUST match it EXACTLY.
- Build: ${bodyDesc.weightBuild} (weight level ${bodyWeight || '?'} out of 4)
- Body details: ${bodyDesc.weightDetail}
- Height: ${bodyDesc.heightLabel} (${bodyDesc.heightRatio})
- Match the EXACT waist width, hip width, arm thickness, leg thickness, torso length, and overall body mass from the body shape reference image.
- The body shape silhouette defines proportions ONLY — do NOT copy its skin color or face.
- Do NOT make the character fatter or thinner than the body shape reference.
- Do NOT default to an average/medium build — follow the reference PRECISELY.`.trim();

  return `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

${bodyShapeSection}

# FACE CONSTRAINTS
- STRICT facial likeness from the face/selfie reference image.
- FACE & ETHNICITY: The face reference image is the SOLE and ABSOLUTE source for ALL facial features, skin color, ethnicity, and racial characteristics. COPY EXACTLY — same skin tone, same undertone, same ethnic features, same face structure, same nose shape, same lip shape, same eye shape.${skinToneHint ? ` Target undertone → ${skinToneHint}.` : ''}
${facialHairLines}
- Hair: copy the same style and texture from the face reference${hairHint?.style ? `; keep style ~ ${hairHint.style}` : ''}${hairHint?.color ? `; color ~ ${hairHint.color}` : ''}.

# CAMERA & FRAMING
- Camera: straight-on, full-body. Subject fully contained in frame.
- Keep ~10–12% empty space above the head and below the shoe soles.
- Both feet visible, standing on a flat plane. No cropping anywhere.
- Background: TRANSPARENT (no background at all). Only render the character, nothing behind.
- Lighting: soft, even, no harsh shadows.

# OUTFIT (match EXACTLY; http(s) = strict visual refs)
- Shirt/top: ${o.shirt || 'basic solid color t-shirt'}
- Pants/bottom: ${o.pant || 'straight jeans'}
- Shoes: ${o.shoes || 'casual sneakers'}
${glassesLine}
${accessoriesLines(o, isFeminine)}

# COMPOSITION & STYLE
- Neutral pose, arms relaxed by sides, single character only.
- Clean edges, smooth materials, vivid but realistic colors.
- Maintain the proportions of the body shape reference; do not exaggerate head size.
- No extra props, text, or background objects.

# NEGATIVE INSTRUCTIONS
- Do NOT crop hair or shoes.
- Do NOT turn the body away; keep front-facing.
- Do NOT ignore the body shape — a weight-1 character must be THIN, not average or chubby.
- Do NOT change accessory colors; use the specified color or the image reference color exactly.
- Do NOT add pendants/lockets/charms to necklaces unless explicitly specified.
- Do NOT add earrings unless the jewelry explicitly contains "earring".
- Do NOT lighten the skin or change undertone relative to the face reference.
- Do NOT change the ethnicity or racial features from the face reference. An Indian face must produce an Indian avatar, an African face must produce an African avatar, etc.
- Do NOT blend or average facial features with the body shape reference. The body shape is ONLY for proportions and pose — ALL facial features and skin color come EXCLUSIVELY from the face reference.
- Do NOT substitute features from a different ethnic group.
${(!facialHair || facialHair === 'none')
  ? `- Do NOT add any beard, moustache, goatee or stubble.`
  : `- Do NOT ignore the facial hair instruction; render it clearly and correctly.`}

Return a single, centered full-body render.
`.trim();
}

// ---------- fetch image as buffer ----------
async function fetchImageAsBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.error(`Failed to fetch image from ${url}:`, e.message);
    return null;
  }
}

// ---------- collect outfit image URLs ----------
function collectOutfitImageUrls(outfit) {
  const urls = [];
  const fields = ['shirt', 'pant', 'shoes', 'glasses', 'jewelry', 'bag', 'watch'];
  for (const field of fields) {
    const val = outfit[field];
    if (val && isHttpUrl(val)) {
      urls.push({ field, url: val });
    }
  }
  return urls;
}

// ---------- compress image ----------
async function compressForMobile(rawBuffer) {
  const compressed = await sharp(rawBuffer)
    .resize(768, 1152, { fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 0.5 })          // counteract downscale blur
    .webp({
      quality: 85,
      alphaQuality: 95,               // clean transparent edges
      effort: 4,                       // balanced compression (nearly same size, faster encode)
      smartSubsample: true,            // better color detail
    })
    .toBuffer();

  const originalKB = (rawBuffer.length / 1024).toFixed(0);
  const compressedKB = (compressed.length / 1024).toFixed(0);
  console.log(`  Image compressed: ${originalKB} KB → ${compressedKB} KB (webp 768×1152)`);

  return compressed;
}

// ---------- image upload ----------
async function uploadOpenAIImageResult(imageResponse, keyPrefix) {
  const item = imageResponse?.data?.[0];
  if (!item) throw new Error('OpenAI image response empty');

  let rawBuffer;
  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Failed to fetch image from ${item.url}`);
    rawBuffer = Buffer.from(await res.arrayBuffer());
  } else if (item.b64_json) {
    rawBuffer = Buffer.from(item.b64_json, 'base64');
  } else {
    throw new Error('No url or b64_json in OpenAI image response');
  }

  const compressed = await compressForMobile(rawBuffer);
  const file = { originalname: `${keyPrefix}.webp`, buffer: compressed, mimetype: 'image/webp' };
  return await uploadToS3(file, 'minimes');
}

// ---------- main ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.renderCurrentMinime = async (userId, opts = {}) => {
  // Fetch user + draft minime in parallel (both independent DB queries)
  const [user, existingDraft] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    opts.targetMinimeId
      ? prisma.minime.findUnique({ where: { id: opts.targetMinimeId } })
      : prisma.minime.findFirst({
          where: { userId, isDraft: true, isSaved: false },
          orderBy: { createdAt: 'desc' },
        }),
  ]);

  // Body shape: use override from opts if provided, else fall back to user profile
  const effectiveBodyShapeUrl = opts.bodyShapeUrl || user?.bodyShapeUrl;
  if (!effectiveBodyShapeUrl) throw new Error('Missing body shape');

  // Body type: use override from opts if provided, else fall back to user profile
  const effectiveBodyType = opts.bodyType || user?.bodyType;

  // Use existing draft or create new one
  let mm = existingDraft;
  if (!mm) {
    mm = await prisma.minime.create({ data: { userId, isSaved: false, isDraft: true } });
  }

  const isFeminine = effectiveBodyType === 'feminine';

  // Start body shape DB lookup early (runs in parallel with face resolution below)
  const bodyShapePromise = prisma.bodyShape.findFirst({
    where: { imageUrl: effectiveBodyShapeUrl },
    select: { weight: true, height: true },
  });

  // Face reference priority: opts.faceUrl > User.selfieUrl (canonical) > draft selfieUrl > any Minime selfieUrl
  let faceReference = null;
  let faceRefSource = 'none';

  if (opts.faceUrl && isHttpUrl(opts.faceUrl)) {
    faceReference = opts.faceUrl;
    faceRefSource = 'opts.faceUrl';
  } else if (user?.selfieUrl && isHttpUrl(user.selfieUrl)) {
    // Canonical selfie on User profile — always preferred (never lost by draft deletion)
    faceReference = user.selfieUrl;
    faceRefSource = 'User.selfieUrl (canonical)';
  } else if (mm.selfieUrl && isHttpUrl(mm.selfieUrl)) {
    faceReference = mm.selfieUrl;
    faceRefSource = 'mm.selfieUrl (current draft)';
  } else {
    // Search ALL user's MiniMe records for any existing selfieUrl
    const withSelfie = await prisma.minime.findFirst({
      where: { userId, selfieUrl: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { selfieUrl: true },
    });
    if (withSelfie?.selfieUrl && isHttpUrl(withSelfie.selfieUrl)) {
      faceReference = withSelfie.selfieUrl;
      faceRefSource = 'previous MiniMe selfieUrl';
      // Backfill to current draft so future renders don't need to search again
      await prisma.minime.update({ where: { id: mm.id }, data: { selfieUrl: faceReference } });
    }
  }

  console.log(`[FACE REF] userId=${userId} source="${faceRefSource}" url=${faceReference || 'NULL'}`);

  if (!faceReference) {
    throw new Error('No selfie/premade found. Upload a selfie or select a premade avatar first.');
  }

  // parse hints from premade url
  const meta = parsePremadeMeta(faceReference);

  // resolve hints (priority: explicit opts > url meta > defaults)
  const facialHair = isFeminine ? 'none'
    : (opts.facialHair && String(opts.facialHair).trim())
      || meta.facialHair
      || 'none';
  // Only use explicit frontend skin tone override — never premade filename metadata
  const skinToneHint = opts.skinTone || null;
  const hairHint = meta.hair;

  // outfit resolve (opts override DB)
  const outfitForModel = normalizeOutfit({
    shirt:    opts.shirt    ?? mm.shirt,
    pant:     opts.pant     ?? mm.pant,
    shoes:    opts.shoes    ?? mm.shoes,
    glasses:  opts.glasses  ?? mm.glasses,
    lipstick: opts.lipstick ?? mm.lipstick,
    jewelry:  opts.jewelry  ?? mm.jewelry,
    bag:      opts.bag      ?? mm.bag,
      watch:    opts.watch    ?? mm.watch,
  });

  // Await body shape lookup (was started in parallel above)
  let bodyWeight = null, bodyHeight = null;
  const bodyShapeRecord = await bodyShapePromise;
  if (bodyShapeRecord) {
    bodyWeight = bodyShapeRecord.weight;
    bodyHeight = bodyShapeRecord.height;
    console.log(`[BODY SHAPE] weight=${bodyWeight} height=${bodyHeight}`);
  } else {
    console.warn(`[BODY SHAPE] No DB record found for URL — using image reference only`);
  }

  const prompt = buildMinimePrompt({
    isFeminine,
    outfit: outfitForModel,
    facialHair,
    skinToneHint,
    hairHint,
    bodyWeight,
    bodyHeight,
  });

  // Collect clothing reference images (URLs)
  const outfitUrls = collectOutfitImageUrls(outfitForModel);

  console.log('\n========== MINIME GENERATION ==========');
  console.log('INPUT IMAGE URLs:');
  console.log(`  [bodyShape] ${effectiveBodyShapeUrl || 'NONE'}`);
  outfitUrls.forEach(({ field, url }) => {
    console.log(`  [${field}] ${url}`);
  });
  if (outfitUrls.length === 0) {
    console.log('  (no outfit image URLs - using text descriptions)');
  }

  let imageResponse;

  // Fetch ALL reference images in parallel (face + body + outfit)
  const fetchTasks = [];

  // 1) Face reference — MOST IMPORTANT
  fetchTasks.push(
    fetchImageAsBuffer(faceReference).then(async buf => {
      if (buf) {
        const file = await toFile(buf, 'face-reference.png', { type: 'image/png' });
        console.log(`✓ Fetched FACE reference: ${faceReference.substring(0, 80)}...`);
        return { order: 0, file };
      }
      console.warn(`✗ Failed to fetch face reference: ${faceReference} — generation may lack facial accuracy`);
      return null;
    })
  );

  // 2) Body shape — for proportions
  if (effectiveBodyShapeUrl && isHttpUrl(effectiveBodyShapeUrl)) {
    fetchTasks.push(
      fetchImageAsBuffer(effectiveBodyShapeUrl).then(async buf => {
        if (buf) {
          const file = await toFile(buf, 'body-shape.png', { type: 'image/png' });
          console.log(`✓ Fetched BODY SHAPE: ${effectiveBodyShapeUrl.substring(0, 80)}...`);
          return { order: 1, file };
        }
        console.warn(`✗ Failed to fetch body shape: ${effectiveBodyShapeUrl}`);
        return null;
      })
    );
  }

  // 3) Clothing reference images
  outfitUrls.forEach(({ field, url }, idx) => {
    fetchTasks.push(
      fetchImageAsBuffer(url).then(async buf => {
        if (buf) {
          const file = await toFile(buf, `${field}.png`, { type: 'image/png' });
          console.log(`✓ Fetched ${field}: ${url.substring(0, 80)}...`);
          return { order: 2 + idx, file };
        }
        console.log(`✗ Failed to fetch ${field}: ${url}`);
        return null;
      })
    );
  });

  // Wait for all fetches to complete simultaneously
  const results = await Promise.all(fetchTasks);
  const referenceImages = results
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map(r => r.file);

  if (referenceImages.length > 0) {
    console.log(`Using images.edit() with ${referenceImages.length} reference image(s) [face + body + outfit]`);
    imageResponse = await openai.images.edit({
      model: 'gpt-image-1',
      image: referenceImages,
      prompt,
      size: '1024x1536',
      background: 'transparent',
    });
  } else {
    // Fallback to generate only if ALL fetches failed
    console.warn('No reference images fetched — using text-only generation');
    imageResponse = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1536',
      background: 'transparent',
    });
  }

  const uploadedImageUrl = await uploadOpenAIImageResult(
    imageResponse,
    `minime-${userId}-${Date.now()}`
  );

  console.log('\nOUTPUT IMAGE URL (Preview):');
  console.log(`  ${uploadedImageUrl}`);
  console.log('========================================\n');

  const updated = await prisma.minime.update({
    where: { id: mm.id },
    data: {
      avatarUrl: uploadedImageUrl,
      // keep the latest outfit selections so the next draft inherits them
      shirt: outfitForModel.shirt,
      pant: outfitForModel.pant,
      shoes: outfitForModel.shoes,
      glasses: outfitForModel.glasses,
      lipstick: outfitForModel.lipstick,
      jewelry: outfitForModel.jewelry,
      bag: outfitForModel.bag,
      isDraft: true,
      isSaved: false,
    },
  });

  return updated;
};
