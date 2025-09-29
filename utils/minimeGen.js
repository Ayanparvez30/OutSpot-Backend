// utils/minimeGen.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI } = require('openai');
const uploadToS3 = require('../utils/s3Upload');

// ---- helpers
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

function accessoriesLines(o, isFeminine) {
  if (!isFeminine) return '';
  const j = (o.jewelry || '').toLowerCase();

  let necklace = 'none';
  let earrings = 'none';
  let wrist = 'none';
  const bag = o.bag || 'none';
  const lips = o.lipstick || 'natural';

  if (j.includes('chain') || j.includes('necklace')) {
    necklace = 'plain thin chain necklace (no pendant, no charm, minimalist)';
    earrings = 'none';
  } else if (j.includes('earring')) {
    earrings = 'small stud earrings';
  } else if (j.includes('watch')) {
    wrist = 'minimal watch';
  } else if (j.includes('bracelet')) {
    wrist = 'simple bracelet';
  } else if (j && j !== 'none') {
    necklace = `${j} (no pendant unless explicitly specified)`;
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
- STRICT facial likeness (HARD LOCK): copy EXACTLY from this image → ${faceUrl}
  (match skin tone, hairstyle, hair texture, eye shape, eyebrows, nose, lips, jawline;
   do not beautify, age, or alter expression. If any conflict arises, the face reference WINS.)
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
${noGlasses
  ? `- Do NOT include any kind of eyewear or eyewear artifacts.`
  : `- Do NOT ignore the glasses reference. If the reference color is yellow/red/etc., do NOT render black/gray frames.`}

Return a single, centered full-body render.
`.trim();

  return prompt;
}

// ---- image upload
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

// ---- main
exports.renderCurrentMinime = async (userId, opts = {}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.bodyShapeUrl) throw new Error('Missing body shape');

  let mm;
  if (opts.targetMinimeId) {
    mm = await prisma.minime.findUnique({ where: { id: opts.targetMinimeId } });
    if (!mm || mm.userId !== userId) throw new Error('Invalid targetMinimeId for this user');
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
      const base = saved
        ? {
            shirt: saved.shirt,
            pant: saved.pant,
            shoes: saved.shoes,
            glasses: saved.glasses,
            lipstick: saved.lipstick,
            jewelry: saved.jewelry,
            bag: saved.bag,
            selfieUrl: saved.selfieUrl ?? null,
          }
        : {};
      mm = await prisma.minime.create({
        data: { userId, ...base, isSaved: false, isDraft: true },
      });
    }
  }

  const isFeminine = user.bodyType === 'feminine';

  // face must be selfie/premade; don't fall back to avatarUrl
  const faceReference = opts.faceUrl || mm.selfieUrl;
  if (!faceReference) throw new Error('Missing/invalid face reference; upload a selfie or select a premade first');

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

  const uploadedImageUrl = await uploadOpenAIImageResult(imageResponse, `minime-${userId}-${Date.now()}`);

  const updated = await prisma.minime.update({
    where: { id: mm.id },
    data: { avatarUrl: uploadedImageUrl, isDraft: true, isSaved: false },
  });

  return updated;
};
