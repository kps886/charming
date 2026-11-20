import React, { useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function ReturnInspection({ order, refresh }) {
    const [busy, setBusy] = useState(false);
    if (order.returnState === 'warehouse-restocked') return <p>Unshipped units restored to stock.</p>;
    if (order.returnState === 'inspected') return <p>Return inspection complete.</p>;
    const waiting = order.returnState === 'awaiting-return';
    if (!waiting && (order.orderStatus !== 'delivered' || order.paymentStatus !== 'paid')) return null;
    async function submit(event, line) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const reason = values.get('reason');
        const body = waiting ? { line, reason, sellable: Number(values.get('sellable')), damaged: Number(values.get('damaged')) } : { reason };
        setBusy(true);
        try {
            await api.put('/api/orders/' + order._id + '/return' + (waiting ? '/inspection' : ''), body);
            await refresh();
        } catch (err) { toast.error(err.response?.data?.message || 'Could not save return'); }
        finally { setBusy(false); }
    }
    if (!waiting) return <form onSubmit={e => submit(e)} className="space-x-2">
        <input name="reason" aria-label="Return reason" placeholder="Return reason" required maxLength={500} />
        <button disabled={busy}>Open return</button>
    </form>;
    return <section><h4>Inspect returned units</h4>
        <p>Enter the total received so far for each item, including earlier inspections.</p>
        {order.items.map((item, line) => <form key={[line,item.returnedSellable,item.returnedDamaged].join('-')}
            onSubmit={e => submit(e, line)} className="flex flex-wrap items-center gap-2 py-2">
            <strong>{item.name} × {item.quantity}</strong>
            {['sellable','damaged'].map((key,index) => <label key={key}>{key} <input name={key} type="number" required min="0" max={item.quantity}
                defaultValue={(index ? item.returnedDamaged : item.returnedSellable) || 0} className="w-16" /></label>)}
            <input name="reason" aria-label="Inspection note" placeholder="Inspection note" required maxLength={500} />
            <button disabled={busy}>Save inspection</button>
        </form>)}
    </section>;
}
