import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { expectedPaise } from './money.js';

const DAY = 86400000;
export const ReconciliationCase = mongoose.model('ReconciliationCase', new mongoose.Schema({
    _id: String, reason: String, order: mongoose.Schema.Types.ObjectId, reference: String,
    expected: Number, actual: Number, currency: String, day: String, resolvedAt: Date,
    resolvedBy: mongoose.Schema.Types.ObjectId, resolution: String,
}, { timestamps: true }));
const Checkpoint = mongoose.model('ReconciliationCheckpoint', new mongoose.Schema({
    _id: String, nextDay: Date, lease: Date, completedDay: String, lastError: String,
}));
const PendingCapture = mongoose.model('PendingCapture', new mongoose.Schema({ _id: String }));

async function* entries(list, filters) {
    for (let skip = 0; ; skip += 100) {
        const { items } = await list({ ...filters, skip, count: 100 });
        if (!Array.isArray(items)) throw new Error('Incomplete reconciliation report');
        yield* items;
        if (items.length < 100) return;
    }
}

// Cases survive subsequent days. An identical finding keeps its existing staff resolution.
async function compare(source, reference, day, order, reason, actual, currency) {
    const _id = source + ':' + reference;
    if (!reason) {
        await ReconciliationCase.updateOne({ _id, resolvedAt: null }, { resolvedAt: new Date(), resolution: 'Matched on recheck' });
        return;
    }
    const facts = { reason, order: order?._id ?? null, actual: actual ?? null, currency: currency ?? null,
        expected: order ? expectedPaise(order) : null };
    const previous = await ReconciliationCase.findById(_id).lean();
    if (previous && Object.entries(facts).every(([k,v]) => String(previous[k]) === String(v))) return;
    await ReconciliationCase.updateOne({ _id }, { $set: { ...facts, reference, day, resolvedAt: null },
        $unset: { resolvedBy: 1, resolution: 1 } }, { upsert: true });
}

async function checkPayment(payment, day) {
    const order = payment.order_id ? await Order.findOne({ razorpayOrderId: payment.order_id }) : null;
    const captured = payment.captured || ['captured', 'refunded'].includes(payment.status);
    let reason;
    if (captured) {
        if (!order || !['paid', 'refunded'].includes(order.paymentStatus) || order.razorpayPaymentId !== payment.id)
            reason = 'Capture without a matching paid order';
        else if (payment.amount !== expectedPaise(order) || payment.currency !== 'INR') reason = 'Capture amount or currency mismatch';
        else if (order.orderStatus === 'cancelled' && order.paymentStatus !== 'refunded') reason = 'Cancelled order awaiting refund';
    } else if (order?.razorpayPaymentId === payment.id && ['paid', 'refunded'].includes(order.paymentStatus)) {
        reason = 'Local payment has no confirmed capture';
    }
    await compare('payment', payment.id, day, order, reason, payment.amount, payment.currency);
    if (['created', 'authorized'].includes(payment.status)) {
        await PendingCapture.updateOne({ _id: payment.id }, { $setOnInsert: { _id: payment.id } }, { upsert: true });
    } else {
        await PendingCapture.deleteOne({ _id: payment.id });
    }
}

async function checkRefund(refund, day) {
    const order = await Order.findOne({ razorpayPaymentId: refund.payment_id });
    let reason;
    if (refund.status !== 'processed') reason = 'Refund ' + refund.status;
    else if (!order || order.paymentStatus !== 'refunded' || order.refundReference !== refund.id) reason = 'Refund missing from local records';
    else if (refund.currency !== 'INR' || refund.amount !== expectedPaise(order)) reason = 'Refund amount or currency mismatch';
    await compare('refund', refund.id, day, order, reason, refund.amount, refund.currency);
}

