import mongoose from 'mongoose';
import express from 'express';
import { schema, validate, validateIds, parseProduct } from '../middleware/validation.js';
const router = express.Router();
validateIds(router, ["id","reviewId"]);
import { queueRestockAlerts, RestockAlert } from '../utils/restockAlerts.js';
import Product from '../models/Product.js';
import { protect, shopkeeperAndAbove, employeeAndAbove } from '../middleware/authMiddleware.js';
import upload, { storedAssets, uploadImages, queueImageDeletion } from '../middleware/uploadMiddleware.js';

router.get('/staff-summary', protect, employeeAndAbove, async (req, res) => {
    const [products, lowStock, outOfStock] = await Promise.all([
        Product.countDocuments(), Product.countDocuments({ stock: { $gt: 0, $lte: 5 } }),
        Product.countDocuments({ stock: 0 }),
    ]);
    res.json({ products, lowStock, outOfStock });
});

// @desc    Fetch products with pagination, sorting, search, category filter
// @route   GET /api/products?page=1&limit=12&sort=newest&category=X&search=Y
// @access  Public
router.get('/', validate(schema.catalog, 'query'), async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(48, parseInt(req.query.limit) || 12);
        const skip = (page - 1) * limit;
        if (req.query.minPrice !== undefined && req.query.maxPrice !== undefined && Number(req.query.minPrice) > Number(req.query.maxPrice)) {
            return res.status(400).json({ message: 'Minimum price exceeds maximum price' });
        }

        // Build filter
        const filter = {};
        if (req.query.category) filter.category = req.query.category;
        if (req.query.search) {
            const literal = req.query.search.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&');
            filter.$or = [
                { name: { $regex: literal, $options: 'i' } },
                { description: { $regex: literal, $options: 'i' } },
                { category: { $regex: literal, $options: 'i' } },
                { tags: { $regex: literal, $options: 'i' } },
            ];
        }
        if (req.query.minPrice || req.query.maxPrice) {
            filter.price = {};
            if (req.query.minPrice) filter.price.$gte = Number(req.query.minPrice);
            if (req.query.maxPrice) filter.price.$lte = Number(req.query.maxPrice);
        }
        // Build sort
        const SORT_MAP = {
            newest: { createdAt: -1 },
            oldest: { createdAt: 1 },
            price_asc: { price: 1 },
            price_desc: { price: -1 },
            name_asc: { name: 1 },
            name_desc: { name: -1 },
        };
        const sort = SORT_MAP[req.query.sort] || SORT_MAP.newest;

        const [products, total] = await Promise.all([
            Product.find(filter).select('-reviews').sort({ ...sort, _id: 1 }).skip(skip).limit(limit),
            Product.countDocuments(filter),
        ]);

        res.json({
            products,
            page,
            pages: Math.ceil(total / limit),
            total,
            limit,
        });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/staff-reviews', protect, shopkeeperAndAbove, async (req, res) => {
    const reviews = await Product.aggregate([
        { $unwind: '$reviews' },
        { $sort: { 'reviews._id': -1 } },
        { $replaceWith: { $mergeObjects: ['$reviews', {
            productId: '$_id', productName: '$name', productImage: { $first: '$images' },
        }] } },
    ]);
    res.json(reviews);
});

