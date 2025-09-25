
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { OpenAI } = require('openai');
const uploadToS3 = require('../utils/s3Upload');


function mapGlasses(glassesKey) {
  if (!glassesKey || glassesKey === 'none') return null;

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

  return `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

# HARD CONSTRAINTS
- STRICT body shape reference: ${bodyShapeUrl}
- STRICT facial likeness: copy EXACTLY from this image → ${faceUrl}
  (match skin tone, hairstyle, eye shape, eyebrows, nose, lips, jawline; 
   do not "approximate", reproduce the same face features.)
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

${isFeminine ? `# ACCESSORIES
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
${noGlasses
  ? `- Do NOT include any kind of eyewear or eyewear artifacts.`
  : `- Do NOT ignore the glasses reference. If the reference color is yellow/red/etc., do NOT render black/gray frames.`}

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

      mm = await prisma.minime.create({
        data: saved
          ? {
              userId,
              shirt: saved.shirt,
              pant: saved.pant,
              shoes: saved.shoes,
              glasses: saved.glasses,
              lipstick: saved.lipstick,
              jewelry: saved.jewelry,
              bag: saved.bag,

              selfieUrl: saved.selfieUrl ?? null,
              isSaved: false,
              isDraft: true,
            }
          : { userId, isSaved: false, isDraft: true },
      });
    }
  }


  const faceReference =
    mm.selfieUrl                       
    || mm.avatarUrl                      
    || user.bodyShapeUrl;                 

  const isFeminine = user.bodyType === 'feminine';


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
    data: {
      avatarUrl: uploadedImageUrl, 
      isDraft: true,
      isSaved: false,
   
    },
  });

  return updated;
};
