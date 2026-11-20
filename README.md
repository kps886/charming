# Charming — Full Stack Shop Website

A complete e-commerce platform with a 4-tier role hierarchy, JWT authentication, and React frontend.

---

## 🗂 Project Structure

```
charming/
├── backend/          ← Express + MongoDB API
└── frontend/         ← React + Tailwind UI
```

---

## ⚡ Quick Start

### 1. Backend Setup

```bash
cd backend
npm install
```

Edit `.env`:
```
MONGO_URI=mongodb://127.0.0.1:27017/charming?replicaSet=rs0
PORT=5001
JWT_SECRET=change_this_to_a_long_random_string
JWT_EXPIRE=30d
```

Checkout uses MongoDB transactions. Use Atlas or an initialized replica set (local example above). Inventory reservations expire after 15 minutes. A payment captured after cancellation is recorded against the cancelled order for manual refund.

Run the backend regression suite with `npm test` from the backend directory. Set `TEST_MONGO_URI` to a disposable replica set to include the database and HTTP tests. The suite creates and removes its own database.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the backend environment before creating the first admin account:
```bash
node seed.js
```

Start the server:
```bash
npm run dev       # development (with nodemon)
npm start         # production
```

### 2. Frontend Setup

```bash
cd frontend
npm install
npm start
```

The app runs on `http://localhost:3000`. The proxy in `package.json` forwards `/api/*` to the backend at port 5001.

---

## 👥 Role Hierarchy

| Role | Level | What they can do |
|------|-------|-----------------|
| **Admin** | 4 (highest) | Everything — manage all users, assign roles, full product CRUD, view all dashboards |
| **Shopkeeper** | 3 | Create, edit, delete products. View inventory. Cannot manage users. |
| **Employee** | 2 | Update stock levels on existing products. View inventory alerts. |
| **User (End User)** | 1 (default) | Browse products, add to cart, checkout, leave reviews |

### Login → Dashboard Routing

After login, users are redirected automatically:
- Admin → `/admin`
- Shopkeeper → `/shopkeeper`
- Employee → `/employee`
- User → `/` (shop homepage)

---

## 🔐 API Endpoints

### Auth (Public)
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/users/register` | Register as end user |
| POST | `/api/users/login` | Login (any role) |

### User (Protected)
| Method | Route | Access |
|--------|-------|--------|
| GET | `/api/users/profile` | All logged-in users |
| PUT | `/api/users/profile` | All logged-in users |
| GET | `/api/users` | Admin only |
| POST | `/api/users/create` | Admin only |
| PUT | `/api/users/:id` | Admin only |
| DELETE | `/api/users/:id` | Admin only |

### Products
| Method | Route | Access |
|--------|-------|--------|
| GET | `/api/products` | Public |
| GET | `/api/products/:id` | Public |
| POST | `/api/products` | Shopkeeper + Admin |
| PUT | `/api/products/:id` | Employee + Shopkeeper + Admin |
| DELETE | `/api/products/:id` | Shopkeeper + Admin |
| POST | `/api/products/:id/reviews` | Any logged-in user |

---

## 🚀 Deployment

### Option A: Deploy on a VPS (Ubuntu)

**Backend:**
```bash
# Install Node.js, MongoDB
sudo apt install nodejs npm mongodb

# Install PM2 for process management
npm install -g pm2

cd backend
npm install
pm2 start server.js --name charming-api
pm2 save
```

**Frontend:**
```bash
cd frontend
npm run build
# Serve the build/ folder via Nginx
```

**Nginx config example:**
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Serve React build
    root /var/www/charming/frontend/build;
    index index.html;

    # API proxy
    location /api/ {
        proxy_pass http://localhost:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # React Router fallback
    location / {
        try_files $uri /index.html;
    }
}
```

### Option B: Cloud Deployment

**Backend → Railway / Render:**
- Push backend folder to a Git repo
- Set environment variables: `MONGO_URI`, `JWT_SECRET`, `PORT`
- Deploy as a Node.js web service

**Frontend → Vercel / Netlify:**
- Push frontend folder to a Git repo  
- Set build command: `npm run build`
- Set output directory: `build`
- Add environment variable: `REACT_APP_API_URL=https://your-backend-url.com`

Then update frontend to use the env variable in API calls.

**MongoDB → MongoDB Atlas (free tier):**
- Create cluster at mongodb.com/atlas
- Get connection string and set as `MONGO_URI`

---

## 🔧 Environment Variables

### Backend `.env`
```
MONGO_URI=           # MongoDB connection string
PORT=5001            # Server port
JWT_SECRET=          # Long random string (32+ chars)
JWT_EXPIRE=30d       # Token expiry
```

---

## 📦 Tech Stack

**Backend:**
- Express.js 5
- MongoDB + Mongoose
- JWT (jsonwebtoken)
- bcryptjs (password hashing)

**Frontend:**
- React 19
- React Router v7
- Axios
- Tailwind CSS

---

## 🔑 First Time Setup Checklist

