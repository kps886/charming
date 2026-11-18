import express from 'express';
import mongoose from 'mongoose';
import { combineItems, reserveOrder, completePayment, releaseReservation, orderError } from '../utils/orderInventory.js';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import PromoCode from '../models/PromoCode.js';
import { protect, employeeAndAbove } from '../middleware/authMiddleware.js';
import User from '../models/User.js';
import { sendStatusUpdate } from '../utils/emailService.js';
const router = express.Router();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────
// STEP A  →  Create Razorpay order
//            Frontend hits this before showing the payment button.
//            Returns a razorpayOrderId the frontend passes to Razorpay SDK.
// POST /api/orders/create-payment
// ─────────────────────────────────────────────
router.post('/create-payment', protect, async (req, res) => {
    const { items, shippingAddress, promoCode } = req.body;

    if (!shippingAddress) {
        return res.status(400).json({ message: 'Shipping address is required' });
    }

    try {
        // 1. Verify each product and compute subtotal from DB prices (never trust frontend prices)
        let subtotal = 0;
        const verifiedItems = [];

        for (const item of combineItems(items)) {
            const product = await Product.findById(item.product);
            if (!product) {
                return res.status(404).json({ message: `Product ${item.product} not found` });
            }
            if (product.stock < item.quantity) {
                return res.status(400).json({ message: `Insufficient stock for "${product.name}"` });
            }
            subtotal += product.price * item.quantity;
            verifiedItems.push({
                product: product._id,
                name: product.name,
                image: product.images?.[0] || '',
                price: product.price,
                quantity: item.quantity,
            });
        }

        // 2. Delivery fee
        const deliveryFee = Order.calcDeliveryFee(subtotal);

        // 3. Promo code (optional)
        let discount = 0;
        let appliedPromo = null;

        if (promoCode) {
            const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() });

            if (!promo) return res.status(400).json({ message: 'Invalid promo code' });
            if (!promo.isActive) return res.status(400).json({ message: 'This promo code is no longer active' });
            if (promo.expiresAt && promo.expiresAt < new Date()) return res.status(400).json({ message: 'This promo code has expired' });
            if (promo.usageLimit && promo.usedCount >= promo.usageLimit) return res.status(400).json({ message: 'Promo code usage limit reached' });
            if (subtotal < promo.minOrderValue) return res.status(400).json({ message: `Minimum order value ₹${promo.minOrderValue} required for this code` });

            discount = Math.round(promo.calcDiscount(subtotal));
            appliedPromo = promo.code;
        }

        // 4. Final total (never let total go below 1 rupee)
        const total = Math.max(subtotal + deliveryFee - discount, 1);

        // 5. Create Razorpay order (amount in paise)
        const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(total * 100),
            currency: 'INR',
            receipt: crypto.randomUUID(),
        });

        // 6. Save order to DB in 'pending' state
        const order = await reserveOrder({
            user: req.user._id,
            items: verifiedItems,
            shippingAddress,
            subtotal: Math.round(subtotal),
            deliveryFee,
            discount,
            total: Math.round(total),
            promoCode: appliedPromo,
            promoDiscount: discount,
            razorpayOrderId: razorpayOrder.id,
            paymentStatus: 'pending',
            orderStatus: 'pending',
        });

        res.status(201).json({
            orderId: order._id,
            razorpayOrderId: razorpayOrder.id,
            checkoutTimeoutSeconds: Math.max(1, Math.floor((order.reservationExpiresAt.getTime() - Date.now()) / 1000)),
            amount: razorpayOrder.amount,   // in paise
            currency: 'INR',
            keyId: process.env.RAZORPAY_KEY_ID,
            // Summary for the checkout page
            subtotal,
            deliveryFee,
            discount,
            total: Math.round(total),
        });
    } catch (err) {
        if (!err.status) console.error(err);
        res.status(err.status || 500).json({ message: err.status ? err.message : 'Error creating payment order' });
    }
});

// ─────────────────────────────────────────────
// STEP B  →  Verify payment after Razorpay callback
//            Frontend sends the three IDs Razorpay returns.
//            We verify the signature — this is the security step.
// POST /api/orders/verify-payment
// ─────────────────────────────────────────────
router.post('/verify-payment', protect, async (req, res) => {
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
        const order = await completePayment(filter, razorpayPaymentId, razorpaySignature);
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
router.get('/', protect, employeeAndAbove, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        
        // Allow backend filtering by status so pagination math stays accurate
        const filter = req.query.status && req.query.status !== 'all' 
            ? { orderStatus: req.query.status } 
            : {};

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
router.put('/:id/status', protect, employeeAndAbove, async (req, res) => {
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
            await sendStatusUpdate(order, buyer.email, buyer.name);
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
    if (['payment.captured', 'order.paid'].includes(req.body.event)) {
        const payment = req.body.payload?.payment?.entity;
        if (typeof payment?.order_id !== 'string' || typeof payment.id !== 'string') {
            return res.status(400).json({ message: 'Missing payment identifiers' });
        }
        try {
            await completePayment({ razorpayOrderId: payment.order_id }, payment.id);
        } catch (err) {
            console.error('Webhook processing failed:', err.message);
            return res.status(err.status || 500).json({ message: 'Could not record payment' });
        }
    }
    res.json({ status: 'ok' });
});

export default router;
