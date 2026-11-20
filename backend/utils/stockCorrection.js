import mongoose from 'mongoose';
import { queueRestockAlerts } from './restockAlerts.js';

const StockCorrection = mongoose.model('StockCorrection', new mongoose.Schema({
    product: mongoose.Schema.Types.ObjectId, staff: mongoose.Schema.Types.ObjectId,
    before: Number, after: Number, reason: String,
}, { timestamps: true }));

export async function correctStock(product, fields, staff, session) {
    const before = product.stock, after = Number(fields.stock);
    if (fields.expectedStock == null || !fields.reason?.trim()) {
        throw Object.assign(new Error('Supply the original stock count and a correction reason'), { status: 400 });
    }
    if (before !== Number(fields.expectedStock)) {
        throw Object.assign(new Error('Stock changed. Refresh the product and check the current count.'), { status: 409 });
    }
    if (before === after) return;
    product.stock = after;
    await StockCorrection.create([{ product: product._id, staff, before, after, reason: fields.reason.trim() }], { session });
    if (after > before) await queueRestockAlerts(product, session);
}
