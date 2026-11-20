import { createHash } from 'node:crypto';
import Product from '../models/Product.js';
import PromoCode from '../models/PromoCode.js';
import Order, { FREE_SHIPPING_SUBTOTAL } from '../models/Order.js';
import { paise, discountPaise } from './money.js';

export async function priceTotals(subtotalPaise, code, session) {
    const deliveryFeePaise = paise(Order.calcDeliveryFee(subtotalPaise / 100));
    let discount = 0, promo = null;
    if (code) {
        promo = await PromoCode.findOne({ code }).session(session || null);
        if (!promo?.isActive || (promo.expiresAt && promo.expiresAt <= new Date()) ||
            (promo.usageLimit != null && promo.usedCount + (promo.reservedCount || 0) >= promo.usageLimit) ||
            subtotalPaise < paise(promo.minOrderValue)) {
            throw Object.assign(new Error('Promo code unavailable for this order'), { status: 400 });
        }
        discount = Math.min(discountPaise(promo, subtotalPaise), Math.max(0, subtotalPaise + deliveryFeePaise - 100));
    }
    const totalPaise = Math.max(100, subtotalPaise + deliveryFeePaise - discount);
    return { ...(promo ? { discountType: promo.discountType, discountValue: promo.discountValue } : {}), subtotalPaise, deliveryFeePaise, discountPaise: discount, totalPaise,
        subtotal: subtotalPaise / 100, deliveryFee: deliveryFeePaise / 100, discount: discount / 100,
        total: totalPaise / 100, promoCode: code, promoDiscount: discount / 100 };
}

export async function priceBasket(items, code, session) {
    const products = await Product.find({ _id: { $in: items.map(i => i.product) } }).session(session || null);
    const catalog = new Map(products.map(p => [p.id, p]));
    let subtotal = 0;
    const verified = items.map(item => {
        const p = catalog.get(item.product);
        if (!p) throw Object.assign(new Error('Product no longer available'), { status: 404 });
        const price = p.pricePaise ?? paise(p.price);
        subtotal += price * item.quantity;
        if (!Number.isSafeInteger(subtotal) || subtotal > Number.MAX_SAFE_INTEGER - 5000)
            throw Object.assign(new Error('Order amount too large'), { status: 400 });
        return { product: p._id, name: p.name, image: p.images?.[0], quantity: item.quantity, pricePaise: price, price: price / 100 };
    });
    return { items: verified, ...await priceTotals(subtotal, code, session) };
}

export function publicQuote(order) {
    const { subtotal, deliveryFee, discount, total, promoCode } = order;
    const items = order.items.map(i => ({ product: String(i.product), price: i.price, quantity: i.quantity }));
    const quote = { items, subtotal, deliveryFee, discount, total, promoCode };
    return { ...quote, remainingForFreeDelivery: Math.max(0, paise(FREE_SHIPPING_SUBTOTAL) - paise(subtotal)) / 100, quoteId: createHash('sha256').update(JSON.stringify(quote)).digest('hex') };
}

export function checkQuote(order, expected) {
    if (!expected) return;
    const quote = publicQuote(order);
    if (quote.quoteId !== expected) throw Object.assign(new Error('Prices changed. Review the updated order before paying.'), { status: 409, quote });
}
