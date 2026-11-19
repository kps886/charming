import { expectedPaise, paise } from './money.js';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import PromoCode from '../models/PromoCode.js';
import User from '../models/User.js';
import { sendLowStockAlert, sendOrderConfirmation } from './emailService.js';

export function orderError(status, message) {
    return Object.assign(new Error(message), { status });
}

export function combineItems(items) {
    if (!Array.isArray(items) || !items.length) throw orderError(400, 'No items in order');
    const quantities = new Map();
    for (const item of items) {
        if (typeof item?.product !== 'string' || !mongoose.isObjectIdOrHexString(item.product)
            || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
            throw orderError(400, 'Each item needs a valid product and a positive whole quantity');
        }
        const id = item.product.toLowerCase();
        const quantity = (quantities.get(id) || 0) + item.quantity;
        if (!Number.isSafeInteger(quantity)) throw orderError(400, 'Quantity too large');
        quantities.set(id, quantity);
    }
    return Array.from(quantities, ([product, quantity]) => ({ product, quantity }));
}

export async function reserveOrder(fields) {
    return mongoose.connection.transaction(async session => {
        if (fields._id) {
            const existing = await Order.findById(fields._id).select('+checkoutFingerprint').session(session);
            if (existing) return existing;
        }
        for (const item of fields.items) {
            const result = await Product.updateOne(
                { _id: item.product, stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity } }, { session }
            );
            if (!result.modifiedCount) throw orderError(409, 'Insufficient stock for ' + item.name);
        }
        const [order] = await Order.create([{
            ...fields, reservationExpiresAt: new Date(Date.now() + 15 * 60000),
        }], { session });
        return order;
    });
}

export async function releaseReservation(order, session) {
    if (!order.reservationExpiresAt) return;
    for (const item of order.items) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
    }
    order.reservationExpiresAt = undefined;
}

export async function expireReservations() {
    const due = { reservationExpiresAt: { $lte: new Date() }, paymentStatus: 'pending' };
    for await (const entry of Order.find(due).select('_id').lean().cursor()) {
        await mongoose.connection.transaction(async session => {
            const order = await Order.findOne({ ...due, _id: entry._id }).session(session);
            if (!order) return;
            order.holdExpiredAt = order.reservationExpiresAt;
            await releaseReservation(order, session);
            order.orderStatus = 'cancelled';
            order.cancelReason = 'Checkout expired';
            order.cancelledAt = new Date();
            await order.save({ session });
        });
    }
}

// Older pending orders predate reservations. Check every item before deducting any.
async function claimLegacyStock(order, session) {
    const quantities = new Map();
    for (const item of order.items) {
        const id = String(item.product);
        quantities.set(id, (quantities.get(id) || 0) + item.quantity);
    }
    for (const [id, quantity] of quantities) {
        if (!await Product.exists({ _id: id, stock: { $gte: quantity } }).session(session)) return false;
    }
    for (const [id, quantity] of quantities) {
        await Product.updateOne({ _id: id }, { $inc: { stock: -quantity } }, { session });
    }
    return true;
}

export async function completePayment(filter, payment, signature, captureTime) {
    const { order, fulfilled, mismatch } = await mongoose.connection.transaction(async session => {
        const order = await Order.findOne(filter).session(session);
        if (!order) throw orderError(404, 'Order not found');
        const paymentId = payment.id;
        if (!paymentId || payment.order_id !== order.razorpayOrderId) throw orderError(409, 'Payment order mismatch');
        if (payment.currency !== 'INR' || !Number.isSafeInteger(payment.amount) || payment.amount !== expectedPaise(order)) {
            if (order.paymentStatus === 'pending' && payment.status === 'captured' && payment.captured === true) {
                order.captureReview = 'Gateway capture amount or currency mismatch';
                order.razorpayPaymentId = paymentId;
                await order.save({ session });
            }
            return { order, mismatch: true };
        }
        if (order.paymentStatus !== 'pending') {
            if (order.razorpayPaymentId !== paymentId) throw orderError(409, 'Conflicting payment');
            return { order, fulfilled: false };
        }
        if (payment.status === 'authorized') {
            order.authorizedPaymentId = paymentId;
            await order.save({ session });
            return { order, fulfilled: false };
        }
        if (payment.status !== 'captured' || payment.captured !== true) throw orderError(409, 'Payment has not been captured');

        // Use the verified provider amount for receipts issued on an old, rounded checkout.
        if (order.totalPaise == null) {
            order.totalPaise = payment.amount;
            order.total = payment.amount / 100;
            order.subtotalPaise = paise(order.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
            order.subtotal = order.subtotalPaise / 100;
            order.deliveryFeePaise = paise(order.deliveryFee);
            order.discountPaise = paise(order.discount);
            for (const item of order.items) item.pricePaise = paise(item.price);
        }

        const deadline = order.reservationExpiresAt || order.holdExpiredAt;
        const expired = deadline && deadline <= new Date();
        const manualCancel = order.orderStatus === 'cancelled' && !order.holdExpiredAt;
        // A payment's created_at is its initiation time. Only the signed capture event dates capture.
        if (expired && !captureTime && !manualCancel) {
            order.captureReview = 'Captured payment awaiting provider capture time';
            order.razorpayPaymentId = paymentId;
            await order.save({ session });
            return { order, fulfilled: false };
        }
        const late = expired && captureTime >= deadline;
        order.captureReview = undefined;
        if (late || manualCancel) {
            await releaseReservation(order, session);
            order.orderStatus = 'cancelled';
            order.cancelReason ||= 'Checkout expired';
            order.captureReview = 'Captured payment on cancelled order: review refund';
        } else if (!order.reservationExpiresAt && !await claimLegacyStock(order, session)) {
            order.orderStatus = 'cancelled';
            order.cancelReason = 'Stock unavailable';
            order.captureReview = 'Captured payment without available stock: review refund';
        } else {
            order.reservationExpiresAt = undefined;
            order.orderStatus = 'processing';
            order.cancelReason = null;
            order.cancelledAt = null;
            if (order.promoCode) {
                await PromoCode.updateOne({ code: order.promoCode }, { $inc: { usedCount: 1 } }, { session });
            }
        }
        if (order.orderStatus === 'cancelled') order.cancelledAt ||= new Date();
        order.paymentStatus = 'paid';
        order.razorpayPaymentId = paymentId;
        if (signature) order.razorpaySignature = signature;
        order.paidAt = captureTime || new Date();
        await order.save({ session });
        return { order, fulfilled: order.orderStatus === 'processing' };
    });

    if (mismatch) throw orderError(409, 'Payment details do not match the order');
    if (fulfilled) {
        try {
            const buyer = await User.findById(order.user).select('name email');
            if (buyer) await sendOrderConfirmation(order, buyer.email, buyer.name);
            const depleted = await Product.find({ _id: { $in: order.items.map(i => i.product) }, stock: { $lte: 0 } });
            if (depleted.length) {
                const staff = await User.find({ role: { $in: ['shopkeeper', 'admin'] } }).distinct('email');
                for (const product of depleted) if (staff.length) await sendLowStockAlert(product, staff);
            }
        } catch (err) {
            console.error('Paid order notification failed:', order._id, err.message);
        }
    }
    return order;
}
