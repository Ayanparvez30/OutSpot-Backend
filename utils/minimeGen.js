
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI } = require('openai');
const uploadToS3 = require('../utils/s3Upload');


const GLASSES_MAP = {
  none: null,
  'wayfarer-black': 'matte black wayfarer eyeglasses, medium-thick frame',
  'round-gold': 'thin round gold metal eyeglasses',
  'aviator-silver': 'thin silver aviator eyeglasses',
  'rectangle-black': 'rectangular full-rim black eyeglasses, slim frame',
};

function mapGlasses(glassesKey) {
  if (!glassesKey || glassesKey === 'none') return null;
  if (typeof glassesKey === 'string' && glassesKey.startsWith('http')) {
    if (glassesKey.includes('silver_square')) return 'sleek square silver metal eyeglasses, thin frame';
    if (glassesKey.includes('black_round'))   return 'round black eyeglasses, medium frame';
    if (glassesKey.includes('gold_round'))    return 'thin round golden eyeglasses';
    return 'modern stylish eyeglasses';
  }
  return GLASSES_MAP[glassesKey] || null;
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

function buildMinimePrompt({ bodyShapeUrl, faceUrl, isFeminine, outfit }) {
  const o = outfit || {};
  const noGlasses = !o.glasses;

  return `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

# HARD CONSTRAINTS
- STRICT body shape reference: ${bodyShapeUrl}
- STRICT facial likeness from: ${faceUrl}
- Camera: straight-on, full-body. Subject fully contained in frame.
- Keep ~10–12% empty space above the head and below the shoe soles.
- Both feet visible, standing on a flat plane. No cropping anywhere.
- Background: plain white (or transparent if API parameter is given).
- Lighting: soft, even, no harsh shadows.

# OUTFIT
- Shirt/top: ${o.shirt}
- Pants/bottom: ${o.pant}
- Shoes: ${o.shoes}
${noGlasses
  ? `- Glasses: none (bare face). REMOVE any eyewear present in the face reference.`
  : `- Glasses: ${o.glasses} (must be clearly visible and aligned with the eyes).`
}

# URL REFERENCE RULE
- If any outfit value above is an http/https URL, TREAT IT AS A STRICT VISUAL REFERENCE for color, material, pattern/texture, and silhouette. Recreate it closely without logos unless present in the URL image.

${isFeminine ? `# ADDITIONAL
- Lipstick: ${o.lipstick || 'natural'}
- Jewelry: ${o.jewelry || 'none'}
- Bag: ${o.bag || 'none'}` : ''}

# COMPOSITION & STYLE
- Neutral pose, arms relaxed by sides, single character only.
- Clean edges, smooth materials, vivid but realistic colors.
- Maintain the proportions of the provided body shape; do not exaggerate head size.
- No extra props, text, or background objects.

# NEGATIVE INSTRUCTIONS
- Do NOT crop hair or shoes.
- Do NOT turn the body away; keep front-facing.
${noGlasses ? `- Do NOT include any kind of eyewear or eyewear artifacts.` : ''}

Return a single, centered full-body render.
`.trim();
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