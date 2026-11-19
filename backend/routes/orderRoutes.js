import { paise, discountPaise } from '../utils/money.js';
import express from 'express';
import mongoose from 'mongoose';
import { combineItems, reserveOrder, completePayment, releaseReservation, orderError } from '../utils/orderInventory.js';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import PromoCode from '../models/PromoCode.js';
import { protect, employeeAndAbove, shopkeeperAndAbove } from '../middleware/authMiddleware.js';
import User from '../models/User.js';
import { sendStatusUpdate } from '../utils/emailService.js';
import { ReconciliationCase, reconciliationStatus } from '../utils/reconciliation.js';
import { schema, validate, validateIds } from '../middleware/validation.js';
const router = express.Router();
validateIds(router, ["id"]);

export const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────
// STEP A  →  Create Razorpay order
//            Frontend hits this before showing the payment button.
//            Returns a razorpayOrderId the frontend passes to Razorpay SDK.
// POST /api/orders/create-payment
// ─────────────────────────────────────────────
async function prepareOrder(id, fingerprint, items, address, code, user, legacyAttemptKey) {
    const verified = [];
    let subtotal = 0;
    for (const item of items) {
        const product = await Product.findById(item.product);
        if (!product) throw orderError(404, 'Product no longer available');
        const price = product.pricePaise ?? paise(product.price);
        subtotal += price * item.quantity;
        if (!Number.isSafeInteger(subtotal) || subtotal > Number.MAX_SAFE_INTEGER - 5000) throw orderError(400, 'Order amount too large');
        verified.push({ product: product._id, name: product.name, image: product.images?.[0],
            quantity: item.quantity, pricePaise: price, price: price / 100 });
    }
    const delivery = paise(Order.calcDeliveryFee(subtotal / 100));
    let discount = 0;
    if (code) {
        const promo = await PromoCode.findOne({ code });
        if (!promo?.isActive || (promo.expiresAt && promo.expiresAt < new Date())
            || (promo.usageLimit != null && promo.usedCount >= promo.usageLimit)
            || subtotal < paise(promo.minOrderValue)) throw orderError(400, 'Promo code unavailable for this order');
        discount = discountPaise(promo, subtotal);
    }
    const total = Math.max(subtotal + delivery - discount, 100);
    return reserveOrder({ _id: id, legacyAttemptKey, checkoutFingerprint: fingerprint, user, shippingAddress: address, items: verified,
        promoCode: code, subtotalPaise: subtotal, discountPaise: discount, deliveryFeePaise: delivery, totalPaise: total,
        subtotal: subtotal / 100, discount: discount / 100, promoDiscount: discount / 100,
        deliveryFee: delivery / 100, total: total / 100 });
}

async function attachGatewayOrder(order) {
    // The stable receipt lets a retry recover a successful external write whose response was lost.
    const now = new Date();
    const lease = new Date(Date.now() + 30000);
    const claimed = await Order.findOneAndUpdate({ _id: order._id, razorpayOrderId: null,
        orderStatus: 'pending', reservationExpiresAt: { $gt: now },
        $or: [{ gatewayLeaseUntil: null }, { gatewayLeaseUntil: { $lte: now } }] },
        { $set: { gatewayLeaseUntil: lease } }).select('+gatewayLeaseUntil');
    if (!claimed) return Order.findById(order._id);
    const receipt = order.id;
    let remote;
    if (claimed.gatewayLeaseUntil) {
        const found = await razorpay.orders.all({ receipt });
        remote = found.items.find(item => item.receipt === receipt);
    }
    remote ||= await razorpay.orders.create({ amount: order.totalPaise, currency: 'INR', receipt });
    if (!remote.id || remote.amount !== order.totalPaise || remote.currency !== 'INR') {
        throw orderError(502, 'Gateway order does not match this checkout');
    }
    const updated = await Order.findOneAndUpdate({ _id: order._id, gatewayLeaseUntil: lease },
        { $set: { razorpayOrderId: remote.id }, $unset: { gatewayLeaseUntil: 1 } }, { returnDocument: 'after' });
    return updated || Order.findById(order._id);
}

