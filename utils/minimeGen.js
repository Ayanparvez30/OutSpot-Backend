// utils/minimeGen.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI } = require('openai');
const uploadToS3 = require('../utils/s3Upload');

// ---------- helpers ----------
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
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

function mapGlasses(glassesKey) {
  if (!glassesKey || glassesKey === 'none') return null;

  // Strict visual ref if URL
  if (typeof glassesKey === 'string' && glassesKey.startsWith('http')) {
    return glassesKey;
  }

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

function accessoriesLines(o, isFeminine) {
  if (!isFeminine) return '';
  const raw = o.jewelry || '';
  const j = String(raw).toLowerCase();

  const bag = o.bag || 'none';
  const lips = o.lipstick || 'natural';

  let necklace = 'none';
  let earrings = 'none';
  let wrist = 'none';

  // NEW: URL দিলে exact-match + color hint
  if (/^https?:\/\//i.test(raw)) {
    const color = colorHintFromString(raw) || 'as in the reference image';
    necklace = `EXACTLY match this image → ${raw}. Plain thin chain only (NO pendant/charm). Color: ${color}.`;
    earrings = 'none';
  } else if (j.includes('chain') || j.includes('necklace')) {
    necklace = 'plain thin chain necklace (no pendant, no charm, minimalist)';
    earrings = 'none';
  } else if (j.includes('earring')) {
    earrings = 'small stud earrings';
  } else if (j.includes('watch')) {
    wrist = 'minimal watch';
  } else if (j.includes('bracelet')) {
    wrist = 'simple bracelet';
  } else if (j && j !== 'none') {
    necklace = `${raw} (no pendant unless explicitly specified)`;
  }

  return `
# ACCESSORIES
- Lipstick: ${lips}
- Necklace: ${necklace}
- Earrings: ${earrings}
- Wrist: ${wrist}
- Bag: ${bag}`.trim();
}


function buildMinimePrompt({ bodyShapeUrl, faceUrl, isFeminine, outfit }) {
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

  const prompt = `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

# HARD CONSTRAINTS
- STRICT body shape reference: ${bodyShapeUrl}
- STRICT facial likeness from: ${faceUrl}
- Skin tone: match the face reference EXACTLY; do not lighten or darken.
- Hair: copy the same style and texture from the face reference (no straightening, no length change).
- Camera: straight-on, full-body. Subject fully contained in frame.
- Keep ~10–12% empty space above the head and below the shoe soles.
- Both feet visible, standing on a flat plane. No cropping anywhere.
- Background: plain white (or transparent if API parameter is given).
- Lighting: soft, even, no harsh shadows.

# OUTFIT (match EXACTLY; http(s) = strict visual refs)
- Shirt/top: ${o.shirt || 'basic solid color t-shirt'}
- Pants/bottom: ${o.pant || 'straight jeans'}
- Shoes: ${o.shoes || 'casual sneakers'}
${glassesLine}

${isFeminine ? accessoriesLines(o, isFeminine) : ''}

# COMPOSITION & STYLE
- Neutral pose, arms relaxed by sides, single character only.
- Clean edges, smooth materials, vivid but realistic colors.
- Maintain the proportions of the provided body shape; do not exaggerate head size.
- No extra props, text, or background objects.

# NEGATIVE INSTRUCTIONS
- Do NOT crop hair or shoes.
- Do NOT turn the body away; keep front-facing.
- Do NOT add pendants/lockets/charms to necklaces unless explicitly specified.
- Do NOT add earrings unless the jewelry explicitly contains "earring".
- Do NOT change accessory colors; use the specified color or the image reference color exactly.

${noGlasses
  ? `- Do NOT include any kind of eyewear or eyewear artifacts.`
  : `- Do NOT ignore the glasses reference. If the reference color is yellow/red/etc., do NOT render black/gray frames.`}

Return a single, centered full-body render.
`.trim();

  return prompt;
}

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.renderCurrentMinime = async (userId, opts = {}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bodyShapeUrl) throw new Error('Missing body shape');

 
  let mm = null;
  if (opts.targetMinimeId) {
    mm = await prisma.minime.findUnique({ where: { id: opts.targetMinimeId } });
    if (!mm || mm.userId !== userId) {
      throw new Error('Invalid targetMinimeId for this user');
    }
  } else {

    mm = await prisma.minime.findFirst({
      where: { userId, isDraft: true, isSaved: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!mm) {
      const saved = await prisma.minime.findFirst({
        where: { userId, isSaved: true },
        orderBy: { createdAt: 'desc' },
      });
      const base = saved ? {
        shirt: saved.shirt,
        pant: saved.pant,
        shoes: saved.shoes,
        glasses: saved.glasses,
        lipstick: saved.lipstick,
        jewelry: saved.jewelry,
        bag: saved.bag,
        selfieUrl: saved.selfieUrl ?? null,
      } : {};
      mm = await prisma.minime.create({
        data: { userId, ...base, isSaved: false, isDraft: true },
      });
    }
  }


  const isFeminine = user.bodyType === 'feminine';
  const faceReference = mm.selfieUrl || mm.avatarUrl || user.bodyShapeUrl;


  const outfitForModel = normalizeOutfit({
    shirt: mm.shirt,
    pant: mm.pant,
    shoes: mm.shoes,
    glasses: mm.glasses,
    lipstick: mm.lipstick,
    jewelry: mm.jewelry,
    bag: mm.bag,
  });

  const prompt = buildMinimePrompt({
    bodyShapeUrl: user.bodyShapeUrl,
    faceUrl: faceReference,
    isFeminine,
    outfit: outfitForModel,
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
    data: { avatarUrl: uploadedImageUrl, isDraft: true, isSaved: false },
  });

  return updated;
};
