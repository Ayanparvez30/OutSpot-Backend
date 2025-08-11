const AWS = require('aws-sdk');
const multer = require('multer');
const path = require('path');

// Set up AWS SDK
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const s3 = new AWS.S3();

// Configure multer to handle image uploads
const storage = multer.memoryStorage(); // Use memory storage
const upload = multer({ storage }).single('image'); // 'image' is the field name for image uploads

// Function to upload image to S3
const uploadImageToS3 = async (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return res.status(500).send({ message: 'Error uploading file', error: err });
    }

    const file = req.file;
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `uploads/${Date.now()}-${file.originalname}`, // S3 file name
      Body: file.buffer,
      ContentType: file.mimetype
      // Remove the ACL line if your bucket restricts it
    };

    s3.upload(params, (err, data) => {
      if (err) {
        return res.status(500).send({ message: 'Error uploading to S3', error: err });
      }
      res.status(200).send({
        message: 'File uploaded successfully',
        fileUrl: data.Location // S3 URL of the uploaded file
      });
    });
  });
};

module.exports = { uploadImageToS3 };