router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (product) {
            const visible = product.toObject();
            visible.reviews = visible.reviews.filter(review => review.isApproved);
            res.json(visible);
        } else {
            res.status(404).json({ message: 'Product not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

router.post('/', protect, shopkeeperAndAbove, parseProduct(upload, schema.product), async (req, res) => {
    const assets = [];
    try {
        await uploadImages(req.files, assets);

        const { name, description, price, category, stock, tags } = req.body;

        const imageUrls = assets.map(asset => asset.url);
        const parsedTags = tags ? tags.split(',').map(tag => tag.trim()).filter(Boolean) : [];

        const product = await Product.create({
            name,
            description,
            price: Number(price),
            category,
            images: imageUrls,
            imageAssets: assets,
            stock: Number(stock) || 0,
            tags: parsedTags,
            createdBy: req.user._id,
        });
        res.status(201).json(product);
    } catch (error) {
        await queueImageDeletion(assets.map(a => a.publicId));
        res.status(400).json({ message: error.message || 'Error creating product' });
    }
});

router.get('/:id/restock-alert', protect, async (req, res) => {
    const subscribed = await Product.exists({ _id: req.params.id, restockSubscribers: req.user._id })
        || await RestockAlert.exists({ product: req.params.id, user: req.user._id });
    res.json({ subscribed: Boolean(subscribed) });
});

router.put('/:id/restock-alert', protect, async (req, res) => {
    const result = await Product.updateOne({ _id: req.params.id, stock: { $lte: 0 } },
        { $addToSet: { restockSubscribers: req.user._id } });
    if (!result.matchedCount) return res.status(409).json({ message: 'This item is no longer sold out' });
    res.json({ subscribed: true });
});

router.delete('/:id/restock-alert', protect, async (req, res) => {
    await mongoose.connection.transaction(async session => {
        await Product.updateOne({ _id: req.params.id }, { $pull: { restockSubscribers: req.user._id } }, { session });
        await RestockAlert.deleteOne({ product: req.params.id, user: req.user._id }, { session });
    });
    res.json({ subscribed: false });
});

router.put('/:id', protect, employeeAndAbove, parseProduct(upload, schema.productEdit), async (req, res) => {
    const assets = [];
    try {
        await uploadImages(req.files, assets);
        const updatedProduct = await mongoose.connection.transaction(async session => {
            const product = await Product.findById(req.params.id).select('+restockSubscribers').session(session);
            if (!product) return null;
            const previousStock = product.stock;

            const { name, description, price, category, stock, tags, existingImages } = req.body;

            const keep = existingImages === undefined ? product.images : JSON.parse(existingImages);
            if (!Array.isArray(keep) || keep.some(url => !product.images.includes(url)) || new Set(keep).size !== keep.length)
                throw new Error('Invalid retained images');
            const combinedImages = [...keep, ...assets.map(a => a.url)];
            if (combinedImages.length > 5 && (assets.length || existingImages !== undefined)) throw new Error('Choose up to five images');
            const old = storedAssets(product);
            await queueImageDeletion([...old].filter(([url]) => !keep.includes(url)).map(([,id]) => id), session);
            product.imageAssets = [...keep.filter(url => old.has(url)).map(url => ({ url, publicId: old.get(url) })), ...assets];
            product.images = combinedImages;

            if (name !== undefined) product.name = name;
            if (description !== undefined) product.description = description;
            if (price !== undefined) product.price = Number(price);
            if (category !== undefined) product.category = category;
            if (stock !== undefined) {
                const quantity = Number(stock);
                if (!Number.isSafeInteger(quantity) || quantity < 0 || stock === '') throw new Error('Enter a non-negative whole stock quantity');
                product.stock = quantity;
            }

            if (tags !== undefined) {
                product.tags = tags.split(',').map(tag => tag.trim()).filter(Boolean);
            }

            if (product.stock > previousStock) await queueRestockAlerts(product, session);
            await product.save({ session });
            const response = product.toObject();
            delete response.restockSubscribers;
            return response;
        });
        if (!updatedProduct) {
            await queueImageDeletion(assets.map(a => a.publicId));
            return res.status(404).json({ message: 'Product not found' });
        }
        res.json(updatedProduct);
    } catch (error) {
        await queueImageDeletion(assets.map(a => a.publicId));
        res.status(400).json({ message: error.message || 'Error updating product' });
    }
});

router.delete('/:id', protect, shopkeeperAndAbove, async (req, res) => {
    try {
        const product = await mongoose.connection.transaction(async session => {
            const deleted = await Product.findByIdAndDelete(req.params.id, { session });
            if (deleted) await queueImageDeletion([...storedAssets(deleted).values()], session);
            return deleted;
        });
        if (!product) return res.status(404).json({ message: 'Product not found' });
        res.json({ message: 'Product removed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Add a review
// @route   POST /api/products/:id/reviews
// @access  Private
router.post('/:id/reviews', protect, validate(schema.review), async (req, res) => {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }
    if (!comment?.trim()) {
        return res.status(400).json({ message: 'Comment is required' });
    }

    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        const alreadyReviewed = product.reviews.find(
            r => r.user && r.user.toString() === req.user._id.toString()
        );
        if (alreadyReviewed) {
            return res.status(400).json({ message: 'You have already reviewed this product' });
        }

        product.reviews.push({
            user:    req.user._id,
            name:    req.user.name,
            rating:  Number(rating),
            comment: comment.trim(),
            isApproved: false
        });

        await product.save();
        res.status(201).json({ message: 'Review submitted! It will appear once approved.' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

router.put('/:id/reviews/:reviewId/toggle', protect, shopkeeperAndAbove, validate(schema.moderation), async (req, res) => {
    try {
        const review = await mongoose.connection.transaction(async session => {
            const product = await Product.findById(req.params.id).session(session);
            const entry = product?.reviews.id(req.params.reviewId);
            if (!entry) return null;
            entry.isApproved = typeof req.body?.isApproved === 'boolean' ? req.body.isApproved : !entry.isApproved;
            const approved = product.reviews.filter(r => r.isApproved);
            product.reviewCount = approved.length;
            product.avgRating = approved.length ? approved.reduce((sum, r) => sum + r.rating, 0) / approved.length : 0;
            await product.save({ session });
            return entry;
        });
        if (!review) return res.status(404).json({ message: 'Review not found' });
        res.json({ message: `Review ${review.isApproved ? 'Approved' : 'Hidden'}`, review });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

export default router;