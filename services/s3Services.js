const AWS = require('aws-sdk');

// Configure AWS SDK
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const generateUploadUrl = async (fileName, folder) => {
    const proc_fileName = fileName.replace(/\s/g, '_');
    const mimeTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      html: 'text/html',
      // Add other formats as needed
    };
    
    const getContentTypeFromFileName = (_fileName) => {
      const ext = _fileName.split('.').pop().toLowerCase();
      return mimeTypes[ext] || 'application/octet-stream'; // Fallback if unknown
    };
  
    const params = {
      Bucket: process.env.S3_BUCKET_NAME, 
      Key: `${folder}/${proc_fileName}`, // Folder + File Name
      Expires: 60 * 5, // URL expires in 5 minutes
      ContentType: getContentTypeFromFileName(proc_fileName), // Adjust this for different file types
    };
  
    return s3.getSignedUrlPromise('putObject', params);
  };
  
  const generateReadUrl = async (fileName, folder) => {
    const proc_fileName = fileName.replace(/\+/g, ' ');
    console.log(proc_fileName);
    const params = {
      Bucket: 'tailorjd-articles', // Replace with your bucket name
      Key: `${folder}/${proc_fileName}`,
      Expires: 60 * 5, // URL expires in 5 minutes
    };
  
    return s3.getSignedUrlPromise('getObject', params);
  };
  
  const deleteFile = async (fileName, folder) => {
    const params = {
      Bucket: 'tailorjd-articles',
      Key: `${folder}/${fileName}`,
    };
  
    return s3.deleteObject(params).promise();
  };

module.exports = { generateUploadUrl, generateReadUrl, deleteFile };