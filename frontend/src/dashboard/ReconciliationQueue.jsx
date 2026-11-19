import React, { useEffect, useState } from 'react';
import api from '../api';

export default function ReconciliationQueue() {
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [revision, refresh] = useState(0);
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        let current = true;
        setData(null);
        setError('');
        api.get('/api/orders/reconciliation', { params: { page } }).then(({ data }) => {
            if (current) setData(data);
        }).catch(() => { if (current) setError('Could not load payment reconciliation.'); });
        return () => { current = false; };
    }, [page, revision, open]);

    async function resolve(entry) {
        const resolution = window.prompt('How was this discrepancy resolved?');
        if (!resolution?.trim()) return;
        try {
            await api.put('/api/orders/reconciliation/' + encodeURIComponent(entry._id), { resolution });
            if (data.cases.length === 1 && page > 1) setPage(page - 1);
            else refresh(n => n + 1);
        } catch (err) { setError(err.response?.data?.message || 'Could not record resolution.'); }
    }
    return <section className="mb-5">
        <button className="text-accent-gold" aria-expanded={open} onClick={() => setOpen(!open)}>Payment reconciliation</button>
        {open && <div className="border border-border-color p-4 space-y-2">
            {error && <p role="alert">{error} <button onClick={() => refresh(n => n + 1)}>Retry</button></p>}
            {!data && !error && <p>Loading…</p>}
            {data && <>
                <p>Last completed day (UTC) · {data.status?.completedDay || 'Awaiting first report'}</p>
                {data.status?.lastError && <p role="alert">{data.status.lastError}</p>}
                <p>{data.total} open cases</p>
                {data.cases.map(entry => <div key={entry._id} className="border-t border-border-color py-2">
                    <strong>{entry.reason}</strong> · {entry.day}
                    <p className="break-all">{entry.reference}{entry.order && ' · Order ' + entry.order}</p>
                    <p>Expected {entry.expected == null ? '—' : '₹' + (entry.expected / 100).toFixed(2)} · Reported {entry.actual == null ? '—' : [entry.currency, (entry.actual / 100).toFixed(2)].filter(Boolean).join(' ')}</p>
                    <button className="text-accent-gold" onClick={() => resolve(entry)}>Record resolution</button>
                </div>)}
                {page > 1 && <button onClick={() => setPage(page - 1)}>Previous page</button>}
                {page * 25 < data.total && <button onClick={() => setPage(page + 1)}>Next page</button>}
            </>}
        </div>}
    </section>;
}
