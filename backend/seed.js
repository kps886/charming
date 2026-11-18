/**
 * Run this ONCE to create your first admin user:
 *   node seed.js
 *
 * Set ADMIN_EMAIL and ADMIN_PASSWORD before running.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from './models/User.js';

dotenv.config();

const seedAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        const adminExists = await User.findOne({ role: 'admin' });
        if (adminExists) {
            console.log('An admin user already exists:', adminExists.email);
            process.exit(0);
        }

        const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
        if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD before seeding');
        const admin = await User.create({
            name: 'Admin',
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD,
            role: 'admin',
            isVerified: true,
            unverifiedExpireAt: null,
        });

        console.log('✅ Admin user created successfully!');
        console.log(`   Email:    ${admin.email}`);
        process.exit(0);
    } catch (error) {
        console.error('Error seeding admin:', error.message);
        process.exit(1);
    }
};

seedAdmin();
