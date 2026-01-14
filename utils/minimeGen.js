// utils/minimeGen.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI } = require('openai');
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

function normalizeOutfit({ shirt, pant, shoes, glasses, lipstick, jewelry, bag }) {
  return {
    shirt: shirt || 'basic solid color t-shirt',
    pant: pant || 'straight jeans',
    shoes: shoes || 'casual sneakers',
    glasses: mapGlasses(glasses),
    lipstick,
    jewelry,
    bag,
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
function accessoriesLines(o, isFeminine) {
  const bag = o.bag || 'none';
  const lips = o.lipstick || 'natural';

  let necklace = 'none', earrings = 'none', wrist = 'none';

  // ✅ WATCH for both masculine & feminine
  if (o.watch) {
    wrist = o.watch.startsWith('http')
      ? `EXACTLY match this watch image → ${o.watch}. Realistic wrist fit, correct scale.`
      : o.watch;
  }

  // Feminine-only extras
  if (isFeminine) {
    const raw = o.jewelry || '';
    if (raw.includes('chain')) necklace = 'plain thin chain necklace';
    if (raw.includes('earring')) earrings = 'small stud earrings';
  }

  return `
# ACCESSORIES
- Wrist: ${wrist}
${isFeminine ? `- Necklace: ${necklace}
- Earrings: ${earrings}
- Lipstick: ${lips}` : ''}
- Bag: ${bag}
`.trim();
}


function buildMinimePrompt({ bodyShapeUrl, faceUrl, isFeminine, outfit, facialHair, skinToneHint, hairHint }) {
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

  return `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

# HARD CONSTRAINTS
- STRICT body shape reference: ${bodyShapeUrl}
- STRICT facial likeness from: ${faceUrl}
- Skin tone: COPY EXACTLY from the face reference image.${skinToneHint ? ` Target undertone → ${skinToneHint}.` : ''}
${facialHairLines}
- Camera: straight-on, full-body. Subject fully contained in frame.
- Keep ~10–12% empty space above the head and below the shoe soles.
- Both feet visible, standing on a flat plane. No cropping anywhere.
- Background: plain white (or transparent if API parameter is given).
- Lighting: soft, even, no harsh shadows.
- Hair: copy the same style and texture from the face reference${hairHint?.style ? `; keep style ~ ${hairHint.style}` : ''}${hairHint?.color ? `; color ~ ${hairHint.color}` : ''}.

# OUTFIT (match EXACTLY; http(s) = strict visual refs)
- Shirt/top: ${o.shirt || 'basic solid color t-shirt'}
- Pants/bottom: ${o.pant || 'straight jeans'}
- Shoes: ${o.shoes || 'casual sneakers'}
${glassesLine}
${accessoriesLines(o, isFeminine)}


# COMPOSITION & STYLE
- Neutral pose, arms relaxed by sides, single character only.
- Clean edges, smooth materials, vivid but realistic colors.
- Maintain the proportions of the provided body shape; do not exaggerate head size.
- No extra props, text, or background objects.

# NEGATIVE INSTRUCTIONS
- Do NOT crop hair or shoes.
- Do NOT turn the body away; keep front-facing.
- Do NOT change accessory colors; use the specified color or the image reference color exactly.
- Do NOT add pendants/lockets/charms to necklaces unless explicitly specified.
- Do NOT add earrings unless the jewelry explicitly contains "earring".
- Do NOT lighten the skin or change undertone relative to the face reference.
${(!facialHair || facialHair === 'none')
  ? `- Do NOT add any beard, moustache, goatee or stubble.`
  : `- Do NOT ignore the facial hair instruction; render it clearly and correctly.`}

Return a single, centered full-body render.
`.trim();
}

// ---------- image upload ----------
async function uploadOpenAIImageResult(imageResponse, keyPrefix) {
  const item = imageResponse?.data?.[0];
  if (!item) throw new Error('OpenAI image response empty');

  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Failed to fetch image from ${item.url}`);
    const buffer = await res.arrayBuffer();
    const file = { originalname: `${keyPrefix}.png`, buffer: Buffer.from(buffer), mimetype: 'image/png' };
    return await uploadToS3(file, 'minimes');
  }

  if (item.b64_json) {
    const buffer = Buffer.from(item.b64_json, 'base64');
    const file = { originalname: `${keyPrefix}.png`, buffer, mimetype: 'image/png' };
    return await uploadToS3(file, 'minimes');
  }
  throw new Error('No url or b64_json in OpenAI image response');
}

// ---------- main ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.renderCurrentMinime = async (userId, opts = {}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bodyShapeUrl) throw new Error('Missing body shape');

  // get/create working draft
  let mm = await prisma.minime.findFirst({
    where: { userId, isDraft: true, isSaved: false },
    orderBy: { createdAt: 'desc' },
  });
  if (!mm) {
    mm = await prisma.minime.create({ data: { userId, isSaved: false, isDraft: true } });
  }

  const isFeminine = user.bodyType === 'feminine';

  // ✅ premade/faceUrl from frontend wins
  const faceReference =
    (opts.faceUrl && isHttpUrl(opts.faceUrl)) ? opts.faceUrl :
    (mm.selfieUrl && isHttpUrl(mm.selfieUrl)) ? mm.selfieUrl :
    (mm.avatarUrl && isHttpUrl(mm.avatarUrl)) ? mm.avatarUrl :
    user.bodyShapeUrl;

  if (!isHttpUrl(faceReference)) {
    throw new Error('Missing/invalid face reference; upload a selfie or select a premade first');
  }

  // parse hints from premade url
  const meta = parsePremadeMeta(faceReference);

  // resolve hints (priority: explicit opts > url meta > defaults)
  const facialHair = isFeminine ? 'none'
    : (opts.facialHair && String(opts.facialHair).trim())
      || meta.facialHair
      || 'none';
  const skinToneHint = opts.skinTone || meta.skinTone;
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
  });

  const prompt = buildMinimePrompt({
    bodyShapeUrl: user.bodyShapeUrl,
    faceUrl: faceReference,
    isFeminine,
    outfit: outfitForModel,
    facialHair,
    skinToneHint,
    hairHint,
  });

  const imageResponse = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1024x1536',
    background: 'transparent',
  });

  const uploadedImageUrl = await uploadOpenAIImageResult(
    imageResponse,
    `minime-${userId}-${Date.now()}`
  );

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
