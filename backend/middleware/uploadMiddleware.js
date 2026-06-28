import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import pkg from 'multer-storage-cloudinary';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const StorageEngine = pkg.CloudinaryStorage || pkg.default?.CloudinaryStorage || pkg.default || pkg;

const storage = new StorageEngine({
    cloudinary: cloudinary,
    params: {
        folder: 'charming_products',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    }
});

const upload = multer({ storage });

export { cloudinary };
export default upload;