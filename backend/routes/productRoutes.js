import mongoose from 'mongoose';
import express from 'express';
const router = express.Router();
import { queueRestockAlerts, RestockAlert } from '../utils/restockAlerts.js';
import Product from '../models/Product.js';
import { protect, shopkeeperAndAbove, employeeAndAbove } from '../middleware/authMiddleware.js';
import upload, { cloudinary } from '../middleware/uploadMiddleware.js';

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
router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(48, parseInt(req.query.limit) || 12);
        const skip = (page - 1) * limit;

        // Build filter
        const filter = {};
        if (req.query.category) filter.category = req.query.category;
        if (req.query.search) {
            filter.$or = [
                { name: { $regex: req.query.search, $options: 'i' } },
                { description: { $regex: req.query.search, $options: 'i' } },
                { category: { $regex: req.query.search, $options: 'i' } },
                { tags: { $regex: req.query.search, $options: 'i' } },
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

router.post('/', protect, shopkeeperAndAbove, async (req, res) => {
    const uploadMiddleware = upload.array('images', 5);
    uploadMiddleware(req, res, async (err) => {
        // 3. Catch Multer/Cloudinary errors IMMEDIATELY
        if (err) {
            return res.status(400).json({ message: err.message || "Failed to upload images to Cloudinary" });
        }

        // 4. If we get here, the upload succeeded. Now we do the database logic.
        try {;

            const { name, description, price, category, stock, tags } = req.body;

            const imageUrls = req.files ? req.files.map(file => file.path) : [];
            const parsedTags = tags ? tags.split(',').map(tag => tag.trim()).filter(Boolean) : [];

            const product = await Product.create({
                name,
                description,
                price: Number(price),
                category,
                images: imageUrls,
                stock: Number(stock) || 0,
                tags: parsedTags,
                createdBy: req.user._id,
            });
            res.status(201).json(product);
        } catch (error) {
            res.status(400).json({ message: error.message || 'Error creating product' });
        }
    });
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

router.put('/:id', protect, employeeAndAbove, async (req, res) => {
    const uploadMiddleware = upload.array('images', 5);
    uploadMiddleware(req, res, async (err) => {
        // 3. Catch Multer/Cloudinary errors IMMEDIATELY
        if (err) {
            return res.status(400).json({ message: err.message || "Failed to upload images to Cloudinary" });
        }
        try {
            const updatedProduct = await mongoose.connection.transaction(async session => {
                const product = await Product.findById(req.params.id).select('+restockSubscribers').session(session);
                if (!product) return null;
                const previousStock = product.stock;

                const { name, description, price, category, stock, tags, existingImages } = req.body;

                const newImageUrls = req.files ? req.files.map(file => file.path) : [];
                const parsedExistingImages = existingImages ? JSON.parse(existingImages) : [];

                const combinedImages = [...parsedExistingImages, ...newImageUrls];

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

                if (combinedImages.length > 0) {
                    product.images = combinedImages;
                } else if (existingImages === "[]" && newImageUrls.length === 0) {
                    product.images = [];
                }

                if (product.stock > previousStock) await queueRestockAlerts(product, session);
                await product.save({ session });
                const response = product.toObject();
                delete response.restockSubscribers;
                return response;
            });
            if (!updatedProduct) return res.status(404).json({ message: 'Product not found' });
            res.json(updatedProduct);
        } catch (error) {
            res.status(400).json({ message: error.message || 'Error updating product' });
        }
    });
});

router.delete('/:id', protect, shopkeeperAndAbove, async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        if (product.images && product.images.length > 0) {
            for (const imageUrl of product.images) {
                try {
                    const public_id = imageUrl
                        .substring(imageUrl.indexOf('charming_products'))
                        .split('.')[0];

                    cloudinary.uploader.destroy(public_id, { invalidate: true }).then(result => {
                        if (result.result !== 'ok') {
                            console.error("Cloudinary deletion failed for:", imageUrl, result);
                        }
                        else {
                            console.log("Cloudinary deletion successful for:", result);
                        }
                    });
                } catch (imgError) {
                    console.error("Cloudinary deletion failed for:", imageUrl, imgError);
                }
            }
        }

        await Product.deleteOne({ _id: req.params.id });
        res.json({ message: 'Product removed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Add a review
// @route   POST /api/products/:id/reviews
// @access  Private
router.post('/:id/reviews', protect, async (req, res) => {
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

router.put('/:id/reviews/:reviewId/toggle', protect, shopkeeperAndAbove, async (req, res) => {
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