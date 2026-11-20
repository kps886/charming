import Product from '../models/Product.js';
import { orderError } from './orderInventory.js';
import { queueRestockAlerts } from './restockAlerts.js';

async function restoreUnits(item, quantity, session) {
    if (!quantity) return;
    const product = await Product.findById(item.product).select('+restockSubscribers').session(session);
    if (!product) throw orderError(409, 'Restore the catalog record before adding returned stock');
    product.stock += quantity;
    await queueRestockAlerts(product, session);
    await product.save({ session });
}

export async function cancelSoldStock(order, session) {
    if (order.orderStatus === 'shipped') {
        order.returnState = 'awaiting-return';
        return;
    }
    for (const item of order.items) await restoreUnits(item, item.quantity, session);
    order.returnState = 'warehouse-restocked';
}

// Counts are cumulative per purchase line so re-submitting the same inspection is safe.
export async function inspectReturn(order, { line, sellable, damaged, reason }, staff, session) {
    if (order.returnState !== 'awaiting-return' && order.returnState !== 'inspected')
        throw orderError(409, 'Open a return before recording an inspection');
    const item = order.items[line];
    if (!item || sellable + damaged > item.quantity) throw orderError(400, 'Inspection exceeds the purchased quantity');
    const before = item.returnedSellable || 0, damagedBefore = item.returnedDamaged || 0;
    if (sellable < before || damaged < damagedBefore) throw orderError(409, 'Inspection counts changed. Refresh the order.');
    if (sellable === before && damaged === damagedBefore) return;
    await restoreUnits(item, sellable - before, session);
    item.returnedSellable = sellable;
    item.returnedDamaged = damaged;
    order.returnInspections.push({ line, sellable, damaged, reason, staff, at: new Date() });
    if (order.items.every(i => (i.returnedSellable || 0) + (i.returnedDamaged || 0) === i.quantity)) order.returnState = 'inspected';
}
