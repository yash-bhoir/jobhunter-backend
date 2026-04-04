const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const uploadResume = (buffer, userId) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder:        `jobhunter/resumes/${userId}`,
        resource_type: 'raw',
        format:        'pdf',
        type:          'upload',      // explicit public upload type
        access_mode:   'public',      // ensure CDN delivery works without signing
      },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });

const deleteFile = (publicId) =>
  cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });

module.exports = { cloudinary, uploadResume, deleteFile };