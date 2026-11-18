import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';

export default function RestockAlert({ productId, user }) {
    const [subscribed, setSubscribed] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!user) return;
        const controller = new AbortController();
        api.get('/api/products/' + productId + '/restock-alert', { signal: controller.signal })
            .then(({ data }) => setSubscribed(data.subscribed))
            .catch(() => { if (!controller.signal.aborted) setSubscribed(false); });
        return () => controller.abort();
    }, [productId, user?._id]);

    if (!user) return <Link to="/login" className="text-accent-gold">Sign in for a restock email</Link>;
    async function toggle() {
        setBusy(true);
        try {
            const path = '/api/products/' + productId + '/restock-alert';
            const { data } = subscribed ? await api.delete(path) : await api.put(path);
            setSubscribed(data.subscribed);
            toast.success(data.subscribed ? 'We’ll email you when this item is restocked.' : 'Restock email cancelled.');
        } catch (err) {
            toast.error(err.response?.data?.message || 'Could not update restock alert');
        } finally { setBusy(false); }
    }
    return <button type="button" disabled={busy || subscribed === null} onClick={toggle}
        className="mb-4 border border-accent-gold px-4 py-2 text-accent-gold">
        {subscribed ? 'Cancel restock email' : 'Email me when back in stock'}
    </button>;
}
