import mongoose from 'mongoose';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { sendRestockEmail } from './emailService.js';

const alertSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, required: true },
    nextAttempt: { type: Date, default: Date.now, index: true },
});
alertSchema.index({ product: 1, user: 1 }, { unique: true });
export const RestockAlert = mongoose.model('RestockAlert', alertSchema);

export async function queueRestockAlerts(product, session) {
    const recipients = product.restockSubscribers || [];
    if (!recipients.length) return;
    await RestockAlert.bulkWrite(recipients.map(user => ({
        updateOne: { filter: { user, product: product._id },
            update: { $setOnInsert: { nextAttempt: new Date() } }, upsert: true },
    })), { session });
    product.restockSubscribers = undefined;
}

export async function deliverRestockAlerts() {
    while (true) {
        const alert = await RestockAlert.findOneAndUpdate(
            { nextAttempt: { $lte: new Date() } },
            { $set: { nextAttempt: new Date(Date.now() + 10 * 60000) } },
            { sort: { nextAttempt: 1 }, returnDocument: 'after' }
        );
        if (!alert) return;
        try {
            const [user, product] = await Promise.all([
                User.findById(alert.user).select('email isActive'), Product.findById(alert.product).select('name stock'),
            ]);
            if (user?.isActive && product) {
                if (product.stock <= 0) {
                    // Keep the opt-in for the next staff restock if this shipment sold out.
                    await mongoose.connection.transaction(async session => {
                        const restored = await Product.updateOne({ _id: product._id, stock: { $lte: 0 } },
                            { $addToSet: { restockSubscribers: user._id } }, { session });
                        if (restored.matchedCount) await RestockAlert.deleteOne({ _id: alert._id }, { session });
                    });
                    continue;
                }
                await sendRestockEmail(user.email, product);
            }
            await RestockAlert.deleteOne({ _id: alert._id });
        } catch (err) {
            console.error('Restock email delivery failed:', alert._id, err.message);
        }
    }
}
