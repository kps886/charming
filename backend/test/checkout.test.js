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
    const address = { fullName: 'Test', phone: '123', line1: 'Test', city: 'Test', state: 'Test', pincode: '123456' };

    before(async () => {
        Object.assign(process.env, { JWT_SECRET: 'test-jwt', RAZORPAY_KEY_ID: 'test-key',
            RAZORPAY_KEY_SECRET: 'test-secret', RAZORPAY_WEBHOOK_SECRET: 'test-webhook' });
        mock.method(Mailer.prototype, 'sendMail', async () => ({}));
        mock.method(Razorpay.prototype, 'addResources', function () {
            this.orders = { create: async ({ amount }) => ({ id: randomUUID(), amount }) };
        });
        await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: 'charming_test_' + randomUUID() });
        await Promise.all([Order.init(), Product.init(), User.init(), PromoCode.init()]);
        const { default: users } = await import('../routes/userRoutes.js');
        const { default: orders } = await import('../routes/orderRoutes.js');
        const app = express();
        app.use(express.json({ verify(req, res, buf) { req.rawBody = buf; } }));
        app.use('/users', users);
        app.use('/orders', orders);
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
    function checkout(product, promoCode) {
        return post('/orders/create-payment', { items: [{ product: product.id, quantity: 1 }], shippingAddress: address, promoCode });
    }
    function signature(data, key) {
        return createHmac('sha256', key).update(data).digest('hex');
    }
    function payment(order) {
        const paymentId = randomUUID();
        return { orderId: order.orderId, razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: paymentId,
            razorpaySignature: signature(order.razorpayOrderId + '|' + paymentId, process.env.RAZORPAY_KEY_SECRET) };
    }
    function webhook(paid) {
        const data = { event: 'payment.captured', payload: { payment: { entity: {
            order_id: paid.razorpayOrderId, id: paid.razorpayPaymentId } } } };
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
        const response = await post('/orders/create-payment', { shippingAddress: address,
            items: [{ product: item.id, quantity: 1 }, { product: item.id, quantity: 1 }] });
        assert.equal(response.status, 400);
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
        const paid = payment({ orderId: legacy.id, razorpayOrderId: legacy.razorpayOrderId });
        const results = await Promise.all([webhook(paid), post('/orders/verify-payment', paid)]);
        assert.deepEqual(results.map(r => r.status), [200, 200]);
        assert.equal((await Product.findById(item.id)).stock, 0);
        assert.equal((await Order.findById(legacy.id)).orderStatus, 'processing');
    });

    it('keeps profile traffic independent of the authentication rate limit', async () => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = probe.address().port;
        await new Promise(resolve => probe.close(resolve));
        const child = spawn(process.execPath, ['server.js'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, PORT: String(port), MONGO_URI: process.env.TEST_MONGO_URI },
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
            const profile = () => fetch(origin + '/api/users/profile');
            const verify = () => fetch(origin + '/api/users/verify-otp', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: '{}' });
            for (let i = 0; i < 12; i++) assert.equal((await profile()).status, 401);
            for (let i = 0; i < 10; i++) assert.equal((await verify()).status, 400);
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
