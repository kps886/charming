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

export async function completePayment(filter, paymentId, signature) {
    const { order, fulfilled } = await mongoose.connection.transaction(async session => {
        const order = await Order.findOne(filter).session(session);
        if (!order) throw orderError(404, 'Order not found');
        if (order.paymentStatus !== 'pending') {
            if (order.razorpayPaymentId !== paymentId) throw orderError(409, 'Conflicting payment');
            return { order, fulfilled: false };
        }
        const expired = order.reservationExpiresAt && order.reservationExpiresAt <= new Date();
        if (expired || order.orderStatus === 'cancelled') {
            await releaseReservation(order, session);
            order.orderStatus = 'cancelled';
            order.cancelReason ||= 'Checkout expired';
        } else if (!order.reservationExpiresAt && !await claimLegacyStock(order, session)) {
            order.orderStatus = 'cancelled';
            order.cancelReason = 'Stock unavailable';
        } else {
            order.reservationExpiresAt = undefined;
            order.orderStatus = 'processing';
            if (order.promoCode) {
                await PromoCode.updateOne({ code: order.promoCode }, { $inc: { usedCount: 1 } }, { session });
            }
        }
        if (order.orderStatus === 'cancelled') order.cancelledAt ||= new Date();
        order.paymentStatus = 'paid';
        order.razorpayPaymentId = paymentId;
        if (signature) order.razorpaySignature = signature;
        order.paidAt = new Date();
        await order.save({ session });
        return { order, fulfilled: order.orderStatus === 'processing' };
    });

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
