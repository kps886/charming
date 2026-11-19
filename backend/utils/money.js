// Order amounts are integers in the smallest INR unit. Rupee fields are compatibility projections.
export function paise(rupees) {
    const amount = Math.round((Number(rupees) + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Invalid monetary amount');
    return amount;
}

export function discountPaise(promo, subtotal) {
    if (promo.discountType === 'flat') return paise(promo.discountValue);
    const discount = Math.round(subtotal * promo.discountValue / 100);
    return promo.maxDiscountAmount == null ? discount : Math.min(discount, paise(promo.maxDiscountAmount));
}

export function expectedPaise(order) {
    if (order.totalPaise != null) return order.totalPaise;
    // Legacy totals were rounded after the gateway charge was created. Rebuild from the purchase snapshot.
    const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return Math.round(Math.max(1, subtotal + order.deliveryFee - order.discount) * 100);
}
