import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { sendEmail } from './emailService.js';

export const AccountMail = mongoose.model('AccountMail', new mongoose.Schema({
    _id: String, version: String, kind: String, user: mongoose.Schema.Types.ObjectId,
    payload: { type: String, select: false }, state: String, attempts: Number, failure: String,
    nextAttempt: { type: Date, index: true }, validUntil: Date, purgeAt: { type: Date, expires: 0 },
}, { timestamps: true }));

function key() {
    return crypto.createHash('sha256').update('charming/account-mail/v1\0').update(process.env.ACCOUNT_MAIL_KEY || process.env.JWT_SECRET).digest();
}

function seal(message) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function open(payload) {
    const bytes = Buffer.from(payload, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}

// New codes supersede earlier queued messages for this user and purpose.
export async function queueAccountMail(user, kind, message, validUntil, session) {
    const version = crypto.randomUUID();
    const _id = kind === 'security' ? version : user + ':' + kind;
    await AccountMail.updateOne({ _id }, { $set: { kind, user, version, payload: seal(message),
        validUntil, state: 'queued', failure: null, attempts: 0, nextAttempt: new Date(),
        purgeAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true, session });
    return { _id, version };
}

export async function deliverAccountMail(filter) {
    const now = new Date();
    const job = await AccountMail.findOneAndUpdate({ ...filter, state: 'queued', nextAttempt: { $lte: now },
        validUntil: { $gt: now } }, { $inc: { attempts: 1 }, nextAttempt: new Date(+now + 120000) },
        { returnDocument: 'after' }).select('+payload');
    if (!job) return false;
    const identity = { _id: job.id, version: job.version, attempts: job.attempts };
    try {
        await sendEmail({ ...open(job.payload), messageId: '<' + job.version + '@charming>' });
    } catch (err) {
        const retry = !(err.responseCode >= 500) && job.attempts < 4;
        const change = { state: retry ? 'queued' : 'failed', failure: String(err.responseCode || err.code || 'DELIVERY_ERROR'),
            nextAttempt: new Date(Date.now() + job.attempts * 30000) };
        await AccountMail.updateOne(identity, retry ? { $set: change } : { $set: change, $unset: { payload: 1 } });
        console.error('Account email delivery failed', job.kind, change.failure);
        return false;
    }
    await AccountMail.updateOne(identity, { $set: { state: 'sent' }, $unset: { payload: 1 } });
    return true;
}

export async function retryAccountMail() {
    await AccountMail.updateMany({ state: 'queued', validUntil: { $lte: new Date() } },
        { $set: { state: 'expired' }, $unset: { payload: 1 } });
    const jobs = await AccountMail.find({ state: 'queued', nextAttempt: { $lte: new Date() } })
        .sort({ nextAttempt: 1 }).limit(50).select('version').lean();
    for (const { _id, version } of jobs) await deliverAccountMail({ _id, version });
}
