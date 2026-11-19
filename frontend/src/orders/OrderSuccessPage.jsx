import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';

const OrderSuccessPage = () => {
    const { id } = useParams();
    const [order, setOrder] = useState(null);

    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        let timer;
        setOrder(null);
        setError('');
        async function check() {
            try {
                const { data } = await api.get('/api/orders/' + id, { signal: controller.signal });
                if (controller.signal.aborted) return;
                setOrder(data);
                if (data.paymentStatus === 'pending' && data.orderStatus !== 'cancelled') {
                    timer = setTimeout(check, 15000);
                }
            } catch (err) {
                if (controller.signal.aborted) return;
                setOrder(null);
                setError([403, 404].includes(err.response?.status) ? 'unavailable' : 'retry');
            }
        }
        check();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [id, revision]);

    let title = 'Checking your order…';
    let message = '';
    if (error === 'unavailable') {
        title = 'Order unavailable';
        message = 'Check My Orders using the account that placed this order.';
    } else if (error) {
        title = 'Could not check your order';
        message = 'Check the status again before attempting another payment.';
    } else if (order?.paymentStatus === 'refunded') {
        title = 'Payment refunded';
    } else if (order?.captureReview) {
        title = 'Payment under review';
        message = 'Our team will check this payment. Keep your order reference and avoid paying again.';
    } else if (order?.orderStatus === 'cancelled') {
        title = 'Order cancelled';
        message = order.paymentStatus === 'paid' ? 'Your refund is pending.' : 'This order will not be fulfilled.';
    } else if (order?.paymentStatus === 'paid') {
        title = 'Order confirmed';
        message = 'Your payment was received. You can track this order in My Orders.';
    } else if (order?.authorizedPaymentId && order.paymentStatus === 'pending') {
        title = 'Awaiting payment capture';
        message = 'Your payment was authorized. We’ll confirm the order once the payment is captured.';
    } else if (order?.paymentStatus === 'failed') {
        title = 'Payment failed';
    } else if (order) {
        title = 'Awaiting payment confirmation';
        message = 'We are checking the payment status. If you already paid, avoid making another payment.';
    }

    return (
        <div className="min-h-[80vh] flex items-center justify-center px-4">
            <div className="text-center max-w-md w-full">
                <h1 aria-live="polite" className="text-3xl font-serif mb-2">{title}</h1>
                <p className="text-text-secondary mb-6">{message}</p>
                {(error === 'retry' || order?.paymentStatus === 'pending') && (
                    <button onClick={() => setRevision(n => n + 1)} className="text-accent-gold mb-4">Check status again</button>
                )}
                {order && (
                    <div className="bg-secondary-bg border border-border-color p-5 text-left mb-6 text-sm space-y-2">
                        <div className="flex justify-between">
                            <span className="text-text-secondary">Order ID</span>
                            <span className="font-mono text-xs">{order._id.slice(-10).toUpperCase()}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-text-secondary">Order total</span>
                            <span className="font-bold text-accent-gold">₹{order.total.toLocaleString('en-IN')}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-text-secondary">Delivering To</span>
                            <span className="text-right">{order.shippingAddress.city}, {order.shippingAddress.state}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-text-secondary">Status</span>
                            <span className="text-blue-400 font-semibold capitalize">{order.orderStatus}</span>
                        </div>
                    </div>
                )}

                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                    <Link
                        to="/my-orders"
                        className="bg-accent-gold text-primary-bg font-bold px-6 py-3 uppercase tracking-wider hover:bg-yellow-500 transition-colors"
                    >
                        Track My Orders
                    </Link>
                    <Link
                        to="/"
                        className="border border-border-color px-6 py-3 font-semibold uppercase tracking-wider hover:border-text-secondary transition-colors text-sm"
                    >
                        Continue Shopping
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default OrderSuccessPage;