import mongoose from 'mongoose';

export const FREE_SHIPPING_SUBTOTAL = 500;
const FLAT_DELIVERY_FEE      = 50;   // fee when below threshold

const orderItemSchema = new mongoose.Schema({
    product:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name:     { type: String, required: true },
    image:    { type: String },
    price:    { type: Number, required: true },
    pricePaise: Number,
    returnedSellable: Number,
    returnedDamaged: Number,
    quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const orderSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    items: [orderItemSchema],

    shippingAddress: {
        fullName: { type: String, required: true },
        phone:    { type: String, required: true },
        line1:    { type: String, required: true },
        line2:    { type: String, default: '' },
        city:     { type: String, required: true },
        state:    { type: String, required: true },
        pincode:  { type: String, required: true },
        country:  { type: String, default: 'India' },
    },

    // Pricing breakdown (all in ₹)
    subtotal:    { type: Number, required: true },   // sum of item prices
    deliveryFee: { type: Number, required: true },   // 50 or 0
    discount:    { type: Number, default: 0 },       // from promo code
    total:       { type: Number, required: true },   // subtotal + deliveryFee - discount

    promoCode:     { type: String, default: null },
    promoHold: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode' },
    promoDiscount: { type: Number, default: 0 },

    subtotalPaise: Number,
    deliveryFeePaise: Number,
    discountPaise: Number,
    totalPaise: Number,
    legacyAttemptKey: { type: String, select: false },
    checkoutFingerprint: { type: String, select: false },
    gatewayLeaseUntil: { type: Date, select: false },
    holdExpiredAt: Date,
    captureReview: String,
    authorizedPaymentId: String,
    reservationExpiresAt: { type: Date, index: true },

    paymentMethod: {
        type: String,
        enum: ['razorpay'],
        default: 'razorpay',
    },
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'failed', 'refunded'],
        default: 'pending',
    },
    razorpayOrderId:   { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpaySignature: { type: String, default: null },
    refundReference: String,
    refundVerifiedAt: Date,
    refundCheck: { reference: String, status: String },
    returnState: String,
    returnReason: String,
    returnInspections: [{ _id: false, line: Number, sellable: Number, damaged: Number, reason: String, staff: mongoose.Schema.Types.ObjectId, at: Date }],
    shippedAt: Date,
    refundedAt: Date,
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt:            { type: Date, default: null },

    orderStatus: {
        type: String,
        enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
        default: 'pending',
    },
    trackingNumber: { type: String, default: null },
    deliveredAt:    { type: Date, default: null },
    cancelledAt:    { type: Date, default: null },
    cancelReason:   { type: String, default: null },
}, { timestamps: true });

orderSchema.statics.calcDeliveryFee = function (subtotal) {
    return subtotal >= FREE_SHIPPING_SUBTOTAL ? 0 : FLAT_DELIVERY_FEE;
};

const Order = mongoose.model('Order', orderSchema);
export default Order;