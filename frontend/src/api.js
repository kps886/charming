import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5001"
});

api.interceptors.request.use(
    (config) => {        
        const stored = localStorage.getItem('charmingUser');
        if (stored) {
            const parsedUser = JSON.parse(stored);
            if (parsedUser.token) {
                config.headers = config.headers || {};
                config.headers.Authorization = `Bearer ${parsedUser.token}`;
            }
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const isLoginRequest = error.config && error.config.url && error.config.url.includes('/login');
        if (error.response && error.response.status === 401 && !isLoginRequest) {
            console.warn("Session expired. Logging out.");
            localStorage.removeItem('charmingUser');
            window.location.href = '/login'; 
        }
        return Promise.reject(error);
    }
);

export default api;