- [ ] Clone/copy project files
- [ ] `cd backend && npm install`
- [ ] Edit `.env` with your MongoDB URI and a strong JWT_SECRET
- [ ] `node seed.js` to create admin user
- [ ] `cd frontend && npm install`
- [ ] `npm start` in both folders
- [ ] Log in with the admin credentials used during seeding.
- [ ] Change admin password immediately via profile
- [ ] Create shopkeeper and employee accounts via Admin Dashboard

## Checkout rollout and historical prices

Deploy the API and storefront together. The updated storefront supplies a checkout attempt ID. Older clients reuse an active reservation for the same buyer, basket and address. Refresh older clients to receive the updated payment confirmation UI.
Enable the signed Razorpay `payment.captured` event. A signed browser callback triggers a server-side payment fetch.
If a verified capture arrives after a hold expires and its time is unknown, staff can find the order under **Payment review**.
The signed capture event can resolve it automatically. Staff should use the payment reference to verify unresolved cases in Razorpay before arranging any refund.

New order snapshots store integer paise for each unit price, subtotal, delivery fee, discount, and total.
The rupee fields remain available to existing API consumers. For older orders:

1. Back up the database and run the comparison on a restored copy first.
2. Rebuild the historical payable amount from purchased quantities and unit prices, the original delivery fee and recorded discount. Apply the original ₹1 minimum and round the final charge to paise. Multiplying a rounded historical total by 100 can lose the original fractional part.
3. Match that amount, currency, and gateway order ID against Razorpay. For paid/refunded orders also match the payment and refund references. Set aside missing records and mismatches for manual review.
4. In small restartable batches, populate the paise fields and their rupee projections only for verified rows missing `totalPaise`. Keep before/after totals and compare receipts, reporting and refunds before applying the same process to production. Existing pending checkouts use their original item snapshots for capture validation in the meantime.

## Daily payment reconciliation

Open **Orders → Payment reconciliation** in the admin or shopkeeper dashboard. Staff can see the last completed day, open discrepancies and gateway references. Recording a resolution saves the staff member, time and explanation. It does not initiate a refund or change fulfillment.

While the API is running, the worker checks every five minutes for a completed UTC day to process. On first startup it starts with yesterday. Set `RECONCILIATION_START_DATE=YYYY-MM-DD` before first startup to backfill from an earlier day. The MongoDB checkpoint advances only after payments, refunds and the settlement report all succeed. Razorpay credentials need read access to each of those reports. Settlement comparisons use the gross transaction amount in paise. [Razorpay settlement report](https://razorpay.com/docs/api/settlements/fetch-recon/)

## Account mail and product images

Account verification, email changes and recovery use the configured SMTP transport. The API worker retries eligible delivery failures while the code or link is valid. The `accountmails` collection records the purpose, attempt count, delivery state and failure code for 30 days. Queued message bodies are encrypted. Set the same high-entropy `ACCOUNT_MAIL_KEY` on every API instance, or the worker derives its key from `JWT_SECRET`. Keep that key stable while mail is queued.

Product images require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET`. Staff can upload JPEG, PNG or WebP files up to 5 MiB each. Removed assets are queued in the same MongoDB transaction as the catalog change and retried by the API worker.

The image integration test normally uses a local Cloudinary double. To exercise the same create, replace and delete requests against a dedicated staging cloud, set `TEST_MONGO_URI` to a disposable replica set and provide `TEST_CLOUDINARY_CLOUD_NAME`, `TEST_CLOUDINARY_API_KEY` and `TEST_CLOUDINARY_API_SECRET`. From the repository root run `node --test --test-name-pattern="uploads, replaces" backend/test/checkout.test.js`.

## Checkout and fulfillment rules

- Cart and checkout request a server quote. The current storefront submits the reviewed quote ID when reserving an order. A changed quote requires a second payment click. Shipping is free from ₹500 of merchandise before discounts. The minimum payable amount is ₹1.
- Promo uses are held alongside stock and released on expiry or unpaid cancellation. A fulfilled purchase consumes its use permanently, including when it is later cancelled or returned. During rollout, pending orders created by older API versions acquire a promo use at capture. A capture that can no longer fulfill is flagged for refund review.
- Employees can correct stock with the original count and a reason. Catalog edits and returns require a shopkeeper or admin. A stale correction returns HTTP 409. Successful corrections record the staff ID, reason, and before/after quantities.
- Capture moves an order to processing. Staff can ship a processing order and deliver a shipped order. Shopkeepers and admins can cancel before delivery with a reason. Cancelling an unshipped paid order restores its allocated stock once. Cancelling in transit opens a return. Delivered orders keep their delivery date when a manager opens a return.
- Staff record cumulative sellable and damaged quantities for each returned line. Only newly received sellable units go back on sale. Historical cancellations with unknown stock movements require a physical stock check before a correction.
- A full refund is verified against Razorpay's refund ID, payment ID, INR amount and processed status. Previous manually recorded refunds appear in **Needs refund** for verification. Staff can retry a pending or failed check from the order. [Razorpay refund fields](https://razorpay.com/docs/api/refunds/fetch-with-id/)

The [database recovery runbook](backend/RECOVERY.md) includes the measured local restore drill and the steps for a production backup rehearsal.
