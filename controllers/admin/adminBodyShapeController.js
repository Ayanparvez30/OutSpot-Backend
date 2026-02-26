const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const sharp = require('sharp');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const uploadToS3 = require('../../utils/s3Upload');

const s3 = new S3Client({ region: process.env.AWS_REGION });

const VALID_GENDERS = ['masculine', 'feminine'];
const VALID_HEIGHTS = ['S', 'M', 'L'];
const VALID_WEIGHTS = [1, 2, 3, 4];

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

async function compressAndUpload(file) {
  const originalKB = (file.buffer.length / 1024).toFixed(0);
  const compressed = await sharp(file.buffer)
    .resize(768, 1152, { fit: 'inside', withoutEnlargement: true })
    .sharpen({ sigma: 0.5 })
    .webp({ quality: 85, alphaQuality: 95, effort: 6, smartSubsample: true })
    .toBuffer();
  const compressedKB = (compressed.length / 1024).toFixed(0);
  console.log(`[BODY-SHAPE] Compressed: ${originalKB} KB -> ${compressedKB} KB (webp)`);

  return uploadToS3({
    originalname: file.originalname.replace(/\.[^.]+$/, '.webp'),
    buffer: compressed,
    mimetype: 'image/webp',
  }, 'body-shapes');
}

exports.list = async (req, res) => {
  try {
    const items = await prisma.bodyShape.findMany({
      orderBy: [{ gender: 'asc' }, { weight: 'asc' }, { height: 'asc' }],
    });
    res.render('admin/pages/bodyShapes/index', {
      layout: 'admin/layouts/main',
      title: 'Body Shapes',
      items,
    });
  } catch (err) {
    console.error('List body shapes error:', err);
    req.flash('error', 'Failed to load body shapes');
    res.redirect('/admin/dashboard');
  }
};

exports.createForm = (req, res) => {
  res.render('admin/pages/bodyShapes/form', {
    layout: 'admin/layouts/main',
    title: 'Add Body Shape',
    item: null,
  });
};

exports.create = async (req, res) => {
  try {
    const { gender, height, weight } = req.body;
    const w = parseInt(weight);

    if (!VALID_GENDERS.includes(gender) || !VALID_HEIGHTS.includes(height) || !VALID_WEIGHTS.includes(w)) {
      req.flash('error', 'Invalid gender, height, or weight value');
      return res.redirect('/admin/body-shapes/create');
    }

    let imageUrl = '';
    if (req.file) {
      imageUrl = await compressAndUpload(req.file);
    }

    if (!imageUrl) {
      req.flash('error', 'Image is required');
      return res.redirect('/admin/body-shapes/create');
    }

    await prisma.bodyShape.create({
      data: { gender, height, weight: w, imageUrl },
    });

    req.flash('success', `Body shape ${gender.charAt(0).toUpperCase()}${w}${height} created`);
    res.redirect('/admin/body-shapes');
  } catch (err) {
    console.error('Create body shape error:', err);
    if (err.code === 'P2002') {
      req.flash('error', 'This gender + height + weight combination already exists');
    } else {
      req.flash('error', 'Failed to create body shape');
    }
    res.redirect('/admin/body-shapes/create');
  }
};

exports.editForm = async (req, res) => {
  try {
    const item = await prisma.bodyShape.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!item) {
      req.flash('error', 'Not found');
      return res.redirect('/admin/body-shapes');
    }
    res.render('admin/pages/bodyShapes/form', {
      layout: 'admin/layouts/main',
      title: 'Edit Body Shape',
      item,
    });
  } catch (err) {
    console.error('Edit body shape form error:', err);
    req.flash('error', 'Failed to load body shape');
    res.redirect('/admin/body-shapes');
  }
};

exports.update = async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { gender, height, weight, isActive } = req.body;
    const w = parseInt(weight);

    if (!VALID_GENDERS.includes(gender) || !VALID_HEIGHTS.includes(height) || !VALID_WEIGHTS.includes(w)) {
      req.flash('error', 'Invalid gender, height, or weight value');
      return res.redirect(`/admin/body-shapes/${id}/edit`);
    }

    const data = {
      gender,
      height,
      weight: w,
      isActive: isActive === 'on',
    };

    if (req.file) {
      const existing = await prisma.bodyShape.findUnique({ where: { id }, select: { imageUrl: true } });
      if (existing?.imageUrl) await deleteFromS3(existing.imageUrl);
      data.imageUrl = await compressAndUpload(req.file);
    }

    await prisma.bodyShape.update({ where: { id }, data });

    req.flash('success', 'Body shape updated');
    res.redirect('/admin/body-shapes');
  } catch (err) {
    console.error('Update body shape error:', err);
    if (err.code === 'P2002') {
      req.flash('error', 'This gender + height + weight combination already exists');
    } else {
      req.flash('error', 'Failed to update body shape');
    }
    res.redirect(`/admin/body-shapes/${id}/edit`);
  }
};

exports.delete = async (req, res) => {
  try {
    const item = await prisma.bodyShape.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { imageUrl: true },
    });
    if (item?.imageUrl) await deleteFromS3(item.imageUrl);

    await prisma.bodyShape.delete({
      where: { id: parseInt(req.params.id) },
    });
    req.flash('success', 'Body shape deleted');
  } catch (err) {
    console.error('Delete body shape error:', err);
    req.flash('error', 'Failed to delete body shape');
  }
  res.redirect('/admin/body-shapes');
};
