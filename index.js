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
const inventoryReceivingRoutes = require('./routes/inventoryReceivingRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const collectionRoutes = require('./routes/collectionRoutes');
const customerRoutes = require('./routes/customerRoutes');

const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

let dbSynced = false;

app.use((req, res, next) => {
  if (!dbSynced && (req.path.startsWith('/categories') || req.path.startsWith('/inventory-receiving') || req.path.startsWith('/collections'))) {
    return res.status(503).json({
      success: false,
      message: 'Database synchronization is in progress. Please reload in a few seconds.'
    });
  }
  next();
});

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
app.use('/inventory-receiving', inventoryReceivingRoutes);
app.use('/categories', categoryRoutes);
app.use('/collections', collectionRoutes);
app.use('/customers', customerRoutes);
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
      .then(() => sequelize.query('ALTER TABLE "Orders" ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT \'App\'').catch(() => {}))
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
        return sequelize.sync();
      })
      .then(async () => {
        console.log("Database models synced successfully ✅");
        
        // Idempotent seeding for Categories
        try {
          const { Category } = require('./models');
          const count = await Category.count();
          if (count === 0) {
            console.log('Seeding initial categories...');
            const initialCategories = [
              { category_name: 'General Merchandise', sub_categories: ['Cables', 'Toys', 'Misc', 'Clothing', 'Supplements', 'Medicine (OTC)'], display_order: 1, is_active: true },
              { category_name: 'Glass', sub_categories: ['Glass Rigs', 'Glass Accessories', 'Grinders'], display_order: 2, is_active: true },
              { category_name: 'Tobacco', sub_categories: ['Wraps', 'Cigars', 'Cigarillos', 'Rolling Tobacco', 'Chew/Pouches'], display_order: 3, is_active: true },
              { category_name: 'Lighters', sub_categories: ['Pocket Torches', 'High Flame', 'Butane', 'Torch Lighters'], display_order: 4, is_active: true },
              { category_name: 'Vape', sub_categories: ['Disposable', 'Hardware', 'Vape Accessories', 'Juices'], display_order: 5, is_active: true },
              { category_name: 'Rolling Papers', sub_categories: ['Papers', 'Rolling Machine', 'Tips', 'Cones'], display_order: 6, is_active: true }
            ];
            await Category.bulkCreate(initialCategories);
            console.log('Initial categories seeded successfully! ✅');
          }
        } catch (err) {
          console.error('Error seeding categories:', err);
        }

        // Idempotent seeding and one-time migration for ProductCollections
        try {
          const { ProductCollection, Product } = require('./models');
          const collCount = await ProductCollection.count();
          if (collCount === 0) {
            console.log('Seeding initial product collections...');
            const defaultCollections = [
              { name: 'Deals', is_active: true },
              { name: 'Clearance', is_active: true },
              { name: 'New Arrival', is_active: true },
              { name: 'Best Seller', is_active: true },
              { name: 'Weekly Specials', is_active: true }
            ];
            await ProductCollection.bulkCreate(defaultCollections);
            console.log('Initial product collections seeded successfully! ✅');
          }

          // Ensure Clearance collection exists
          const [clearanceCollection] = await ProductCollection.findOrCreate({
            where: { name: 'Clearance' },
            defaults: { is_active: true }
          });

          // Run one-time migration:
          // Migrate all products where is_clearance = true and product_collection_id IS NULL
          const unmigratedProducts = await Product.findAll({
            where: {
              is_clearance: true,
              product_collection_id: null
            }
          });

          if (unmigratedProducts.length > 0) {
            console.log(`Migrating ${unmigratedProducts.length} legacy clearance products to the Clearance collection...`);
            for (const p of unmigratedProducts) {
              p.product_collection_id = clearanceCollection.id;
              p.deal_price = p.clearance_price;
              await p.save();
            }
            console.log('Legacy clearance products migration completed successfully! ✅');
          }
        } catch (err) {
          console.error('Error seeding/migrating product collections:', err);
        }

        dbSynced = true;
        console.timeEnd('💾 Database Sync duration');
      })
      .catch((err) => {
        console.error("Failed to sync database models ❌", err);
      });
  });
}

module.exports = app;