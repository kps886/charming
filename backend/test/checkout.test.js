import assert from 'node:assert/strict';
import { before, after, describe, it, mock } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Mailer from 'nodemailer/lib/mailer/index.js';
import { Writable } from 'node:stream';
import { AccountMail, retryAccountMail } from '../utils/accountMail.js';
import { reconcileDay, ReconciliationCase, runReconciliation, reconciliationStatus } from '../utils/reconciliation.js';
import Razorpay from 'razorpay';
import User from '../models/User.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import PromoCode from '../models/PromoCode.js';
import { deliverRestockAlerts } from '../utils/restockAlerts.js';
import { combineItems, expireReservations, reserveOrder } from '../utils/orderInventory.js';

it('combines duplicate product IDs and rejects invalid quantities', () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    assert.deepEqual(combineItems([{ product: id, quantity: 1 }, { product: id.toUpperCase(), quantity: 2 }]),
        [{ product: id, quantity: 3 }]);
    for (const quantity of [0, -1, 1.5, '2', null]) {
        assert.throws(() => combineItems([{ product: id, quantity }]), /quantity/);
    }
});

describe('account verification and checkout', { skip: !process.env.TEST_MONGO_URI && 'Set TEST_MONGO_URI to a disposable replica set' }, () => {
    let server, base, user, token;
    const remoteOrders = new Map();
    const payments = new Map();
    let loseCreateResponse = false;
    const address = { fullName: 'Test', phone: '123', line1: 'Test', city: 'Test', state: 'Test', pincode: '123456' };

    before(async () => {
        Object.assign(process.env, { JWT_SECRET: 'test-jwt', RAZORPAY_KEY_ID: 'test-key',
            RAZORPAY_KEY_SECRET: 'test-secret', RAZORPAY_WEBHOOK_SECRET: 'test-webhook' });
        mock.method(Mailer.prototype, 'sendMail', async () => ({}));
        mock.method(Razorpay.prototype, 'addResources', function () {
            this.orders = {
                all: async ({ receipt }) => ({ items: [...remoteOrders.values()].filter(o => o.receipt === receipt) }),
                create: async fields => {
                    const order = { id: randomUUID(), ...fields };
                    remoteOrders.set(order.id, order);
                    if (loseCreateResponse) { loseCreateResponse = false; throw new Error('Lost gateway response'); }
                    return order;
                },
            };
            this.payments = { fetch: async id => payments.get(id) };
        });
        await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: 'charming_test_' + randomUUID() });
        await Promise.all([Order.init(), Product.init(), User.init(), PromoCode.init()]);
        const { default: users } = await import('../routes/userRoutes.js');
        const { default: orders } = await import('../routes/orderRoutes.js');
        const app = express();
        app.use(express.json({ verify(req, res, buf) { req.rawBody = buf; } }));
        app.use('/users', users);
        app.use('/orders', orders);
        app.use('/cart', (await import('../routes/cartRoutes.js')).default);
        app.use('/promo', (await import('../routes/promoRoutes.js')).default);
        app.use('/products', (await import('../routes/productRoutes.js')).default);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = 'http://127.0.0.1:' + server.address().port;
        user = await User.create({ name: 'Buyer', email: 'buyer@example.test', password: 'test-password', isVerified: true });
        token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
    });
    after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
        mock.restoreAll();
    });

    function post(path, data, headers = {}) {
        return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json',
            authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify(data) });
    }
    function product(stock) {
        return Product.create({ name: 'Test product', description: 'Test', category: 'Fragrances', price: 100, stock });
    }
    function checkout(product, promoCode, attemptId = randomUUID()) {
        return post('/orders/create-payment', { attemptId, items: [{ product: product.id, quantity: 1 }], shippingAddress: address, promoCode });
    }
    function signature(data, key) {
        return createHmac('sha256', key).update(data).digest('hex');
    }
    function payment(order) {
        const paymentId = randomUUID();
        payments.set(paymentId, { id: paymentId, order_id: order.razorpayOrderId, currency: 'INR',
            amount: order.amount, status: 'captured', captured: true });
        return { orderId: order.orderId, razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: paymentId,
            razorpaySignature: signature(order.razorpayOrderId + '|' + paymentId, process.env.RAZORPAY_KEY_SECRET) };
    }
    function webhook(paid, timestamp = Math.floor(Date.now() / 1000)) {
        const data = { event: 'payment.captured', created_at: timestamp,
            payload: { payment: { entity: payments.get(paid.razorpayPaymentId) } } };
        return post('/orders/webhook', data, { 'x-razorpay-signature': signature(JSON.stringify(data), process.env.RAZORPAY_WEBHOOK_SECRET) });
    }

    async function staffHeaders(role = 'shopkeeper') {
        const staff = await User.create({ email: randomUUID() + '@example.test', name: 'Staff',
            password: 'test-password', role, isVerified: true });
        return { authorization: 'Bearer ' + jwt.sign({ id: staff.id }, process.env.JWT_SECRET),
            'content-type': 'application/json' };
    }

    it('pages inventory and counts the entire catalog after a staff stock edit', async () => {
        for (let i = 0; i < 13; i++) await product(1);
        const page = await (await fetch(base + '/products?page=2')).json();
        assert.equal(page.total, 13);
        assert.equal(page.products.length, 1);
        const headers = await staffHeaders('employee');
        const response = await fetch(base + '/products/' + page.products[0]._id, {
            method: 'PUT', headers, body: JSON.stringify({ stock: 0 }),
        });
        assert.equal(response.status, 200);
        const stats = await (await fetch(base + '/products/staff-summary', { headers })).json();
        assert.deepEqual(stats, { products: 13, lowStock: 12, outOfStock: 1 });
        const overview = await (await fetch(base + '/orders/staff-summary', { headers: await staffHeaders() })).json();
        assert.equal(overview.products, 13);
        assert.equal(overview.outOfStock, 1);
    });

    it('keeps pending reviews private and persists staff approval and ratings', async () => {
        const item = await product(1);
        const url = base + '/products/' + item.id;
        const submitted = await post('/products/' + item.id + '/reviews', { rating: 5, comment: 'Great' });
        assert.equal(submitted.status, 201);
        assert.deepEqual((await (await fetch(url)).json()).reviews, []);
        const headers = await staffHeaders();
        const queue = await (await fetch(base + '/products/staff-reviews', { headers })).json();
        const entry = queue.find(review => review.productId === item.id);
        assert.ok(entry);
        for (const isApproved of [true, true, false]) {
            const response = await fetch(url + '/reviews/' + entry._id + '/toggle', {
                method: 'PUT', headers, body: JSON.stringify({ isApproved }),
            });
            assert.equal(response.status, 200);
            const visible = await (await fetch(url)).json();
            assert.equal(visible.reviews.length, Number(isApproved));
            assert.equal(visible.avgRating, isApproved ? 5 : 0);
        }
    });

    it('lists captured cancellations and lets staff record a completed refund once', async () => {
        const item = await product(1);
        const order = await (await checkout(item)).json();
        await Order.updateOne({ _id: order.orderId }, { orderStatus: 'cancelled', paymentStatus: 'paid' });
        const headers = await staffHeaders();
        const queue = () => fetch(base + '/orders?status=needs-refund', { headers }).then(r => r.json());
        assert.ok((await queue()).orders.some(o => o._id === order.orderId));
        const record = h => fetch(base + '/orders/' + order.orderId + '/refund', {
            method: 'PUT', headers: h, body: JSON.stringify({ reference: 'rfnd_test' }),
        });
        assert.equal((await record(await staffHeaders('employee'))).status, 403);
        assert.equal((await record(headers)).status, 200);
        assert.equal((await record(headers)).status, 409);
        assert.ok(!(await queue()).orders.some(o => o._id === order.orderId));
        const my = await (await fetch(base + '/orders/my', { headers: { authorization: 'Bearer ' + token } })).json();
        assert.equal(my.find(o => o._id === order.orderId).refundReference, 'rfnd_test');
    });

    it('emails an opted-in buyer once for a staff restock, never for a released reservation', async () => {
        const item = await product(1);
        const order = await (await checkout(item)).json();
        const path = base + '/products/' + item.id;
        const headers = { authorization: 'Bearer ' + token };
        const optIn = () => fetch(path + '/restock-alert', { method: 'PUT', headers });
        const status = () => fetch(path + '/restock-alert', { headers }).then(r => r.json());
        assert.equal((await optIn()).status, 200);
        assert.equal((await optIn()).status, 200);
        assert.equal((await status()).subscribed, true);
        assert.equal((await fetch(path + '/restock-alert', { method: 'DELETE', headers })).status, 200);
        assert.equal((await status()).subscribed, false);
        await optIn();
        await Order.updateOne({ _id: order.orderId }, { reservationExpiresAt: new Date(0) });
        await expireReservations();
        const mail = Mailer.prototype.sendMail.mock;
        const before = mail.callCount();
        await deliverRestockAlerts();
        assert.equal(mail.callCount(), before);
        const staff = await staffHeaders('employee');
        const update = () => fetch(path, { method: 'PUT', headers: staff, body: JSON.stringify({ stock: 4 }) });
        assert.equal((await update()).status, 200);
        assert.equal((await update()).status, 200);
        await Promise.all([deliverRestockAlerts(), deliverRestockAlerts()]);
        await deliverRestockAlerts();
        assert.equal(mail.callCount(), before + 1);
        assert.equal(mail.calls.at(-1).arguments[0].to, user.email);
        assert.equal((await status()).subscribed, false);
    });

    it('restores the opt-in if stock sells out before email delivery', async () => {
        const item = await product(0);
        const url = base + '/products/' + item.id;
        const headers = { authorization: 'Bearer ' + token };
        const staff = await staffHeaders('employee');
        const restock = () => fetch(url, { method: 'PUT', headers: staff, body: JSON.stringify({ stock: 1 }) });
        await fetch(url + '/restock-alert', { method: 'PUT', headers });
        assert.equal((await restock()).status, 200);
        await checkout(item);
        const mail = Mailer.prototype.sendMail.mock;
        const before = mail.callCount();
        await deliverRestockAlerts();
        assert.equal(mail.callCount(), before);
        assert.equal((await (await fetch(url + '/restock-alert', { headers })).json()).subscribed, true);
        assert.equal((await restock()).status, 200);
        await fetch(url + '/restock-alert', { method: 'DELETE', headers });
        await deliverRestockAlerts();
        assert.equal(mail.callCount(), before);
    });

    it('requires an issued, unexpired OTP and consumes it once', async () => {
        const email = 'staff@example.test';
        const staff = await User.create({ email, name: 'Staff', role: 'admin', password: 'test-password' });
        const verify = otp => post('/users/verify-otp', { email, otp });
        assert.equal((await verify()).status, 400);
        assert.equal((await verify('123456')).status, 400);
        await User.updateOne({ _id: staff.id }, { otp: '123456', otpExpire: new Date(0) });
        assert.equal((await verify('123456')).status, 400);
        await User.updateOne({ _id: staff.id }, { otpExpire: new Date(Date.now() + 60000) });
        const results = await Promise.all([verify('123456'), verify('123456')]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    });

    it('rejects inactive accounts even with a valid OTP', async () => {
        const email = 'inactive@example.test';
        await User.create({ email, name: 'Inactive', password: 'test-password', isActive: false,
            otp: '654321', otpExpire: new Date(Date.now() + 60000) });
        const response = await post('/users/verify-otp', { email, otp: '654321' });
        assert.equal(response.status, 400);
        assert.equal((await User.findOne({ email })).isVerified, false);
    });

    it('creates staff who can log in without a missing OTP or account expiry', async () => {
        const admin = await User.create({ email: 'creator@example.test', name: 'Admin',
            password: 'test-password', role: 'admin', isVerified: true, unverifiedExpireAt: null });
        const email = 'new-staff@example.test';
        const response = await post('/users/create', { email, name: 'Employee',
            password: 'staff-password', role: 'employee' },
            { authorization: 'Bearer ' + jwt.sign({ id: admin.id }, process.env.JWT_SECRET) });
        assert.equal(response.status, 201);
        const staff = await User.findOne({ email });
        assert.equal(staff.isVerified, true);
        assert.equal(staff.unverifiedExpireAt, null);
        assert.equal((await post('/users/login', { email, password: 'staff-password' })).status, 200);
        assert.equal((await post('/users/verify-otp', { email })).status, 400);
    });

    it('allows only one checkout for the final unit', async () => {
        const item = await product(1);
        const results = await Promise.all([checkout(item), checkout(item)]);
        assert.equal(results.filter(r => r.status === 201).length, 1);
        assert.equal((await Product.findById(item.id)).stock, 0);
        assert.equal(await Order.countDocuments({ 'items.product': item.id }), 1);
    });

    it('checks capture, amount and currency before fulfilling a fractional-price order', async () => {
        const item = await product(2);
        item.price = 99.50;
        await item.save();
        const promo = await PromoCode.create({ code: 'PAISE', discountType: 'percent', discountValue: 5 });
        const order = await (await checkout(item, promo.code)).json();
        assert.equal(order.amount, 14452);
        assert.equal(order.total, 144.52);
        const stored = await Order.findById(order.orderId);
        assert.equal(stored.discountPaise, 498);
        assert.equal(stored.items[0].pricePaise, 9950);
        const paid = payment(order);
        const entity = payments.get(paid.razorpayPaymentId);
        const verify = () => post('/orders/verify-payment', paid);
        Object.assign(entity, { status: 'authorized', captured: false });
        assert.equal((await verify()).status, 202);
        assert.equal((await Order.findById(order.orderId)).paymentStatus, 'pending');
        Object.assign(entity, { status: 'captured', captured: true, amount: order.amount - 1 });
        assert.equal((await verify()).status, 409);
        entity.amount = order.amount;
        entity.currency = 'USD';
        assert.equal((await webhook(paid)).status, 409);
        assert.equal((await Order.findById(order.orderId)).orderStatus, 'pending');
        entity.currency = 'INR';
        assert.equal((await webhook(paid)).status, 200);
        assert.equal((await Order.findById(order.orderId)).paymentStatus, 'paid');
    });

    it('recovers a lost gateway response with the same receipt and reservation', async () => {
        const item = await product(1);
        const key = randomUUID();
        const before = remoteOrders.size;
        loseCreateResponse = true;
        assert.equal((await checkout(item, null, key)).status, 503);
        await Order.updateOne({ 'items.product': item.id }, { gatewayLeaseUntil: new Date(0) });
        const recovered = await (await checkout(item, null, key)).json();
        const retry = await (await checkout(item, null, key)).json();
        assert.ok(recovered.razorpayOrderId);
        assert.equal(retry.razorpayOrderId, recovered.razorpayOrderId);
        assert.equal(remoteOrders.size, before + 1);
        assert.equal(await Order.countDocuments({ 'items.product': item.id }), 1);
        assert.equal((await Product.findById(item.id)).stock, 0);
        assert.equal((await checkout(await product(1), null, key)).status, 409);
    });

    it('resumes legacy clients and repairs a rounded historical receipt on capture', async () => {
        const item = await product(3);
        const body = { items: [{ product: item.id, quantity: 1 }], shippingAddress: address };
        const first = await (await post('/orders/create-payment', body)).json();
        const retry = await (await post('/orders/create-payment', body)).json();
        assert.ok(first.razorpayOrderId);
        assert.equal(retry.razorpayOrderId, first.razorpayOrderId);
        const legacy = await Order.create({
            user: user.id, items: [{ product: item.id, name: item.name, price: 99.50, quantity: 1 }],
            shippingAddress: address, subtotal: 100, deliveryFee: 50, total: 150, razorpayOrderId: randomUUID(),
        });
        const paid = payment({ orderId: legacy.id, razorpayOrderId: legacy.razorpayOrderId, amount: 14950 });
        assert.equal((await webhook(paid)).status, 200);
        const stored = await Order.findById(legacy.id);
        assert.equal(stored.total, 149.50);
        assert.equal(stored.totalPaise, 14950);
    });

    it('shares one hold and gateway order across concurrent requests for one attempt', async () => {
        const item = await product(3);
        const key = randomUUID();
        const before = remoteOrders.size;
        const replies = await Promise.all([checkout(item, null, key), checkout(item, null, key)]);
        for (const reply of replies) assert.ok([201, 202].includes(reply.status));
        const again = await (await checkout(item, null, key)).json();
        assert.ok(again.razorpayOrderId);
        assert.equal(remoteOrders.size, before + 1);
        assert.equal((await Product.findById(item.id)).stock, 2);
    });

    it('reclaims released stock for a timely capture and flags unavailable stock for staff', async () => {
        for (const stockAvailable of [true, false]) {
            const item = await product(1);
            const order = await (await checkout(item)).json();
            const deadline = new Date(Date.now() - 2000);
            await Order.updateOne({ _id: order.orderId }, { reservationExpiresAt: deadline });
            await expireReservations();
            if (!stockAvailable) await checkout(item);
            const paid = payment(order);
            assert.equal((await post('/orders/verify-payment', paid)).status, 202);
            const capturedAt = Math.floor(deadline / 1000) - 1;
            assert.equal((await webhook(paid, capturedAt)).status, 200);
            assert.equal((await webhook(paid, capturedAt)).status, 200);
            const stored = await Order.findById(order.orderId);
            assert.equal(stored.orderStatus, stockAvailable ? 'processing' : 'cancelled');
            assert.equal(stored.paidAt.getTime(), capturedAt * 1000);
            assert.equal(Boolean(stored.captureReview), !stockAvailable);
            assert.equal((await Product.findById(item.id)).stock, 0);
        }
    });

    it('binds callbacks to the local order and buyer and fulfills once across both paths', async () => {
        const item = await product(4);
        const promo = await PromoCode.create({ code: 'TEST', discountType: 'flat', discountValue: 1 });
        const a = await (await checkout(item, promo.code)).json();
        const b = await (await checkout(item, promo.code)).json();
        const paid = payment(a);
        const verify = (data, headers) => post('/orders/verify-payment', data, headers);
        assert.equal((await verify({ ...paid, orderId: b.orderId })).status, 404);
        assert.equal((await verify({ ...paid, orderId: b.orderId, razorpayOrderId: b.razorpayOrderId })).status, 400);
        const other = await User.create({ email: 'other@example.test', name: 'Other', password: 'test-password' });
        assert.equal((await verify(paid, { authorization: 'Bearer ' + jwt.sign({ id: other.id }, process.env.JWT_SECRET) })).status, 404);
        assert.equal((await Order.findById(b.orderId)).paymentStatus, 'pending');
        assert.equal((await webhook(paid)).status, 200);
        assert.equal((await verify(paid)).status, 200);
        const second = payment(b);
        assert.equal((await verify(second)).status, 200);
        assert.equal((await webhook(second)).status, 200);
        assert.equal((await verify(second)).status, 200);
        assert.equal((await Product.findById(item.id)).stock, 2);
        assert.equal((await PromoCode.findById(promo.id)).usedCount, 2);
    });

    it('rolls back a failed payment transaction and accepts the webhook retry', async () => {
        const item = await product(2);
        const promo = await PromoCode.create({ code: 'RETRY', discountType: 'flat', discountValue: 1 });
        const order = await (await checkout(item, promo.code)).json();
        const paid = payment(order);
        const failure = mock.method(Order.prototype, 'save', async () => {
            throw new Error('Simulated database write failure');
        });
        try {
            assert.equal((await webhook(paid)).status, 500);
        } finally {
            failure.mock.restore();
        }
        assert.equal((await Order.findById(order.orderId)).paymentStatus, 'pending');
        assert.equal((await PromoCode.findById(promo.id)).usedCount, 0);
        assert.equal((await Product.findById(item.id)).stock, 1);
        assert.equal((await webhook(paid)).status, 200);
        assert.equal((await webhook(paid)).status, 200);
        assert.equal((await PromoCode.findById(promo.id)).usedCount, 1);
        assert.equal((await Product.findById(item.id)).stock, 1);
    });

    it('rejects forged webhooks without changing a pending order', async () => {
        const item = await product(2);
        const order = await (await checkout(item)).json();
        const response = await post('/orders/webhook', {
            event: 'payment.captured', payload: { payment: { entity: {
                order_id: order.razorpayOrderId, id: 'forged-payment',
            } } },
        }, { 'x-razorpay-signature': '0'.repeat(64) });
        assert.equal(response.status, 400);
        assert.equal((await Order.findById(order.orderId)).paymentStatus, 'pending');
    });

    it('rolls back all reservations when a later item is unavailable', async () => {
        const available = await product(2);
        const unavailable = await product(0);
        await assert.rejects(reserveOrder({
            user: user.id,
            items: [available, unavailable].map(item => ({ product: item.id,
                name: item.name, price: item.price, quantity: 1 })),
            shippingAddress: address, subtotal: 200, deliveryFee: 50, total: 250,
        }), /Insufficient stock/);
        assert.equal((await Product.findById(available.id)).stock, 2);
        assert.equal(await Order.countDocuments({ 'items.product': available.id }), 0);
    });

    it('rejects duplicate cart lines whose combined quantity exceeds stock', async () => {
        const item = await product(1);
        const response = await post('/orders/create-payment', { attemptId: randomUUID(), shippingAddress: address,
            items: [{ product: item.id, quantity: 1 }, { product: item.id, quantity: 1 }] });
        assert.equal(response.status, 409);
        assert.equal((await Product.findById(item.id)).stock, 1);
        assert.equal(await Order.countDocuments({ 'items.product': item.id }), 0);
    });

    it('releases stock on cancellation and keeps older unreserved orders payable', async () => {
        const item = await product(2);
        const order = await (await checkout(item)).json();
        const cancel = await fetch(base + '/orders/' + order.orderId + '/cancel', {
            method: 'PUT', headers: { authorization: 'Bearer ' + token },
        });
        assert.equal(cancel.status, 200);
        assert.equal((await Product.findById(item.id)).stock, 2);
        const legacy = await Order.create({
            user: user.id, items: [{ product: item.id, name: item.name, price: item.price, quantity: 2 }],
            shippingAddress: address, subtotal: 200, deliveryFee: 50, total: 250, razorpayOrderId: randomUUID(),
        });
        const paid = payment({ orderId: legacy.id, razorpayOrderId: legacy.razorpayOrderId, amount: 25000 });
        const results = await Promise.all([webhook(paid), post('/orders/verify-payment', paid)]);
        assert.deepEqual(results.map(r => r.status), [200, 200]);
        assert.equal((await Product.findById(item.id)).stock, 0);
        assert.equal((await Order.findById(legacy.id)).orderStatus, 'processing');
    });

    it('records a temporary mail failure and delivers the saved verification code on retry', async () => {
        const email = 'mail-retry@example.test';
        const mail = Mailer.prototype.sendMail.mock;
        mail.mockImplementationOnce(async () => { throw Object.assign(new Error('SMTP busy'), { responseCode: 451 }); });
        const response = await post('/users/register', { email, name: 'Retry', password: 'password-123' });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).requiresVerification, true);
        const buyer = await User.findOne({ email }).select('+otp');
        const job = await AccountMail.findById(buyer.id + ':verification').select('+payload');
        assert.equal(job.failure, '451');
        assert.equal(job.state, 'queued');
        assert.ok(!job.payload.includes(email));
        await AccountMail.updateOne({ _id: job.id }, { nextAttempt: new Date(0) });
        await retryAccountMail();
        const sent = mail.calls.at(-1).arguments[0];
        assert.equal(sent.to, email);
        assert.ok(sent.text.includes(buyer.otp));
        assert.equal((await AccountMail.findById(job.id)).state, 'sent');
        assert.equal((await post('/users/verify-otp', { email, otp: buyer.otp })).status, 200);
    });

    it('confirms a replacement email, notifies the old address and revokes stale sessions', async () => {
        const oldEmail = 'old-signin@example.test', email = 'new-signin@example.test';
        const account = await User.create({ email: oldEmail, name: 'Member', password: 'old-password', isVerified: true });
        let current = jwt.sign({ id: account.id }, process.env.JWT_SECRET);
        const headers = () => ({ authorization: 'Bearer ' + current, 'content-type': 'application/json' });
        const edit = body => fetch(base + '/users/profile', { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
        const profile = () => fetch(base + '/users/profile', { headers: headers() });
        const confirm = code => post('/users/profile/confirm-email', { code }, headers());
        assert.equal((await edit({ email })).status, 403);
        assert.equal((await edit({ password: 'new-password', currentPassword: 'incorrect' })).status, 403);
        const mail = Mailer.prototype.sendMail.mock;
        await post('/users/forgotpassword', { email: oldEmail });
        await retryAccountMail();
        const previousReset = mail.calls.at(-1).arguments[0].html.match(/reset-password\/([a-f0-9]{40})/)[1];
        const start = await edit({ email, currentPassword: 'old-password' });
        assert.equal(start.status, 200);
        assert.equal((await start.json()).email, oldEmail);
        const code = mail.calls.at(-1).arguments[0].text.split(' ').at(-1);
        assert.equal((await confirm('0000000000000000')).status, 400);
        const changed = await (await confirm(code)).json();
        assert.equal(changed.email, email);
        assert.equal((await profile()).status, 401);
        current = changed.token;
        const superseded = await fetch(base + '/users/resetpassword/' + previousReset, { method: 'PUT', headers: headers(),
            body: JSON.stringify({ password: 'superseded' }) });
        assert.equal(superseded.status, 400);
        assert.equal((await confirm(code)).status, 400);
        await retryAccountMail();
        assert.equal(mail.calls.at(-1).arguments[0].to, oldEmail);
        const rotated = await (await edit({ password: 'new-password', currentPassword: 'old-password' })).json();
        assert.equal((await profile()).status, 401);
        current = rotated.token;
        assert.equal((await profile()).status, 200);
        const recovery = await (await post('/users/forgotpassword', { email })).json();
        assert.deepEqual(await (await post('/users/forgotpassword', { email: 'absent@example.test' })).json(), recovery);
        await retryAccountMail();
        const resetToken = mail.calls.at(-1).arguments[0].html.match(/reset-password\/([a-f0-9]{40})/)[1];
        const reset = () => fetch(base + '/users/resetpassword/' + resetToken, { method: 'PUT', headers: headers(),
            body: JSON.stringify({ password: 'recovered-password' }) });
        assert.deepEqual((await Promise.all([reset(), reset()])).map(r => r.status).sort(), [200, 400]);
        assert.equal((await profile()).status, 401);
        assert.equal((await post('/users/login', { email, password: 'recovered-password' })).status, 200);
    });

    it('uploads, replaces, and deletes product assets using returned Cloudinary IDs', async t => {
        const { cloudinary, cleanImages } = await import('../middleware/uploadMiddleware.js');
        const deleted = [];
        const staging = process.env.TEST_CLOUDINARY_CLOUD_NAME;
        const original = { ...cloudinary.config() };
        if (staging) {
            assert.ok(process.env.TEST_CLOUDINARY_API_KEY && process.env.TEST_CLOUDINARY_API_SECRET, 'Staging Cloudinary credentials required');
            cloudinary.config({ cloud_name: staging, api_key: process.env.TEST_CLOUDINARY_API_KEY,
                api_secret: process.env.TEST_CLOUDINARY_API_SECRET });
            t.after(() => cloudinary.config(original));
        }
        let uploads = 0;
        if (!staging) t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
            assert.equal(options.folder, 'charming_products');
            return new Writable({ write(bytes, encoding, done) {
                const id = 'charming_products/asset.' + ++uploads;
                callback(null, { public_id: id, secure_url: 'https://example.test/' + id + '.png' });
                done();
            } });
        });
        const destroy = cloudinary.uploader.destroy.bind(cloudinary.uploader);
        t.mock.method(cloudinary.uploader, 'destroy', async (id, options) => {
            const result = staging ? await destroy(id, options) : { result: 'ok' };
            if (result.result === 'ok') deleted.push(id);
            return result;
        });
        const headers = await staffHeaders();
        delete headers['content-type'];
        function form(fields) {
            const data = new FormData();
            for (const [key, value] of Object.entries(fields)) data.set(key, value);
            data.set('images', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'sample.png');
            return data;
        }
        const create = await fetch(base + '/products', { method: 'POST', headers, body: form({
            name: 'Image test', description: 'Sample', category: 'Fragrances', price: '12.50' }) });
        assert.equal(create.status, 201);
        const item = await create.json();
        assert.equal(item.images[0], item.imageAssets[0].url);
        const path = base + '/products/' + item._id;
        const replace = await fetch(path, { method: 'PUT', headers, body: form({ existingImages: '[]' }) });
        assert.equal(replace.status, 200);
        const previous = item.imageAssets[0].publicId, replacement = (await replace.json()).imageAssets[0].publicId;
        assert.ok(previous.startsWith('charming_products/'));
        assert.ok(replacement.startsWith('charming_products/'));
        assert.notEqual(replacement, previous);
        await cleanImages();
        assert.deepEqual(deleted, [previous]);
        assert.equal((await fetch(path, { method: 'DELETE', headers })).status, 200);
        await cleanImages();
        assert.deepEqual(deleted, [previous, replacement]);
    });

    it('validates nested fields, IDs, literal search, money, quantities and pagination', async () => {
        const item = await product(1);
        const headers = await staffHeaders('admin');
        for (const path of ['/products?limit=-1', '/products?page=2.5', '/products?sort=bogus', '/products/invalid']) {
            assert.equal((await fetch(base + path)).status, 400);
        }
        const search = await fetch(base + '/products?search=' + encodeURIComponent('['));
        assert.equal(search.status, 200);
        assert.equal((await search.json()).total, 0);
        assert.equal((await post('/cart', { items: [{ product: item.id, qty: 0 }] })).status, 400);
        assert.equal((await post('/cart', { items: [{ product: item.id, qty: 1 }] })).status, 200);
        assert.equal((await post('/orders/create-payment', { items: [{ product: item.id, quantity: 1 }],
            shippingAddress: { ...address, unexpected: true } })).status, 400);
        assert.equal((await post('/promo', { code: 'X', discountType: 'flat', discountValue: 5, usedCount: 3 }, headers)).status, 400);
        assert.equal((await fetch(base + '/products/' + item.id, { method: 'PUT', headers, body: JSON.stringify({ price: 1.123 }) })).status, 400);
    });

    it('paginates reconciliation, retries incomplete days and retains discrepancies for staff resolution', async () => {
        const date = new Date('2020-01-05');
        const pageCalls = [];
        let reportsFail = true;
        const provider = {
            payments: { all: async ({ skip }) => {
                pageCalls.push(skip);
                return { items: skip ? [{ id: 'pay_orphan', order_id: 'order_unknown', status: 'captured', currency: 'INR', amount: 5900 }]
                    : Array.from({ length: 100 }, (_, i) => ({ id: 'failed' + i, status: 'failed' })) };
            } },
            refunds: { all: async () => ({ items: [{ id: 'rfnd_pending', payment_id: 'pay_orphan', amount: 5900, status: 'pending' }] }) },
            settlements: { reports: async () => {
                if (reportsFail) throw new Error('Report unavailable');
                return { items: [{ type: 'payment', entity_id: 'pay_orphan', amount: 5900, currency: 'INR', settled: true }] };
            } },
        };
        process.env.RECONCILIATION_START_DATE = date.toISOString().slice(0, 10);
        try {
            await assert.rejects(runReconciliation(provider), /Report unavailable/);
            assert.equal(+(await reconciliationStatus()).nextDay, +date);
            reportsFail = false;
            await runReconciliation(provider);
        } finally { delete process.env.RECONCILIATION_START_DATE; }
        assert.deepEqual(pageCalls, [0, 100, 0, 100]);
        assert.equal((await reconciliationStatus()).completedDay, '2020-01-05');
        assert.equal(await ReconciliationCase.countDocuments({ resolvedAt: null }), 3);
        const headers = await staffHeaders();
        const queue = base + '/orders/reconciliation';
        assert.equal((await fetch(queue, { headers: await staffHeaders('employee') })).status, 403);
        const listed = await (await fetch(queue, { headers })).json();
        assert.equal(listed.cases.length, 3);
        const response = await fetch(queue + '/' + encodeURIComponent(listed.cases[0]._id),
            { method: 'PUT', headers, body: JSON.stringify({ resolution: 'Verified against bank statement' }) });
        assert.equal(response.status, 200);
        await reconcileDay(provider, date);
        assert.equal(await ReconciliationCase.countDocuments({ resolvedAt: null }), 2);
    });

    it('rechecks authorizations from earlier days and compares gross settlement values', async () => {
        const order = await (await checkout(await product(1))).json();
        const paid = payment(order);
        const captured = payments.get(paid.razorpayPaymentId);
        const beforeCapture = { ...captured, status: 'authorized', captured: false };
        const dated = new Date('2023-07-01');
        const row = { type: 'payment', entity_id: captured.id, settled: true, amount: captured.amount,
            fee: 30, credit: captured.amount - 30, currency: 'INR' };
        const provider = {
            payments: { all: async () => ({ items: [beforeCapture] }), fetch: async () => captured },
            refunds: { all: async () => ({ items: [] }), fetch: async id => ({ id, payment_id: 'pay_orphan', status: 'pending' }) },
            settlements: { reports: async () => ({ items: [] }) },
        };
        await reconcileDay(provider, dated);
        provider.payments.all = async () => ({ items: [] });
        await reconcileDay(provider, new Date('2023-07-02'));
        const issue = await ReconciliationCase.findById('payment:' + captured.id);
        assert.match(issue.reason, /Capture without/);
        assert.equal((await webhook(paid)).status, 200);
        provider.payments.all = async () => ({ items: [captured] });
        provider.settlements.reports = async () => ({ items: [row] });
        await reconcileDay(provider, dated);
        assert.ok((await ReconciliationCase.findById(issue.id)).resolvedAt);
        assert.equal(await ReconciliationCase.findById('settlement:' + captured.id), null);
        row.amount += 10;
        await reconcileDay(provider, dated);
        assert.match((await ReconciliationCase.findById('settlement:' + captured.id)).reason, /amount or currency/);
    });

    it('keeps profile traffic independent of the authentication rate limit', async () => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = probe.address().port;
        await new Promise(resolve => probe.close(resolve));
        const child = spawn(process.execPath, ['server.js'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, PORT: String(port), MONGO_URI: process.env.TEST_MONGO_URI, RECONCILIATION_START_DATE: '2099-01-01' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = once(child, 'exit');
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        try {
            const origin = 'http://127.0.0.1:' + port;
            let ready = false;
            for (let attempt = 0; attempt < 50; attempt++) {
                try { ready = (await fetch(origin + '/api/health')).ok; } catch {}
                if (ready || child.exitCode !== null) break;
                await delay(100);
            }
            assert.ok(ready, output);
            const raw = '{\n  "event": "test.notification", "payload": {}\n}';
            const webhook = await fetch(origin + '/api/orders/webhook', { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature(raw, process.env.RAZORPAY_WEBHOOK_SECRET) },
                body: raw });
            assert.equal(webhook.status, 200);
            const invalid = await fetch(origin + '/api/users/forgotpassword', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: { invalid: true } }) });
            assert.equal(invalid.status, 400);
            const profile = () => fetch(origin + '/api/users/profile');
            const verify = () => fetch(origin + '/api/users/verify-otp', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: '{}' });
            for (let i = 0; i < 12; i++) assert.equal((await profile()).status, 401);
            // The invalid recovery request already used one of the ten shared auth attempts.
            for (let i = 1; i < 10; i++) assert.equal((await verify()).status, 400);
            assert.equal((await verify()).status, 429);
            assert.equal((await profile()).status, 401);
        } finally {
            child.kill();
            await exited;
        }
    });

    it('releases an expired hold once and records a late payment for refund', async () => {
        const item = await product(1);
        const order = await (await checkout(item)).json();
        await Order.updateOne({ _id: order.orderId }, { reservationExpiresAt: new Date(0) });
        await Promise.all([expireReservations(), expireReservations()]);
        const paid = payment(order);
        assert.equal((await webhook(paid)).status, 200);
        assert.equal((await post('/orders/verify-payment', paid)).status, 409);
        assert.equal((await Product.findById(item.id)).stock, 1);
        const stored = await Order.findById(order.orderId);
        assert.equal(stored.orderStatus, 'cancelled');
        assert.equal(stored.paymentStatus, 'paid');
    });
});