router.post('/create-payment', protect, validate(schema.checkout), async (req, res) => {
    try {
        const { shippingAddress, promoCode, attemptId } = req.body;
        if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(attemptId))) {
            throw orderError(400, 'Refresh checkout to start a payment attempt');
        }
        const items = combineItems(req.body.items).sort((a, b) => a.product.localeCompare(b.product));
        const address = {};
        for (const field of ['fullName', 'phone', 'line1', 'line2', 'city', 'state', 'pincode', 'country']) {
            const value = shippingAddress?.[field] ?? (field === 'country' ? 'India' : '');
            if (typeof value !== 'string' || (!value.trim() && field !== 'line2')) throw orderError(400, 'Incomplete shipping address');
            address[field] = value.trim();
        }
        const code = promoCode?.trim().toUpperCase() || null;
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const fingerprint = hash(JSON.stringify([items, address, code]));
        let key = attemptId;
        if (key === undefined) {
            // Older storefronts can still resume the same active basket.
            const previous = await Order.findOne({ user: req.user._id, legacyAttemptKey: { $exists: true }, checkoutFingerprint: fingerprint })
                .sort({ createdAt: -1 }).select('+legacyAttemptKey');
            const active = previous?.orderStatus === 'pending' && previous.paymentStatus === 'pending'
                && previous.reservationExpiresAt > new Date();
            key = active ? previous.legacyAttemptKey : 'legacy:' + fingerprint + ':' + (previous?.id || 'first');
        }
        const id = hash(req.user.id + '/' + key).slice(0, 24);
        let order = await Order.findById(id).select('+checkoutFingerprint');
        if (!order) {
            try {
                order = await prepareOrder(id, fingerprint, items, address, code, req.user._id, attemptId === undefined ? key : undefined);
            } catch (err) {
                order = await Order.findById(id).select('+checkoutFingerprint');
                if (!order) throw err;
            }
        }
        if (order.checkoutFingerprint !== fingerprint) throw orderError(409, 'Checkout details changed for this attempt');
        if (order.paymentStatus === 'pending' && order.orderStatus === 'pending' && !order.razorpayOrderId) {
            order = await attachGatewayOrder(order);
        }
        if (order.paymentStatus !== 'pending' || order.captureReview || (order.authorizedPaymentId && order.orderStatus === 'pending')) {
            return res.json({ orderId: id, showStatus: true, paymentStatus: order.paymentStatus });
        }
        if (order.orderStatus !== 'pending' || order.reservationExpiresAt <= new Date()) {
            return res.status(409).json({ message: 'This checkout expired or was cancelled. Start a new checkout.', restart: true });
        }
        if (!order.razorpayOrderId) return res.status(attemptId ? 202 : 409).json({ orderId: id, preparing: true, message: 'Checkout is being prepared. Retry shortly.' });
        res.status(201).json({ orderId: id, razorpayOrderId: order.razorpayOrderId,
            checkoutTimeoutSeconds: Math.max(1, Math.floor((order.reservationExpiresAt - Date.now()) / 1000)),
            amount: order.totalPaise, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID,
            subtotal: order.subtotal, deliveryFee: order.deliveryFee, discount: order.discount, total: order.total });
    } catch (err) {
        if (!err.status) console.error('Checkout preparation failed', err.message || err.error?.description);
        res.status(err.status || 503).json({ message: err.status ? err.message : 'Payment setup interrupted. Retry this checkout.' });
    }
});

// ─────────────────────────────────────────────
// STEP B  →  Verify payment after Razorpay callback
//            Frontend sends the three IDs Razorpay returns.
//            We verify the signature — this is the security step.
// POST /api/orders/verify-payment
// ─────────────────────────────────────────────
router.post('/verify-payment', protect, validate(schema.verifyPayment), async (req, res) => {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    try {
        if (!mongoose.isObjectIdOrHexString(orderId) || typeof razorpayOrderId !== 'string'
            || typeof razorpayPaymentId !== 'string' || !razorpayPaymentId) {
            return res.status(400).json({ message: 'Invalid payment identifiers' });
        }
        const filter = { _id: orderId, user: req.user._id, razorpayOrderId };
        const stored = await Order.findOne(filter).select('razorpayOrderId');
        if (!stored) return res.status(404).json({ message: 'Order not found' });
        const body = stored.razorpayOrderId + '|' + razorpayPaymentId;
        if (!validSignature(body, razorpaySignature, process.env.RAZORPAY_KEY_SECRET)) {
            return res.status(400).json({ message: 'Invalid payment signature' });
        }
        const payment = await razorpay.payments.fetch(razorpayPaymentId);
        if (payment.id !== razorpayPaymentId) throw orderError(409, 'Payment identifier mismatch');
        const order = await completePayment(filter, payment, razorpaySignature);
        if (order.paymentStatus === 'pending') return res.status(202).json({ orderId: order.id, paymentStatus: 'pending' });
        if (order.orderStatus === 'cancelled') {
            return res.status(409).json({ message: 'Payment received for a cancelled order. Contact support for a refund.' });
        }
        res.json({ message: 'Payment verified', orderId: order._id, orderStatus: order.orderStatus });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ message: err.status ? err.message : 'Error verifying payment' });
    }
});

