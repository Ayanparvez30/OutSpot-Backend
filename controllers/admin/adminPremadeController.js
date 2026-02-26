const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const sharp = require('sharp');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const uploadToS3 = require('../../utils/s3Upload');

const s3 = new S3Client({ region: process.env.AWS_REGION });

function extractS3Key(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
  } catch { return null; }
}

async function deleteFromS3(imageUrl) {
  const key = extractS3Key(imageUrl);
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    console.log(`[S3] Deleted: ${key}`);
  } catch (err) {
    console.error(`[S3] Failed to delete ${key}:`, err.message);
  }
}

async function compressAndUpload(file, folder) {
  const originalKB = (file.buffer.length / 1024).toFixed(0);
  const compressed = await sharp(file.buffer)
    .resize(768, 1152, { fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 0.5 })
    .webp({ quality: 85, alphaQuality: 95, effort: 6, smartSubsample: true })
    .toBuffer();
  const compressedKB = (compressed.length / 1024).toFixed(0);
  console.log(`[PREMADE] Compressed: ${originalKB} KB → ${compressedKB} KB (webp)`);

  return uploadToS3({
    originalname: file.originalname.replace(/\.[^.]+$/, '.webp'),
    buffer: compressed,
    mimetype: 'image/webp',
  }, folder);
}

exports.list = async (req, res) => {
  try {
    const items = await prisma.premadeAvatar.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    res.render('admin/pages/premades/index', {
      layout: 'admin/layouts/main',
      title: 'Premade Avatars',
      items,
    });
  } catch (err) {
    console.error('List premades error:', err);
    req.flash('error', 'Failed to load premades');
    res.redirect('/admin/dashboard');
  }
};

exports.createForm = (req, res) => {
  res.render('admin/pages/premades/form', {
    layout: 'admin/layouts/main',
    title: 'Add Premade Avatar',
    item: null,
  });
};

exports.create = async (req, res) => {
  try {
    const { label, gender, sortOrder } = req.body;

    let imageUrl = '';
    if (req.file) {
      imageUrl = await compressAndUpload(req.file, 'premades');
    }

    if (!imageUrl) {
      req.flash('error', 'Image is required');
      return res.redirect('/admin/premades/create');
    }

    await prisma.premadeAvatar.create({
      data: {
        label: label || 'Untitled',
        gender: gender || 'male',
        imageUrl,
        sortOrder: parseInt(sortOrder) || 0,
      },
    });

    req.flash('success', 'Premade avatar created');
    res.redirect('/admin/premades');
  } catch (err) {
    console.error('Create premade error:', err);
    req.flash('error', 'Failed to create premade');
    res.redirect('/admin/premades/create');
  }
};

exports.editForm = async (req, res) => {
  try {
    const item = await prisma.premadeAvatar.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!item) {
      req.flash('error', 'Not found');
      return res.redirect('/admin/premades');
    }
    res.render('admin/pages/premades/form', {
      layout: 'admin/layouts/main',
      title: 'Edit Premade Avatar',
      item,
    });
  } catch (err) {
    console.error('Edit premade form error:', err);
    req.flash('error', 'Failed to load premade');
    res.redirect('/admin/premades');
  }
};

exports.update = async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { label, gender, sortOrder, isActive } = req.body;

    const data = {
      label: label || 'Untitled',
      gender: gender || 'male',
      sortOrder: parseInt(sortOrder) || 0,
      isActive: isActive === 'on',
    };

    if (req.file) {
      // Delete old image from S3 before replacing
      const existing = await prisma.premadeAvatar.findUnique({ where: { id }, select: { imageUrl: true } });
      if (existing?.imageUrl) await deleteFromS3(existing.imageUrl);

      data.imageUrl = await compressAndUpload(req.file, 'premades');
    }

    await prisma.premadeAvatar.update({ where: { id }, data });

    req.flash('success', 'Premade avatar updated');
    res.redirect('/admin/premades');
  } catch (err) {
    console.error('Update premade error:', err);
    req.flash('error', 'Failed to update premade');
    res.redirect(`/admin/premades/${id}/edit`);
  }
};

exports.delete = async (req, res) => {
  try {
    const item = await prisma.premadeAvatar.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { imageUrl: true },
    });
    if (item?.imageUrl) await deleteFromS3(item.imageUrl);

    await prisma.premadeAvatar.delete({
      where: { id: parseInt(req.params.id) },
    });
    req.flash('success', 'Premade avatar deleted');
  } catch (err) {
    console.error('Delete premade error:', err);
    req.flash('error', 'Failed to delete premade');
  }
  res.redirect('/admin/premades');
};