export async function reconcileDay(gateway, date) {
    const day = date.toISOString().slice(0, 10);
    const from = Date.parse(day) / 1000;
    const interval = { from, to: from + 86399 };
    const seenPayments = new Map(), seenRefunds = new Map();
    for await (const payment of entries(gateway.payments.all, interval)) {
        await checkPayment(payment, day);
        seenPayments.set(payment.id, payment.order_id);
    }
    for await (const refund of entries(gateway.refunds.all, interval)) {
        await checkRefund(refund, day);
        seenRefunds.set(refund.id, refund.payment_id);
    }
    // Razorpay lists payments by creation time. Capture may arrive on a later day.
    for await (const pending of PendingCapture.find().cursor()) {
        if (!seenPayments.has(pending.id)) await checkPayment(await gateway.payments.fetch(pending.id), day);
    }
    const dateRange = { $gte: new Date(from * 1000), $lt: new Date((from + 86400) * 1000) };
    for await (const order of Order.find({ paymentStatus: { $in: ['paid', 'refunded'] },
        $or: [{ updatedAt: dateRange }, { paidAt: dateRange }, { refundedAt: dateRange }] }).cursor()) {
        for (const [source, reference, seen, resource, inspect] of [
            ['payment', order.razorpayPaymentId, seenPayments, gateway.payments, checkPayment],
            ...(order.paymentStatus === 'refunded' ? [['refund', order.refundReference, seenRefunds, gateway.refunds, checkRefund]] : []),
        ]) {
            if (seen.has(reference)) {
                const expected = source === 'payment' ? order.razorpayOrderId : order.razorpayPaymentId;
                const reason = seen.get(reference) === expected ? null : 'Local ' + source + ' references another transaction';
                await compare('local-' + source, order.id, day, order, reason);
                continue;
            }
            let remote;
            if (reference && (source !== 'refund' || reference.startsWith('rfnd_'))) {
                try { remote = await resource.fetch(reference); }
                catch (err) {
                    const missing = err.statusCode === 404 || (err.statusCode === 400 &&
                        (err.error?.reason === 'invalid_id' || /id provided does not exist/i.test(err.error?.description || '')));
                    if (!missing) throw err;
                }
            }
            if (remote) await inspect(remote, day);
            const linked = remote && (source === 'payment' ? remote.order_id === order.razorpayOrderId : remote.payment_id === order.razorpayPaymentId);
            await compare('local-' + source, order.id, day, order, linked ? null : 'Local ' + source + ' awaiting gateway confirmation');
        }
    }
    for await (const issue of ReconciliationCase.find({ resolvedAt: null, reason: 'Refund pending', day: { $lt: day } }).cursor()) {
        if (!seenRefunds.has(issue.reference)) await checkRefund(await gateway.refunds.fetch(issue.reference), day);
    }
    const [year, month, reportDay] = day.split('-').map(Number);
    for await (const row of entries(gateway.settlements.reports, { year, month, day: reportDay })) {
        if (!['payment', 'refund'].includes(row.type)) continue;
        const order = await Order.findOne(row.type === 'payment'
            ? { razorpayPaymentId: row.entity_id } : { refundReference: row.entity_id });
        let reason;
        if (!order || !['paid','refunded'].includes(order.paymentStatus)) reason = 'Settlement without matching local ' + row.type;
        else if (row.currency !== 'INR' || Number(row.amount) !== expectedPaise(order)) reason = 'Settlement gross amount or currency mismatch';
        else if (row.on_hold || !row.settled) reason = 'Settlement awaiting confirmation';
        await compare('settlement', row.entity_id, day, order, reason, Number(row.amount), row.currency);
    }
}

export async function reconciliationStatus() {
    return Checkpoint.findById('daily').select('completedDay lastError nextDay -_id').lean();
}

export async function runReconciliation(gateway) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const startDay = process.env.RECONCILIATION_START_DATE || new Date(today - DAY).toISOString().slice(0, 10);
    const start = new Date(startDay);
    if (!Number.isFinite(+start) || start.toISOString().slice(0, 10) !== startDay) {
        throw new Error('Invalid RECONCILIATION_START_DATE (expected YYYY-MM-DD)');
    }
    await Checkpoint.updateOne({ _id: 'daily' }, { $setOnInsert: { nextDay: start } }, { upsert: true });
    const lease = new Date(Date.now() + 30 * 60000);
    const job = await Checkpoint.findOneAndUpdate({ _id: 'daily', nextDay: { $lt: today },
        $or: [{ lease: null }, { lease: { $lte: new Date() } }] }, { lease });
    if (!job) return;
    try {
        await reconcileDay(gateway, job.nextDay);
        await Checkpoint.updateOne({ _id: job._id, lease }, { nextDay: new Date(+job.nextDay + DAY),
            completedDay: job.nextDay.toISOString().slice(0, 10), lease: null, lastError: null });
    } catch (err) {
        await Checkpoint.updateOne({ _id: job._id, lease }, { lease: null, lastError: 'Report incomplete. Automatic retry scheduled.' });
        throw err;
    }
}