// ─────────────────────────────────────────────
// GET /api/orders/my  →  current user's orders
// ─────────────────────────────────────────────
router.get('/my', protect, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .populate('items.product', 'name images');
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

// ─────────────────────────────────────────────
// GET /api/orders/:id  →  single order (owner or staff)
// ─────────────────────────────────────────────
router.get('/staff-summary', protect, shopkeeperAndAbove, async (req, res) => {
    const [products, orders, pending, outOfStock, reviews] = await Promise.all([
        Product.countDocuments(), Order.countDocuments(), Order.countDocuments({ orderStatus: 'pending' }),
        Product.countDocuments({ stock: 0 }),
        Product.aggregate([{ $unwind: '$reviews' }, { $match: { 'reviews.isApproved': { $ne: true } } }, { $count: 'count' }]),
    ]);
    res.json({ products, orders, pending, outOfStock, pendingReviews: reviews[0]?.count || 0 });
});

router.get('/reconciliation', protect, shopkeeperAndAbove, validate({ page: schema.pagination.page }, 'query'), async (req, res) => {
    const page = Number(req.query.page || 1);
    const open = { resolvedAt: null };
    const [cases, total, status] = await Promise.all([
        ReconciliationCase.find(open).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * 25).limit(25),
        ReconciliationCase.countDocuments(open), reconciliationStatus(),
    ]);
    res.json({ cases, total, status });
});

router.put('/reconciliation/:caseId', protect, shopkeeperAndAbove, validate(schema.resolution), async (req, res) => {
    const note = req.body?.resolution;
    if (typeof note !== 'string' || !note.trim() || note.length > 500) return res.status(400).json({ message: 'Enter a resolution (up to 500 characters)' });
    const result = await ReconciliationCase.updateOne({ _id: req.params.caseId, resolvedAt: null },
        { resolvedAt: new Date(), resolvedBy: req.user._id, resolution: note.trim() });
    res.status(result.modifiedCount ? 200 : 409).json({ message: result.modifiedCount ? 'Resolution recorded' : 'Case is no longer open' });
});

router.get('/:id', protect, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id).populate('items.product', 'name images');
        if (!order) return res.status(404).json({ message: 'Order not found' });

        const isOwner = order.user.toString() === req.user._id.toString();
        const isStaff = ['admin', 'shopkeeper', 'employee'].includes(req.user.role);
        if (!isOwner && !isStaff) return res.status(403).json({ message: 'Not authorized' });

        res.json(order);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching order' });
    }
});

