function fields(record, names) {
    return Object.fromEntries(names.split(' ').filter(name => record[name] !== undefined).map(name => [name, record[name]]));
}
const addressFields = 'fullName phone line1 line2 city state pincode country';
export const adminAccountFields = '_id name email role isActive isVerified createdAt';

export function profileResponse(user) {
    return { ...fields(user, '_id name email role'), pendingEmail: user.pendingEmail || null,
        addresses: user.addresses.map(address => fields(address, '_id isDefault ' + addressFields)) };
}

export function allowedStatuses(order, role) {
    if (role === 'user') return [];
    const manager = ['shopkeeper','admin'].includes(role);
    switch (order.orderStatus) {
        case 'pending': return manager ? ['cancelled'] : [];
        case 'processing': return order.paymentStatus === 'paid' ? (manager ? ['shipped','cancelled'] : ['shipped']) : [];
        case 'shipped': return order.paymentStatus === 'paid' ? (manager ? ['delivered','cancelled'] : ['delivered']) : [];
        default: return [];
    }
}

export function orderResponse(order, role = 'user') {
    const result = fields(order, '_id createdAt orderStatus paymentStatus paymentMethod paidAt shippedAt deliveredAt cancelledAt trackingNumber cancelReason subtotal deliveryFee discount total promoCode refundReference refundedAt returnState');
    if (order.paymentStatus === 'refunded' && !order.refundVerifiedAt) result.paymentStatus = 'refund_review';
    result.shippingAddress = fields(order.shippingAddress, addressFields);
    result.items = order.items.map(item => ({
        ...fields(item, 'name image price quantity returnedSellable returnedDamaged'),
        product: item.product?.name ? fields(item.product, '_id name images') : item.product,
    }));
    result.paymentUnderReview = Boolean(order.captureReview);
    result.paymentAuthorized = Boolean(order.authorizedPaymentId);
    if (role !== 'user') {
        result.user = order.user?.name ? fields(order.user, '_id name email') : order.user;
        result.allowedStatuses = allowedStatuses(order, role);
    }
    if (['shopkeeper','admin'].includes(role)) Object.assign(result, fields(order, 'razorpayOrderId razorpayPaymentId captureReview refundCheck returnReason'));
    if (role === 'admin') Object.assign(result, fields(order, 'refundedBy'));
    return result;
}
