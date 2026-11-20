import { useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function RefundRecord({ order, onRecorded }) {
    const [reference, setReference] = useState(order.refundCheck?.reference || order.refundReference || '');
    const [saving, setSaving] = useState(false);
    if (order.paymentStatus === 'refunded') return <p>Refund complete · {order.refundReference}</p>;
    if (order.paymentStatus !== 'refund_review' && (order.paymentStatus !== 'paid' ||
        (order.orderStatus !== 'cancelled' && order.returnState !== 'inspected'))) return null;
    async function record(event) {
        event.preventDefault();
        setSaving(true);
        try {
            await api.put('/api/orders/' + order._id + '/refund', { reference });
            toast.success('Refund recorded');
            onRecorded();
        } catch (err) {
            onRecorded();
            toast.error(err.response?.data?.message || 'Could not record refund');
        } finally { setSaving(false); }
    }
    return <form onSubmit={record} className="p-4 space-y-2">
        <p>Look up the full refund in Razorpay and enter its reference to verify it.</p>
        {order.refundCheck?.status && <p>Last verification · {order.refundCheck.status}</p>}
        <label>Refund reference <input required maxLength={100} value={reference}
            className="p-2 bg-primary-bg border border-border-color" onChange={e => setReference(e.target.value)} /></label>
        <button disabled={saving || !reference.trim()} className="px-3 py-2 text-accent-gold">Record completed refund</button>
    </form>;
}