// @desc    Get all orders (staff only)
// @route   GET /api/orders
// @access  Private/Employee+
router.get('/', protect, employeeAndAbove, validate(schema.orders, 'query'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        
        // Allow backend filtering by status so pagination math stays accurate
        const filter = {};
        if (req.query.status === 'payment-review') {
            filter.captureReview = { $type: 'string' };
        } else if (req.query.status === 'needs-refund') {
            Object.assign(filter, { orderStatus: 'cancelled', paymentStatus: 'paid' });
        } else if (req.query.status && req.query.status !== 'all') {
            filter.orderStatus = req.query.status;
        }

        const [orders, total] = await Promise.all([
            Order.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('user', 'name email')
                .populate('items.product', 'name'),
            Order.countDocuments(filter)
        ]);

        res.json({ orders, page, pages: Math.ceil(total / limit), total });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

// ─────────────────────────────────────────────
// PUT /api/orders/:id/status  →  update order status
// ─────────────────────────────────────────────
router.put('/:id/refund', protect, shopkeeperAndAbove, validate(schema.refund), async (req, res) => {
    const reference = req.body?.reference;
    if (typeof reference !== 'string' || !reference.trim() || reference.trim().length > 100) {
        return res.status(400).json({ message: 'Enter the completed refund reference (up to 100 characters)' });
    }
    const order = await Order.findOneAndUpdate(
        { _id: req.params.id, orderStatus: 'cancelled', paymentStatus: 'paid' },
        { $set: { paymentStatus: 'refunded', refundReference: reference.trim(), refundedAt: new Date(), refundedBy: req.user._id }, $unset: { captureReview: 1 } },
        { returnDocument: 'after' }
    );
    if (!order) return res.status(409).json({ message: 'This order has no outstanding refund' });
    res.json(order);
});

router.put('/:id/status', protect, employeeAndAbove, validate(schema.status), async (req, res) => {
    const { orderStatus, trackingNumber } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

    if (!validStatuses.includes(orderStatus)) {
        return res.status(400).json({ message: 'Invalid status' });
    }

    try {
        const order = await mongoose.connection.transaction(async session => {
            const order = await Order.findById(req.params.id).session(session);
            if (!order) throw orderError(404, 'Order not found');
            if (order.orderStatus === 'cancelled' && orderStatus !== 'cancelled') {
                throw orderError(409, 'A cancelled order cannot be reopened');
            }
            if (order.paymentStatus !== 'paid' && !['pending', 'cancelled'].includes(orderStatus)) {
                throw orderError(409, 'Payment required before fulfillment');
            }
            order.orderStatus = orderStatus;
            if (trackingNumber) order.trackingNumber = trackingNumber;
            if (orderStatus === 'delivered') order.deliveredAt = new Date();
            if (orderStatus === 'cancelled') {
                await releaseReservation(order, session);
                order.cancelledAt = new Date();
                order.cancelReason = req.body.cancelReason || null;
            }
            return order.save({ session });
        });
        const buyer = await User.findById(order.user).select('name email');
        if (buyer) {
            await sendStatusUpdate(order, buyer.email, buyer.name).catch(() => console.error('Order status email failed', order.id));
        }
        res.json(order);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.status ? err.message : 'Error updating order status' });
    }
});

// @desc    Cancel an order (User initiated)
// @route   PUT /api/orders/:id/cancel
// @access  Private
router.put('/:id/cancel', protect, async (req, res) => {
    try {
        const order = await mongoose.connection.transaction(async session => {
            const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).session(session);
            if (!order) throw orderError(404, 'Order not found');
            if (order.orderStatus !== 'pending' || order.paymentStatus !== 'pending') {
                throw orderError(409, 'Only pending orders can be cancelled');
            }
            await releaseReservation(order, session);
            order.orderStatus = 'cancelled';
            order.cancelledAt = new Date();
            return order.save({ session });
        });
        res.json({ message: 'Order cancelled successfully', order });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.status ? error.message : 'Server error cancelling order' });
    }
});

// ─────────────────────────────────────────────
// POST /api/orders/webhook  →  Razorpay Server-to-Server Fallback
// ─────────────────────────────────────────────
function validSignature(body, signature, secret) {
    if (!secret || !body || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

router.post('/webhook', async (req, res) => {
    if (!validSignature(req.rawBody, req.headers['x-razorpay-signature'], process.env.RAZORPAY_WEBHOOK_SECRET)) {
        return res.status(400).json({ message: 'Invalid webhook signature' });
    }
    if (['payment.authorized', 'payment.captured', 'order.paid'].includes(req.body.event)) {
        const payment = req.body.payload?.payment?.entity;
        if (typeof payment?.order_id !== 'string' || typeof payment.id !== 'string') {
            return res.status(400).json({ message: 'Missing payment identifiers' });
        }
        try {
            const captured = req.body.event === 'payment.captured';
            const timestamp = req.body.created_at;
            const captureTime = captured && Number.isSafeInteger(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : null;
            await completePayment({ razorpayOrderId: payment.order_id }, payment, null, captureTime);
        } catch (err) {
            console.error('Webhook processing failed:', err.message);
            return res.status(err.status || 500).json({ message: 'Could not record payment' });
        }
    }
    res.json({ status: 'ok' });
});

export default router;
