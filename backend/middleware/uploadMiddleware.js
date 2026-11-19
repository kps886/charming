import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const folder = 'charming_products';
const Deletion = mongoose.model('ImageDeletion', new mongoose.Schema({ _id: String }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 8, fieldSize: 16384 },
    fileFilter(req, file, done) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return done(new Error('Use a JPEG, PNG or WebP image'));
        done(null, true);
    },
});

export async function queueImageDeletion(ids, session) {
    if (ids.length) await Deletion.bulkWrite(ids.map(_id => ({ updateOne: { filter: { _id },
        update: { $setOnInsert: { _id } }, upsert: true } })), { session });
}

export async function cleanImages() {
    for await (const job of Deletion.find().cursor()) {
        try {
            const result = await cloudinary.uploader.destroy(job.id, { invalidate: true });
            if (['ok', 'not found'].includes(result?.result)) await Deletion.deleteOne({ _id: job.id });
        } catch { console.error('Product image deletion will be retried'); }
    }
}

export function storedAssets(product) {
    const assets = new Map(product.imageAssets.map(a => [a.url, a.publicId]));
    for (const url of product.images) {
        if (assets.has(url)) continue;
        // Older products only stored the original delivery URL.
        try {
            const parsed = new URL(url);
            const prefix = '/' + process.env.CLOUDINARY_CLOUD_NAME + '/image/upload/';
            if (parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.startsWith(prefix)) continue;
            const match = parsed.pathname.slice(prefix.length).match(/^(?:v\d+\/)?(charming_products\/[\w.-]+)\.(?:jpe?g|png|webp)$/i);
            if (match) assets.set(url, match[1]);
        } catch { /* External and non-Cloudinary legacy URLs have no managed asset. */ }
    }
    return assets;
}

export async function uploadImages(files, assets) {
    for (const file of files || []) {
        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({ folder, allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
                resource_type: 'image' }, (error, uploaded) => error ? reject(error) : resolve(uploaded));
            stream.on('error', reject);
            stream.end(file.buffer);
        });
        if (!result?.public_id?.startsWith(folder + '/')) throw new Error('Invalid image public ID');
        assets.push({ publicId: result.public_id, url: result.secure_url });
        if (typeof result.secure_url !== 'string' || new URL(result.secure_url).protocol !== 'https:') throw new Error('Invalid image delivery URL');
    }
}

export { cloudinary };
export default upload;