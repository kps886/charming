import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect, adminOnly, shopkeeperAndAbove } from '../middleware/authMiddleware.js';
import crypto from 'crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { queueAccountMail, deliverAccountMail } from '../utils/accountMail.js';
import { passwordResetMessage } from '../utils/emailService.js';

import { schema, validate, validateIds } from '../middleware/validation.js';
const router = express.Router();
validateIds(router, ["id","addressId","productId"]);

// Generate JWT
const generateToken = (user) => {
    return jwt.sign({ id: user.id, sv: user.sessionVersion ?? 0 }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '30d',
    });
};

function verificationMessage(email, code) {
    return { to: email, subject: 'Verify your Charming account', text: 'Your verification code is ' + code + '. It expires in ten minutes.' };
}

async function issueOtp(user, session) {
    user.otp = crypto.randomInt(100000, 1000000).toString();
    user.otpExpire = new Date(Date.now() + 600000);
    await user.save({ session });
    return queueAccountMail(user.id, 'verification', verificationMessage(user.email, user.otp), user.otpExpire, session);
}

async function verificationResponse(res, user, job, status) {
    const sent = await deliverAccountMail(job);
    if (!sent && user.otpResendCount > 0) {
        await User.updateOne({ _id: user.id, otp: user.otp, otpResendCount: { $gt: 0 } }, { $inc: { otpResendCount: -1 } });
    }
    return res.status(sent ? status : 503).json({ success: sent, requiresVerification: true, email: user.email,
        attemptsLeft: Math.max(0, 3 - user.otpResendCount),
        message: sent ? 'Check your email for your verification code.' : 'Email delivery is delayed. You can request another code on the verification page.' });
}

// @desc    Register a new user (public - always registers as 'user' role)
// @route   POST /api/users/register
// @access  Public
router.post('/register', validate(schema.register), async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please provide name, email and password' });
    }

    try {
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }

        const { user, job } = await mongoose.connection.transaction(async session => {
            const user = new User({ name, email, password, role: 'user' });
            return { user, job: await issueOtp(user, session) };
        });
        return await verificationResponse(res, user, job, 201);
    } catch (error) {
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// @desc    Login user
// @route   POST /api/users/login
// @access  Public
router.post('/login', validate(schema.login), async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Please provide email and password' });
    }

    try {
        const user = await User.findOne({ email });

        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (!user.isActive) {
            return res.status(403).json({ message: 'Your account has been deactivated. Contact admin.' });
        }

        if (!user.isVerified) {
            return res.status(403).json({ 
                message: 'Please verify your email before logging in.',
                requiresVerification: true,
                email: user.email 
            });
        }

        res.json({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            token: generateToken(user),
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error during login' });
    }
});

// @desc    Resend OTP
// @route   POST /api/users/resend-otp
// @access  Public
router.post('/resend-otp', validate(schema.email), async (req, res) => {
    try {
        const { email } = req.body;
        const outcome = await mongoose.connection.transaction(async session => {
            const user = await User.findOne({ email }).session(session);
            if (!user) return { error: 'User not found', status: 404 };
            if (user.isVerified) return { error: 'Account is already verified', status: 400 };
            if (!user.otpExpire || user.otpExpire <= new Date()) user.otpResendCount = 0;
            if (user.otpResendCount >= 3) return { error: 'Please wait until the current code expires before requesting another.', status: 429 };
            user.otpResendCount += 1;
            return { user, job: await issueOtp(user, session) };
        });
        if (outcome.error) return res.status(outcome.status).json({ message: outcome.error });
        return await verificationResponse(res, outcome.user, outcome.job, 200);
    } catch (error) {
        res.status(500).json({ message: 'Server error during OTP resend' });
    }
});

// @desc    Verify OTP
// @route   POST /api/users/verify-otp
// @access  Public
router.post('/verify-otp', validate(schema.otp), async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (typeof email !== 'string' || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        const user = await User.findOneAndUpdate(
            { email, otp, otpExpire: { $gt: new Date() }, isVerified: { $ne: true }, isActive: true },
            { $set: { isVerified: true }, $unset: { otp: 1, otpExpire: 1, unverifiedExpireAt: 1 } },
            { returnDocument: 'after' }
        );
        if (!user) return res.status(400).json({ message: 'Invalid or expired OTP' });

        // Log them in
        res.json({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            token: generateToken(user),
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error during verification' });
    }
});

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private (all authenticated users)
router.get('/profile', protect, async (req, res) => {
    const user = await User.findById(req.user._id).select('-password');
    if (user) {
        res.json(user);
    } else {
        res.status(404).json({ message: 'User not found' });
    }
});

// @desc    Update current user profile
// @route   PUT /api/users/profile
// @access  Private (all authenticated users)
function accountResponse(user) {
    return { _id: user._id, name: user.name, email: user.email, role: user.role,
        pendingEmail: user.pendingEmail || null, token: generateToken(user) };
}

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

router.put('/profile', protect, validate(schema.profile), async (req, res) => {
    const outcome = await mongoose.connection.transaction(async session => {
        const user = await User.findById(req.user._id).select('+resetPasswordToken +emailChangeHash').session(session);
        if (!user || user.sessionVersion !== req.user.sessionVersion) return { status: 401, message: 'Please sign in again' };
        const email = req.body.email?.trim().toLowerCase();
        const changingEmail = email && email !== user.email;
        if (changingEmail || req.body.password) {
            if (!req.body.currentPassword || !(await user.matchPassword(req.body.currentPassword))) {
                return { status: 403, message: 'Enter your current password to change your email or password' };
            }
        }
        if (changingEmail && await User.exists({ email }).session(session)) return { status: 409, message: 'That email is unavailable' };
        if (req.body.name) user.name = req.body.name;
        if (req.body.password) {
            user.password = req.body.password;
            user.sessionVersion += 1;
            user.set({ resetPasswordToken: undefined, resetPasswordExpire: undefined,
                pendingEmail: undefined, emailChangeHash: undefined, emailChangeExpires: undefined });
        }
        let job;
        if (changingEmail) {
            const code = crypto.randomBytes(8).toString('hex');
            user.pendingEmail = email;
            user.emailChangeHash = digest(code);
            user.emailChangeExpires = new Date(Date.now() + 600000);
            job = await queueAccountMail(user.id, 'email-change', { to: email, subject: 'Confirm your new Charming email',
                text: 'Paste this code in Account Details within ten minutes: ' + code }, user.emailChangeExpires, session);
        }
        await user.save({ session });
        return { user, job };
    });
    if (outcome.status) return res.status(outcome.status).json({ message: outcome.message });
    const sent = outcome.job ? await deliverAccountMail(outcome.job) : true;
    res.json({ ...accountResponse(outcome.user), message: outcome.job ? (sent ? 'Check your new email for the confirmation code.' :
        'Confirmation email delayed. Save your new email again to request a fresh code.') : 'Profile updated' });
});

router.post('/profile/confirm-email', protect, validate(schema.confirmEmail), async (req, res) => {
    const code = req.body.code;
    if (typeof code !== 'string' || !/^[a-f0-9]{16}$/.test(code)) return res.status(400).json({ message: 'Invalid confirmation code' });
    try {
        const updated = await mongoose.connection.transaction(async session => {
            const user = await User.findOne({ _id: req.user._id, emailChangeHash: digest(code),
                emailChangeExpires: { $gt: new Date() } }).select('+resetPasswordToken +emailChangeHash').session(session);
            if (!user || user.sessionVersion !== req.user.sessionVersion) return null;
            const previous = user.email;
            user.email = user.pendingEmail;
            user.sessionVersion += 1;
            user.set({ pendingEmail: undefined, emailChangeHash: undefined, emailChangeExpires: undefined,
                resetPasswordToken: undefined, resetPasswordExpire: undefined });
            await user.save({ session });
            await queueAccountMail(user.id, 'security', { to: previous, subject: 'Your Charming account email changed',
                text: 'Your sign-in email was changed. If you did not request this, contact Charming support.' },
                new Date(Date.now() + 86400000), session);
            return user;
        });
        if (!updated) return res.status(400).json({ message: 'Code expired or incorrect. Request a fresh code.' });
        res.json(accountResponse(updated));
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: 'That email is unavailable' });
        throw err;
    }
});

