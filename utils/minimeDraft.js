
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.getOrCreateDraft = async (userId) => {

  let draft = await prisma.minime.findFirst({
    where: { userId, isDraft: true, isSaved: false },
    orderBy: { createdAt: 'desc' },
  });
  if (draft) return draft;

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


  draft = await prisma.minime.create({
    data: { userId, ...base, isSaved: false, isDraft: true },
  });
  return draft;
};
