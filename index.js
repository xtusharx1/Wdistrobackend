console.time('🔄 Total Startup Time');
console.time('📦 Imports and Model Loading');

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
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const sequelize = require('./config/db');
require('./models');
console.timeEnd('📦 Imports and Model Loading');

console.time('🛣️ Route Registration');
const shopAuthRoutes = require('./routes/shopAuthRoutes');
const userAuthRoutes = require('./routes/userAuthRoutes');
const userRoutes = require('./routes/userRoutes');
const shopRoutes = require('./routes/shopRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const salesRoutes = require('./routes/salesRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const permitRoutes = require('./routes/permitRoutes');
const draftOrderRoutes = require('./routes/draftOrderRoutes');
const variationGroupRoutes = require('./routes/variationGroupRoutes');

const app = express();

app.use(compression());
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
app.use('/dashboard', dashboardRoutes);
app.use('/permits', permitRoutes);
app.use('/drafts', draftOrderRoutes);
app.use('/variation-groups', variationGroupRoutes);
console.timeEnd('🛣️ Route Registration');

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  console.time('🚀 Express Server Listen');
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.timeEnd('🚀 Express Server Listen');
    console.timeEnd('🔄 Total Startup Time');

    // Run database sync asynchronously in the background so it doesn't block server startup
    console.log("Database sync started asynchronously in the background...");
    console.time('💾 Database Sync duration');
    sequelize.query("ALTER TYPE \"enum_Orders_status\" ADD VALUE IF NOT EXISTS 'cancelled'")
      .catch((err) => {
        console.log("Note: enum_Orders_status alter error (safe if already exists or non-Postgres):", err.message);
      })
      // Migrate ShopPermits.permit_type from ENUM to VARCHAR so new permit types
      // can be added without a database migration in the future.
      .then(() => sequelize.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM pg_attribute a
            JOIN pg_class c ON a.attrelid = c.oid
            JOIN pg_type t ON a.atttypid = t.oid
            WHERE c.relname = 'ShopPermits'
              AND a.attname = 'permit_type'
              AND t.typtype = 'e'
          ) THEN
            ALTER TABLE "ShopPermits"
              ALTER COLUMN permit_type TYPE VARCHAR(255)
              USING permit_type::text;
            DROP TYPE IF EXISTS "enum_ShopPermits_permit_type";
          END IF;
        END $$;
      `).catch((err) => {
        console.log("Note: ShopPermits permit_type migration note (safe):", err.message);
      }))
      .then(() => {
        return sequelize.sync({ alter: true });
      })
      .then(() => {
        console.log("Database models synced successfully with { alter: true } ✅");
        console.timeEnd('💾 Database Sync duration');
      })
      .catch((err) => {
        console.error("Failed to sync database models ❌", err);
      });
  });
}

module.exports = app;