import { useEffect, useState } from 'react';
import api from '../api';

export default function useCheckoutQuote(cartItems, promoCode = null) {
    const basket = JSON.stringify(cartItems.map(i => ({ product: i._id, quantity: i.qty })).sort((a,b) => a.product.localeCompare(b.product)));
    const key = JSON.stringify([basket, promoCode]);
    const [response, setResponse] = useState(null);
    const [revision, refresh] = useState(0);
    useEffect(() => {
        if (basket === '[]') return;
        const controller = new AbortController();
        api.post('/api/orders/quote', { items: JSON.parse(basket), promoCode }, { signal: controller.signal })
            .then(({ data }) => { if (!controller.signal.aborted) setResponse({ key, data }); })
            .catch(err => { if (!controller.signal.aborted) setResponse({ key, error: err.response?.data?.message || 'Could not load prices' }); });
        return () => controller.abort();
    }, [basket, promoCode, key, revision]);
    const current = response?.key === key ? response : null;
    return { quote: current?.data, error: current?.error, retry: () => refresh(n => n + 1),
        reviewQuote: data => setResponse({ key, data }) };
}
