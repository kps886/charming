// Run against two disposable local MongoDB instances with Database Tools on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

const [sourceUri, targetUri] = process.argv.slice(2);
const local = /^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/(?:\?[^/]*)?$/;
if (![sourceUri,targetUri].every(uri => typeof uri === 'string' && local.test(uri))) {
    throw new Error('Supply two disposable loopback MongoDB URIs, including their ports and trailing slashes.');
}
assert.notEqual(new URL(sourceUri).port, new URL(targetUri).port);
const dbName = 'restore_drill_' + randomUUID().replaceAll('-', '');
const work = await mkdtemp(path.join(os.tmpdir(), 'charming-drill-'));
const archive = path.join(work, 'shop.archive');
const clients = [];
try {
    for (const uri of [sourceUri,targetUri]) clients.push(await mongoose.createConnection(uri, { dbName }).asPromise());
    const [source,target] = clients.map(client => client.db);
    const product = { _id: new mongoose.Types.ObjectId(), stock: 7, name: 'Recovery fixture' };
    const order = { _id: new mongoose.Types.ObjectId(), items: [{ product: product._id, quantity: 2 }],
        totalPaise: 12345, orderStatus: 'cancelled', paymentStatus: 'refunded',
        razorpayPaymentId: 'pay_drill', refundReference: 'rfnd_drill' };
    await source.collection('products').insertOne(product);
    await source.collection('orders').insertOne(order);
    await source.collection('orders').createIndex({ razorpayPaymentId: 1 });
    execFileSync('mongodump', ['--uri',sourceUri,'--db',dbName,'--archive=' + archive,'--gzip'], { stdio: 'pipe' });
    const started = performance.now();
    assert.deepEqual(await target.listCollections().toArray(), []);
    execFileSync('mongorestore', ['--uri',targetUri,'--nsInclude',dbName + '.*','--archive=' + archive,'--gzip','--stopOnError'], { stdio: 'pipe' });
    const restored = await target.collection('orders').findOne({ _id: order._id });
    assert.deepEqual(restored, order);
    assert.deepEqual(await target.collection('products').findOne({ _id: restored.items[0].product }), product);
    assert.ok(await target.collection('orders').indexExists('razorpayPaymentId_1'));
    console.log('Archive restored and verified in ' + ((performance.now() - started) / 1000).toFixed(2) + ' seconds.');
} finally {
    for (const client of clients) {
        try { await client.db.dropDatabase(); } finally { await client.close(); }
    }
    await rm(archive, { force: true });
    await rmdir(work);
}