// ── Wishlist ──────────────────────────────────────────────────

// @desc    Get current user's wishlist
// @route   GET /api/users/wishlist
// @access  Private
router.get('/wishlist', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id)
            .populate('wishlist', 'name price images stock tags category');
        res.json(user.wishlist || []);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching wishlist' });
    }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

// @desc    Get all users
// @route   GET /api/users
// @access  Private/Admin
router.get('/', protect, adminOnly, validate(schema.pagination, 'query'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [users, total] = await Promise.all([
            User.find({}).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit),
            User.countDocuments({})
        ]);

        res.json({ users, page, pages: Math.ceil(total / limit), total });
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching users' });
    }
});

// @desc    Create a user with a specific role (admin, shopkeeper, employee)
// @route   POST /api/users/create
// @access  Private/Admin
router.post('/create', protect, adminOnly, validate(schema.staff), async (req, res) => {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
        return res.status(400).json({ message: 'Please provide name, email, password and role' });
    }

    const validRoles = ['admin', 'shopkeeper', 'employee', 'user'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ message: 'Invalid role specified' });
    }

    try {
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }

        const user = await User.create({ name, email, password, role, isVerified: true, unverifiedExpireAt: null });

        res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            token: generateToken(user),
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error creating user' });
    }
});

// @desc    Get single user by ID
// @route   GET /api/users/:id
// @access  Private/Admin
router.get('/:id', protect, adminOnly, async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (user) {
            res.json(user);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// @desc    Update any user's role/status (admin only)
// @route   PUT /api/users/:id
// @access  Private/Admin
router.put('/:id', protect, adminOnly, validate(schema.staffEdit), async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.name = req.body.name || user.name;
        user.role = req.body.role || user.role;
        if (typeof req.body.isActive === 'boolean') user.isActive = req.body.isActive;

        const updatedUser = await user.save();
        res.json({
            _id: updatedUser._id,
            name: updatedUser.name,
            email: updatedUser.email,
            role: updatedUser.role,
            isActive: updatedUser.isActive,
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error updating user' });
    }
});

// @desc    Delete a user
// @route   DELETE /api/users/:id
// @access  Private/Admin
router.delete('/:id', protect, adminOnly, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Prevent admin from deleting themselves
        if (user._id.toString() === req.user._id.toString()) {
            return res.status(400).json({ message: 'Cannot delete your own account' });
        }

        await User.deleteOne({ _id: req.params.id });
        res.json({ message: 'User removed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server error deleting user' });
    }
});

