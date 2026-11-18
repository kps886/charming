import { useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function RefundRecord({ order, onRecorded }) {
    const [reference, setReference] = useState('');
    const [saving, setSaving] = useState(false);
    if (order.paymentStatus === 'refunded') return <p>Refund complete · {order.refundReference}</p>;
    if (order.orderStatus !== 'cancelled' || order.paymentStatus !== 'paid') return null;
    async function record(event) {
        event.preventDefault();
        setSaving(true);
        try {
            await api.put('/api/orders/' + order._id + '/refund', { reference });
            toast.success('Refund recorded');
            onRecorded();
        } catch (err) {
            toast.error(err.response?.data?.message || 'Could not record refund');
        } finally { setSaving(false); }
    }
    return <form onSubmit={record} className="p-4 space-y-2">
        <p>Refund pending. Complete the full refund in Razorpay, then record its reference here.</p>
        <label>Refund reference <input required maxLength={100} value={reference}
            className="p-2 bg-primary-bg border border-border-color" onChange={e => setReference(e.target.value)} /></label>
        <button disabled={saving || !reference.trim()} className="px-3 py-2 text-accent-gold">Record completed refund</button>
    </form>;
}
