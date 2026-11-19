import { paise } from '../utils/money.js';
import mongoose from 'mongoose';

const variationSchema = new mongoose.Schema({
    name: { type: String, required: true },
    options: [{ type: String, required: true }]
});

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    },
    pricePaise: Number,
    category: {
        type: String,
        required: true,
        enum: ['Electronics', 'Fragrances', 'Bags & Purses', 'Toys & Games', 'Home & Kitchen']
    },
    imageAssets: [{ _id: false, publicId: String, url: String }],
    images: [{
        type: String,
        required: true
    }],
    stock: {
        type: Number,
        required: true,
        default: 0
    },
    restockSubscribers: { type: [mongoose.Schema.Types.ObjectId], select: false, default: undefined },
    variations: [variationSchema],
    tags: [String],
    reviews: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: String,
        rating: Number,
        comment: String,
        isApproved: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    avgRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
}, {
    timestamps: true
});

productSchema.pre('validate', function () {
    if (this.price != null && (this.isModified('price') || this.pricePaise == null)) {
        const amount = paise(this.price);
        if (this.isModified('price') && amount / 100 !== this.price) {
            this.invalidate('price', 'Use at most two decimal places');
        }
        this.pricePaise = amount;
    }
});

const Product = mongoose.model('Product', productSchema);
export default Product;
