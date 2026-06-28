import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import toast from 'react-hot-toast';

const EyeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
);

const EyeOffIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>
);

const LoginPage = () => {
    const [isLogin, setIsLogin] = useState(true);
    const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
    const [rememberMe, setRememberMe] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    const { login, register, loading, isLoggedIn, user } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (isLoggedIn && user) {
            navigate(getDashboardPath(user.role), { replace: true });
        }
    }, [isLoggedIn, user, navigate]);

    const getDashboardPath = (role) => {
        switch (role) {
            case 'admin': return '/admin';
            case 'shopkeeper': return '/shopkeeper';
            case 'employee': return '/employee';
            default: return '/';
        }
    };

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!isLogin && formData.password !== formData.confirmPassword) {
            toast.error('Passwords do not match')
            return;
        }

        let result;
        if (isLogin) {
            result = await login(formData.email, formData.password);
        } else {
            result = await register(formData.name, formData.email, formData.password);
        }

        if (result.success) {
            if (result.requiresVerification) {
                toast.success('Check your email for the verification code!');
                navigate('/verify-email', { state: { email: result.email } });
            } else {
                toast.success('Welcome back!');
                navigate(getDashboardPath(result.role), { replace: true });
            }
        }
        else {
            if (result.requiresVerification) {
                toast.error('Please verify your email before logging in.');
                navigate('/verify-email', { state: { email: result.email } });
            } else {
                toast.error(result.error || result.message || 'Authentication failed');
            }
        }
    };

    const switchMode = () => {
        setIsLogin(!isLogin);
        setFormData({ name: '', email: '', password: '', confirmPassword: '' });
    };

    return (
        // 1. Dynamic Background Container
        <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden bg-primary-bg">

            <div className="w-full max-w-md relative z-10">
                {/* Logo Area */}
                <div className="text-center mb-8">
                    <h1 className="text-5xl font-serif text-accent-gold" >
                        Charming
                    </h1>
                    <p className="text-text-secondary mt-2 tracking-wider text-sm uppercase font-semibold">
                        Curated collections of luxury and style
                    </p>
                </div>

                {/* 3. Dynamic Card */}
                <div className="bg-secondary-bg border border-border-color p-8 rounded-2xl shadow-2xl relative overflow-hidden">

                    {/* Subtle inner glow for the card */}
                    <div className="absolute top-0 left-0 w-full h-1" style={{ background: 'linear-gradient(90deg, transparent, var(--accent-gold), transparent)', opacity: 0.5 }} />

                    <h2 className="text-3xl font-serif text-center mb-8 text-text-primary">
                        {isLogin ? 'Login' : 'Create Account'}
                    </h2>

                    <form onSubmit={handleSubmit} className="space-y-5">
                        {!isLogin && (
                            <div className="relative">
                                {/* User Icon */}
                                <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                                <input
                                    type="text"
                                    name="name"
                                    required={!isLogin}
                                    value={formData.name}
                                    onChange={handleChange}
                                    placeholder="Full Name"
                                    className="w-full pl-12 pr-4 py-3 bg-primary-bg border border-border-color rounded-xl text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent-gold focus:ring-4 focus:ring-accent-gold/10 transition-colors"
                                />
                            </div>
                        )}

                        <div className="relative">
                            {/* Email Icon */}
                            <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            <input
                                type="email"
                                name="email"
                                required
                                value={formData.email}
                                onChange={handleChange}
                                placeholder="Email Address"
                                className="w-full pl-12 pr-4 py-3 bg-primary-bg border border-border-color rounded-xl text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent-gold focus:ring-4 focus:ring-accent-gold/10 transition-colors"
                            />
                        </div>

                        <div className="relative">
                            {/* Lock Icon */}
                            <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                            <input
                                type={showPassword ? "text" : "password"}
                                name="password"
                                required
                                value={formData.password}
                                onChange={handleChange}
                                placeholder="Password"
                                className="w-full pl-12 pr-4 py-3 bg-primary-bg border border-border-color rounded-xl text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent-gold focus:ring-4 focus:ring-accent-gold/10 transition-colors"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-text-secondary hover:text-accent-gold transition-colors focus:outline-none"
                            >
                                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                            </button>
                        </div>

                        {!isLogin && (
                            <div className="relative">
                                <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                                <input
                                    type={showConfirmPassword ? "text" : "password"}
                                    name="confirmPassword"
                                    required={!isLogin}
                                    value={formData.confirmPassword}
                                    onChange={handleChange}
                                    placeholder="Confirm Password"
                                    className="w-full pl-12 pr-12 py-3 bg-primary-bg border border-border-color rounded-xl text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent-gold focus:ring-4 focus:ring-accent-gold/10 transition-colors"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-text-secondary hover:text-accent-gold transition-colors focus:outline-none"
                                >
                                    {showConfirmPassword ? <EyeOffIcon /> : <EyeIcon />}
                                </button>
                            </div>
                        )}

                        {isLogin && (
                            <div className="flex items-center justify-between text-sm mt-2 px-1">
                                <label className="flex items-center gap-2 text-text-secondary cursor-pointer hover:text-text-primary transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={rememberMe}
                                        onChange={(e) => setRememberMe(e.target.checked)}
                                        className="w-4 h-4 cursor-pointer rounded border-border-color bg-primary-bg"
                                        style={{ accentColor: 'var(--accent-gold)' }}
                                    />
                                    <span>Remember me</span>
                                </label>

                                <Link to="/forgot-password" className="text-accent-gold hover:underline transition-colors">
                                    Forgot password?
                                </Link>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-accent-gold text-primary-bg font-bold py-3 rounded-xl hover:-translate-y-0.5 hover:bg-yellow-500 hover:shadow-[0_0_15px_rgba(212,175,55,0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none mt-4 text-base uppercase tracking-wider"
                        >
                            {loading ? 'Please wait...' : (isLogin ? 'Login' : 'Register')}
                        </button>
                    </form>

                    <div className="mt-8 text-center text-sm text-text-secondary">
                        {isLogin ? "Don't have an account?" : 'Already have an account?'}
                        <button
                            onClick={switchMode}
                            className="ml-2 font-bold text-accent-gold hover:underline transition-colors"
                        >
                            {isLogin ? 'Register' : 'Login'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LoginPage;