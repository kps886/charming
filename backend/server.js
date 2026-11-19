import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import mongoose from 'mongoose';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import productRoutes from './routes/productRoutes.js';
import userRoutes from './routes/userRoutes.js';
import orderRoutes, { razorpay } from './routes/orderRoutes.js';
import promoRoutes from './routes/promoRoutes.js';
import analyticRoutes from './routes/analyticsRoutes.js';
import { deliverRestockAlerts } from './utils/restockAlerts.js';
import { expireReservations } from './utils/orderInventory.js';
import { retryAccountMail } from './utils/accountMail.js';
import { cleanImages } from './middleware/uploadMiddleware.js';
import { runReconciliation } from './utils/reconciliation.js';
import cartRoutes from './routes/cartRoutes.js';

dotenv.config();

const app = express();

app.use(helmet())
const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
app.set('trust proxy', 1);
const apiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, 
    max: 100, 
    message: { message: 'Too many requests from this IP, please try again after 10 minutes.' }
});

// Strict Rate Limiting for Auth routes (Login/Register/OTP): Max 10 attempts per 10 mins
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: { message: 'Too many login attempts. Please try again later.' }
});
app.use(express.json({
    verify: (req, res, buf) => {
        if (req.path.toLowerCase().replace(/\/$/, '') === '/api/orders/webhook') req.rawBody = buf;
    }
}));

app.use((req, res, next) => {
    if (!req.rawBody && req.body && mongoSanitize.has(req.body)) return res.status(400).json({ message: 'Unsupported request field' });
    next();
});

// Connect to MongoDB
const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

async function sweepReservations() {
    try {
        await expireReservations();
    } catch (err) {
        console.error('Reservation expiry failed:', err.message);
    } finally {
        setTimeout(sweepReservations, 60000).unref();
    }
}

async function processQueues() {
    try {
        await Promise.all([deliverRestockAlerts(), cleanImages(), retryAccountMail()]);
    } catch (err) {
        console.error('Background queue failed:', err.message);
    } finally {
        setTimeout(processQueues, 60000).unref();
    }
}
connectDB().then(() => {
    async function reconcile() {
        try { await runReconciliation(razorpay); }
        catch { console.error('Daily payment reconciliation failed'); }
        finally { setTimeout(reconcile, 5 * 60000).unref(); }
    }
    reconcile();
    sweepReservations();
    processQueues();
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'API is running...', timestamp: new Date().toISOString() });
});

// Routes
const authPaths = ['login', 'register', 'resend-otp', 'verify-otp', 'forgotpassword', 'resetpassword', 'profile/confirm-email'];
app.use(authPaths.map(path => '/api/users/' + path), authLimiter);
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/products', apiLimiter, productRoutes);
app.use('/api/orders', apiLimiter, orderRoutes);
app.use('/api/promo', apiLimiter, promoRoutes);
app.use('/api/analytics', apiLimiter, analyticRoutes);
app.use('/api/cart', apiLimiter, cartRoutes);


// 404 handler
app.use((req, res) => {
    res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// Error handler
app.use((err, req, res, next) => {
    const statusCode = err.status || (res.statusCode === 200 ? 500 : res.statusCode);
    res.status(statusCode).json({
        message: err.message || 'Internal Server Error',
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
