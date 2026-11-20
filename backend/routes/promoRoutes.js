import { priceTotals } from '../utils/pricing.js';
import { paise } from '../utils/money.js';
import express from 'express';
import PromoCode from '../models/PromoCode.js';
import { protect, adminOnly } from '../middleware/authMiddleware.js';

import { schema, validate, validateIds } from '../middleware/validation.js';
const router = express.Router();
validateIds(router, ["id"]);

// ─────────────────────────────────────────────
// POST /api/promo/validate
// Validates a promo code against a subtotal.
// Called from the checkout page.
// ─────────────────────────────────────────────
router.post('/validate', protect, validate(schema.promoCheck), async (req, res) => {
    const { code, subtotal } = req.body;

    if (!code || !subtotal) {
        return res.status(400).json({ message: 'Code and subtotal are required' });
    }

    try {
        const quote = await priceTotals(paise(subtotal), code.trim().toUpperCase());
        res.json({ ...quote, valid: true, code: quote.promoCode, message: 'Promo applied' });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.status ? err.message : 'Server error' });
    }
});

// ─────────────────────────────────────────────
// Admin CRUD for promo codes
// ─────────────────────────────────────────────

// GET all promo codes
router.get('/', protect, adminOnly, async (req, res) => {
    const promos = await PromoCode.find({}).sort({ createdAt: -1 });
    res.json(promos);
});

// Create promo code
router.post('/', protect, adminOnly, validate(schema.promo), async (req, res) => {
    try {
        const promo = await PromoCode.create({ ...req.body, code: req.body.code.toUpperCase() });
        res.status(201).json(promo);
    } catch (err) {
        res.status(400).json({ message: err.message || 'Error creating promo code' });
    }
});

// Update promo code
router.put('/:id', protect, adminOnly, validate(schema.promoEdit), async (req, res) => {
    try {
        const filter = { _id: req.params.id };
        if (req.body.usageLimit != null) filter.$expr = {
            $lte: [{ $add: [{ $ifNull: ['$usedCount', 0] }, { $ifNull: ['$reservedCount', 0] }] }, req.body.usageLimit],
        };
        const promo = await PromoCode.findOneAndUpdate(filter, req.body, { returnDocument: 'after', runValidators: true });
        if (!promo && await PromoCode.exists({ _id: req.params.id })) return res.status(409).json({ message: 'Limit is below existing uses and reservations' });
        if (!promo) return res.status(404).json({ message: 'Promo code not found' });
        res.json(promo);
    } catch (err) {
        res.status(400).json({ message: err.message || 'Error updating promo code' });
    }
});

// Delete promo code
router.delete('/:id', protect, adminOnly, async (req, res) => {
    try {
        const promo = await PromoCode.findOneAndDelete({ _id: req.params.id, $or: [{ reservedCount: 0 }, { reservedCount: null }] });
        if (!promo && await PromoCode.exists({ _id: req.params.id })) return res.status(409).json({ message: 'Disable this promo until its active checkouts clear.' });
        if (!promo) return res.status(404).json({ message: 'Promo code not found' });
        res.json({ message: 'Promo code deleted' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;