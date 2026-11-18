import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';

export default function useInventoryPage() {
    const [page, setPage] = useState(1);
    const [pages, setPages] = useState(1);
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    const [summary, setSummary] = useState({ products: 0, lowStock: 0, outOfStock: 0 });
    const refresh = useCallback(() => setRevision(n => n + 1), []);
    useEffect(() => {
        const controller = new AbortController();
        const options = { signal: controller.signal };
        setLoading(true);
        Promise.all([
            api.get('/api/products?page=' + page, options),
            api.get('/api/products/staff-summary', options),
        ]).then(([catalog, stats]) => {
            const last = Math.max(1, catalog.data.pages);
            setPages(last);
            setPage(Math.min(last, page));
            setProducts(catalog.data.products);
            setSummary(stats.data);
        }).catch(() => {
            if (!controller.signal.aborted) toast.error('Failed to load inventory');
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [page, revision]);
    return { page, pages, setPage, products, loading, refresh, summary };
}