// ── Address management ────────────────────────────────────────

// @desc    Add a new address
// @route   POST /api/users/addresses
// @access  Private
router.post('/addresses', protect, validate(schema.address), async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const { fullName, phone, line1, line2, city, state, pincode, country, isDefault } = req.body;

        // If new address is default, unset all others
        if (isDefault) {
            user.addresses.forEach(a => { a.isDefault = false; });
        }

        // If it's the first address, make it default automatically
        const makeDefault = isDefault || user.addresses.length === 0;

        user.addresses.push({ fullName, phone, line1, line2, city, state, pincode, country, isDefault: makeDefault });
        await user.save();

        res.status(201).json(user.addresses);
    } catch (err) {
        res.status(500).json({ message: 'Error adding address' });
    }
});

// @desc    Set an address as default
// @route   PUT /api/users/addresses/:addressId/default
// @access  Private
router.put('/addresses/:addressId/default', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.addresses.forEach(a => {
            a.isDefault = a._id.toString() === req.params.addressId;
        });
        await user.save();

        res.json(user.addresses);
    } catch (err) {
        res.status(500).json({ message: 'Error updating address' });
    }
});

// @desc    Delete an address
// @route   DELETE /api/users/addresses/:addressId
// @access  Private
router.delete('/addresses/:addressId', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const idx = user.addresses.findIndex(a => a._id.toString() === req.params.addressId);
        if (idx === -1) return res.status(404).json({ message: 'Address not found' });

        const wasDefault = user.addresses[idx].isDefault;
        user.addresses.splice(idx, 1);

        // If deleted address was default, make first remaining address default
        if (wasDefault && user.addresses.length > 0) {
            user.addresses[0].isDefault = true;
        }

        await user.save();
        res.json(user.addresses);
    } catch (err) {
        res.status(500).json({ message: 'Error deleting address' });
    }
});



// @desc    Toggle product in wishlist (add if absent, remove if present)
// @route   POST /api/users/wishlist/:productId
// @access  Private
router.post('/wishlist/:productId', protect, async (req, res) => {
    try {
        const user      = await User.findById(req.user._id);
        const productId = req.params.productId;
        const idx       = user.wishlist.findIndex(id => id.toString() === productId);

        if (idx === -1) {
            user.wishlist.push(productId);
        } else {
            user.wishlist.splice(idx, 1);
        }

        await user.save();
        res.json({ wishlisted: idx === -1, wishlist: user.wishlist });
    } catch (err) {
        res.status(500).json({ message: 'Error updating wishlist' });
    }
});

// @desc    Forgot Password
// @route   POST /api/users/forgotpassword
// @access  Public
router.post('/forgotpassword', validate(schema.email), async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Please provide an email address' });

    try {
        await mongoose.connection.transaction(async session => {
            const user = await User.findOne({ email }).session(session);
            if (!user) return;
            const resetToken = user.getResetPasswordToken();
            await user.save({ session });
            const url = process.env.FRONTEND_URL + '/reset-password/' + resetToken;
            await queueAccountMail(user.id, 'recovery', passwordResetMessage(user.email, url), user.resetPasswordExpire, session);
        });
        res.json({ message: 'If your account is eligible, check your inbox and spam folder. If the link does not arrive within ten minutes, request another.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// @desc    Reset Password
// @route   PUT /api/users/resetpassword/:token
// @access  Public
router.put('/resetpassword/:token', validate(schema.reset), async (req, res) => {
    try {
        if (!/^[a-f0-9]{40}$/.test(req.params.token)) return res.status(400).json({ message: 'Invalid reset token' });
        // Hash the token from the URL to compare it with the hashed token in DB
        const resetPasswordToken = crypto
            .createHash('sha256')
            .update(req.params.token)
            .digest('hex');

        if (typeof req.body.password !== 'string' || req.body.password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }
        const result = await User.updateOne({ resetPasswordToken, resetPasswordExpire: { $gt: new Date() } },
            { $set: { password: await bcrypt.hash(req.body.password, 10) }, $inc: { sessionVersion: 1 },
                $unset: { resetPasswordToken: 1, resetPasswordExpire: 1, pendingEmail: 1, emailChangeHash: 1, emailChangeExpires: 1 } });
        if (!result.modifiedCount) return res.status(400).json({ message: 'Invalid or expired password reset token' });

        res.status(200).json({ message: 'Password reset successful. Please log in.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;
