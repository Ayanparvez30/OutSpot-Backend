// scripts/seedChallenges.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// --- DAILY (varied requiredPhotos up to 5, varied points) ---
const daily = [
  { title: 'Morning Meals',   description: 'Take a picture of your breakfast.',                         requiredPhotos: 1, points: 8  },
  { title: 'Green Spot',      description: 'Snap a plant or tree near you.',                            requiredPhotos: 1, points: 8  },
  { title: 'Hydration Check', description: 'Photo check-ins for your water bottle (e.g., morning/afternoon/evening).', requiredPhotos: 3, points: 15 },
  { title: 'Study Time',      description: 'Show your study/work desk setup (before & after).',         requiredPhotos: 2, points: 12 },
  { title: 'Steps Count',     description: 'Capture your walking route (start & end).',                 requiredPhotos: 2, points: 12 },
  { title: 'Book Break',      description: 'Picture(s) of a book you’re reading (cover or page).',     requiredPhotos: 1, points: 8  },
  { title: 'Clean Space',     description: 'Before/after photo of tidied area.',                        requiredPhotos: 2, points: 14 },
  { title: 'Healthy Snack',   description: 'Photo of a fruit/healthy snack.',                           requiredPhotos: 1, points: 8  },
  { title: 'Sky Watch',       description: 'Snap today’s sky from where you are.',                      requiredPhotos: 1, points: 8  },
  { title: 'Water Source',    description: 'Show a safe water point near you (two angles/points).',     requiredPhotos: 2, points: 12 },
  { title: 'Handwash Time',   description: 'Show proper handwash setup.',                               requiredPhotos: 1, points: 8  },
  { title: 'Move 10',         description: 'Share short activity moments (e.g., warm-up / mid / end).', requiredPhotos: 3, points: 15 },
  { title: 'Refill & Reuse',  description: 'Reusable bottle/mug in action (refill + usage).',           requiredPhotos: 2, points: 12 },
  { title: 'Community Smile', description: 'A candid smiling moment.',                                  requiredPhotos: 1, points: 8  },
  { title: 'Grateful One',    description: 'Five things you’re thankful for—capture each.',             requiredPhotos: 5, points: 25 },
];

// --- WEEKLY (unchanged from before) ---
const weekly = [
  { title: 'Walk 5 Days',        description: 'Log a walk on 5 different days this week.', requiredPhotos: 5, points: 50 },
  { title: 'Home Garden',        description: 'Share 3 updates of a plant’s growth.',      requiredPhotos: 3, points: 50 },
  { title: 'Reading Streak',     description: 'Post 4 reading sessions this week.',        requiredPhotos: 4, points: 50 },
  { title: 'Water Diary',        description: 'Upload 7 hydration check-ins.',             requiredPhotos: 7, points: 70 },
  { title: 'Clean Drive',        description: 'Post 3 cleanup moments.',                   requiredPhotos: 3, points: 50 },
  { title: 'Active Week',        description: 'Share 4 exercise moments.',                 requiredPhotos: 4, points: 50 },
  { title: 'Healthy Kitchen',    description: 'Share 3 healthy meals.',                    requiredPhotos: 3, points: 50 },
  { title: 'Explore Nature',     description: 'Post 3 outdoor scenes.',                    requiredPhotos: 3, points: 50 },
  { title: 'Skill Practice',     description: 'Show 3 moments practicing a skill.',        requiredPhotos: 3, points: 50 },
  { title: 'Mindful Week',       description: 'Share 4 calm/mindful moments.',             requiredPhotos: 4, points: 50 },
  { title: 'Neighborhood Water', description: 'Show 3 different safe water points.',       requiredPhotos: 3, points: 60 },
  { title: 'Waste Less',         description: 'Share 3 reuse/recycle acts.',               requiredPhotos: 3, points: 50 },
  { title: 'Community Care',     description: 'Share 2 acts of help.',                     requiredPhotos: 2, points: 40 },
  { title: 'Early Riser',        description: 'Upload 5 early-morning shots.',             requiredPhotos: 5, points: 60 },
  { title: 'Local Food',         description: 'Show 3 local/seasonal foods.',              requiredPhotos: 3, points: 50 },
];

// --- Upsert helper: exists হলে update, না থাকলে create ---
async function ensureChallengeUpsert(data) {
  const existing = await prisma.challenge.findFirst({
    where: { title: data.title, frequency: data.frequency },
  });

  if (!existing) {
    await prisma.challenge.create({ data });
    return { created: 1, updated: 0 };
  }

  // কোনো ফিল্ড বদলালে তবেই update করবো
  const needsUpdate =
    existing.description !== data.description ||
    existing.points !== data.points ||
    existing.tier !== data.tier ||
    existing.requiredPhotos !== data.requiredPhotos ||
    existing.type !== (data.type ?? null);

  if (needsUpdate) {
    await prisma.challenge.update({
      where: { id: existing.id },
      data,
    });
    return { created: 0, updated: 1 };
  }

  return { created: 0, updated: 0 };
}

async function seed() {
  try {
    let createdDaily = 0, updatedDaily = 0;
    for (const d of daily) {
      const res = await ensureChallengeUpsert({
        title: d.title,
        description: d.description,
        frequency: 'DAILY',
        tier: 'SILVER',
        points: d.points,
        requiredPhotos: d.requiredPhotos,
      });
      createdDaily += res.created;
      updatedDaily += res.updated;
    }

    let createdWeekly = 0, updatedWeekly = 0;
    for (const w of weekly) {
      const res = await ensureChallengeUpsert({
        title: w.title,
        description: w.description,
        frequency: 'WEEKLY',
        tier: 'GOLD',
        points: w.points,
        requiredPhotos: w.requiredPhotos,
      });
      createdWeekly += res.created;
      updatedWeekly += res.updated;
    }

    const [dailyCount, weeklyCount, total] = await Promise.all([
      prisma.challenge.count({ where: { frequency: 'DAILY' } }),
      prisma.challenge.count({ where: { frequency: 'WEEKLY' } }),
      prisma.challenge.count(),
    ]);

    console.log('✅ Seed complete.');
    console.log(`   DAILY  → created: ${createdDaily}, updated: ${updatedDaily}, total in DB: ${dailyCount}`);
    console.log(`   WEEKLY → created: ${createdWeekly}, updated: ${updatedWeekly}, total in DB: ${weeklyCount}`);
    console.log(`   TOTAL  → ${total}`);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

seed();
