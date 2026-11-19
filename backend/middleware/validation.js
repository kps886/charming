const text = (max, min = 1) => v => typeof v === 'string' && v.length <= max && v.trim().length >= min;
const matches = re => v => typeof v === 'string' && re.test(v);
const oneOf = (...values) => v => values.includes(v);
const optional = check => v => v === undefined || check(v);
const nullable = check => v => v === null || check(v);
const boolean = v => typeof v === 'boolean';
const int = (min, max) => v => Number.isSafeInteger(v) && v >= min && v <= max;
const numericInput = check => v => (typeof v === 'number' || (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v))) && check(Number(v));
const price = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9 && Math.round(v * 100) / 100 === v;
const id = matches(/^[a-f\d]{24}$/i);
const password = v => typeof v === 'string' && v.length >= 6 && Buffer.byteLength(v) <= 72;
const email = v => text(254)(v) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const role = oneOf('admin','shopkeeper','employee','user');
const existingPassword = v => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const category = oneOf('Electronics','Fragrances','Bags & Purses','Toys & Games','Home & Kitchen');
const orderStatus = oneOf('pending','processing','shipped','delivered','cancelled');
const array = (check, min, max) => v => Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const partial = spec => Object.fromEntries(Object.entries(spec).map(([key, check]) => [key, optional(check)]));

function invalidField(value, spec) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'request';
    for (const key of Object.keys(value)) if (!Object.hasOwn(spec, key)) return key;
    for (const [key, check] of Object.entries(spec)) if (!check(value[key])) return key;
    return null;
}
const shape = spec => v => invalidField(v, spec) === null;
const address = { fullName: text(120), phone: text(30), line1: text(250), line2: optional(text(250,0)), city: text(120),
    state: text(120), pincode: text(16), country: optional(text(80)), isDefault: optional(boolean) };
const product = { name: text(180), description: text(10000), price: numericInput(price), category,
    stock: optional(numericInput(int(0,1e7))), tags: optional(text(1000,0)) };
const promo = { code: text(64), discountType: oneOf('flat','percent'), discountValue: v => price(v) && v >= 1,
    maxDiscountAmount: optional(nullable(price)), minOrderValue: optional(price), isActive: optional(boolean),
    expiresAt: optional(nullable(v => text(40)(v) && Number.isFinite(Date.parse(v)))), usageLimit: optional(nullable(int(1,1e9))) };
const pagination = { page: optional(numericInput(int(1,100000))), limit: optional(numericInput(int(1,100))) };
const quantity = int(1,100000);
export const schema = {
    register: { name: text(120), email, password }, login: { email, password: existingPassword },
    email: { email }, otp: { email, otp: matches(/^\d{6}$/) }, reset: { password },
    profile: partial({ name: text(120), email, currentPassword: existingPassword, password }),
    confirmEmail: { code: matches(/^[a-f0-9]{16}$/) },
    staff: { name: text(120), email, password, role }, staffEdit: partial({ name: text(120), role, isActive: boolean }),
    address, product, productEdit: partial({ ...product, existingImages: text(16384) }),
    review: { rating: int(1,5), comment: text(3000) }, moderation: { isApproved: optional(boolean) },
    promo, promoEdit: partial(promo), promoCheck: { code: text(64), subtotal: v => typeof v === 'number' && v > 0 && Number.isFinite(v) && v <= 1e12 },
    cart: { items: array(shape({ product: id, qty: quantity }),0,200) },
    checkout: { items: array(shape({ product: id, quantity }),1,200),
        shippingAddress: shape({ ...address, _id: optional(id) }), promoCode: optional(nullable(text(64))),
        attemptId: optional(matches(/^[\w-]{16,80}$/)) },
    verifyPayment: { orderId: id, razorpayOrderId: text(128), razorpayPaymentId: text(128), razorpaySignature: text(128) },
    status: { orderStatus, trackingNumber: optional(text(200,0)), cancelReason: optional(text(500,0)) },
    refund: { reference: text(120) }, resolution: { resolution: text(500) }, pagination,
    catalog: { ...pagination, limit: optional(numericInput(int(1,48))), sort: optional(oneOf('newest','oldest','price_asc','price_desc','name_asc','name_desc')),
        search: optional(text(120,0)), category: optional(text(100)), minPrice: optional(numericInput(price)), maxPrice: optional(numericInput(price)) },
    orders: { ...pagination, status: optional(v => orderStatus(v) || ['all','payment-review','needs-refund'].includes(v)) },
};

export const validate = (spec, source = 'body') => (req, res, next) => {
    const field = invalidField(req[source] ?? {}, spec);
    if (field !== null) return res.status(400).json({ message: 'Invalid or unexpected field: ' + field });
    next();
};

export function validateIds(router, names) {
    for (const name of names) router.param(name, (req, res, next, value) => {
        if (!id(value)) return res.status(400).json({ message: 'Invalid ' + name });
        next();
    });
}

export function parseProduct(upload, spec) {
    const multipart = upload.array('images', 5);
    return (req, res, next) => multipart(req, res, err => {
        if (err) return res.status(400).json({ message: err.message });
        validate(spec)(req, res, next);
    });
}
