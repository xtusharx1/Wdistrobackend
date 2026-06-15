process.on('uncaughtException', (err) => {
  console.error('⚠️ UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});
process.on('exit', (code) => {
  console.log(`🚪 PROCESS EXITED WITH CODE: ${code}`);
  console.log(new Error().stack);
});

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sequelize = require('./config/db');
require('./models');
const shopAuthRoutes = require('./routes/shopAuthRoutes');
const userAuthRoutes = require('./routes/userAuthRoutes');
const userRoutes = require('./routes/userRoutes');
const shopRoutes = require('./routes/shopRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const salesRoutes = require('./routes/salesRoutes');

const app = express();

app.use(cors());
app.use(express.json());

// Ensure uploads directory exists and serve it statically
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
app.use('/uploads', express.static(uploadsDir));

app.use('/auth/shop', shopAuthRoutes);
app.use('/auth/user', userAuthRoutes);
app.use('/users', userRoutes);
app.use('/shops', shopRoutes);
app.use('/products', productRoutes);
app.use('/orders', orderRoutes);
app.use('/invoices', invoiceRoutes);
app.use('/sales', salesRoutes);

const PORT = process.env.PORT || 3000;

sequelize.query("ALTER TYPE \"enum_Orders_status\" ADD VALUE IF NOT EXISTS 'cancelled'")
  .catch((err) => {
    console.log("Note: enum_Orders_status alter error (safe if already exists or non-Postgres):", err.message);
  })
  .then(() => sequelize.sync({ alter: true }))
  .then(() => {
    console.log("Database models synced successfully with { alter: true } ✅");
    if (require.main === module) {
      app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
      });
    }
  })
  .catch((err) => {
    console.error("Failed to sync database models ❌", err);
  });

module.exports = app;