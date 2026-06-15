const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op } = require('sequelize');
const Product = require('../models/Product');
const Shop = require('../models/Shop');

const router = express.Router();

// Initialize AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

// Configure Multer S3 storage
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET || 'wdistro',
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, 'products/' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Only images (jpg, jpeg, png, webp) are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Upload product image
router.post('/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('S3 Upload Error:', err);
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    return res.json({
      success: true,
      message: 'Image uploaded successfully',
      data: { image_url: req.file.location }
    });
  });
});

// Create product
router.post('/', async (req, res) => {
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id } = req.body;
  if (!name || price === undefined || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, and stock_quantity are required' });
  }

  const mainCat = mainCategory || main_category || 'General Merchandise';
  const subCat = subCategory || sub_category || 'Misc';
  const reqLicense = requiredLicense || required_license || ((mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit');

  try {
    const product = await Product.create({
      name,
      price,
      purchase_cost,
      category: category || subCat,
      main_category: mainCat,
      sub_category: subCat,
      required_license: reqLicense,
      stock_quantity,
      image_url,
      sku_id
    });
    return res.status(201).json({ success: true, message: 'Product created successfully', data: { product } });
  } catch (err) {
    console.error('Error creating product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create multiple products (Bulk Creation)
router.post('/bulk', async (req, res) => {
  const productsInput = req.body;

  if (!Array.isArray(productsInput) || productsInput.length === 0) {
    return res.status(400).json({ success: false, message: 'Request body must be a non-empty array of products' });
  }

  // Validate each product in the array
  for (let i = 0; i < productsInput.length; i++) {
    const { name, price, stock_quantity } = productsInput[i];
    if (!name || price === undefined || stock_quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: `Product at index ${i} is missing required fields (name, price, stock_quantity)`
      });
    }
  }

  try {
    const createdProducts = await Product.bulkCreate(
      productsInput.map(p => {
        const mainCat = p.mainCategory || p.main_category || 'General Merchandise';
        const subCat = p.subCategory || p.sub_category || 'Misc';
        const reqLicense = p.requiredLicense || p.required_license || ((mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit');
        return {
          name: p.name,
          sku_id: p.sku_id || null,
          price: p.price,
          purchase_cost: p.purchase_cost !== undefined ? p.purchase_cost : null,
          category: p.category || subCat,
          main_category: mainCat,
          sub_category: subCat,
          required_license: reqLicense,
          stock_quantity: p.stock_quantity,
          image_url: p.image_url || null
        };
      })
    );
    return res.status(201).json({ success: true, message: `${createdProducts.length} products created successfully`, data: { products: createdProducts } });
  } catch (err) {
    console.error('Error bulk creating products:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get products
router.get('/', async (req, res) => {
  try {
    const { page, limit, search } = req.query;
    const shopId = req.headers['x-shop-id'];

    const whereClause = {};
    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
    }

    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        const allowedLicenses = [];
        if (shop.seller_permit_active) {
          allowedLicenses.push('Seller Permit');
        }
        if (shop.tobacco_license_active) {
          allowedLicenses.push('Tobacco License');
        }
        whereClause.required_license = { [Op.in]: allowedLicenses };
      }
    }

    const options = {
      where: whereClause,
      order: [['created_at', 'DESC']]
    };

    if (limit) {
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit);
      options.limit = limitNum;
      options.offset = (pageNum - 1) * limitNum;
    }

    const { count, rows: products } = await Product.findAndCountAll(options);
    const userRole = req.headers['x-user-role'];
    const sanitizedProducts = products.map(product => {
      const p = product.toJSON();
      if (userRole !== 'Admin') {
        delete p.purchase_cost;
      }
      return p;
    });

    return res.json({ 
      success: true, 
      message: 'Products fetched successfully', 
      data: { 
        products: sanitizedProducts,
        pagination: {
          total: count,
          page: limit ? parseInt(page || 1) : 1,
          limit: limit ? parseInt(limit) : count,
          totalPages: limit ? Math.ceil(count / limit) : 1
        }
      } 
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get product by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const shopId = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (shopId) {
      const shop = await Shop.findByPk(shopId);
      if (shop) {
        if (product.required_license === 'Seller Permit' && !shop.seller_permit_active) {
          return res.status(403).json({ success: false, message: 'Seller Permit Required for this product category.' });
        }
        if (product.required_license === 'Tobacco License' && !shop.tobacco_license_active) {
          return res.status(403).json({ success: false, message: 'Tobacco License Required for this product category.' });
        }
      }
    }

    const p = product.toJSON();
    if (userRole !== 'Admin') {
      delete p.purchase_cost;
    }

    return res.json({ success: true, message: 'Product fetched successfully', data: { product: p } });
  } catch (err) {
    console.error('Error fetching product details:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update product
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, purchase_cost, category, main_category, mainCategory, sub_category, subCategory, required_license, requiredLicense, stock_quantity, image_url, sku_id } = req.body;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (name) product.name = name;
    if (sku_id !== undefined) product.sku_id = sku_id;
    if (price !== undefined) product.price = price;
    if (purchase_cost !== undefined) product.purchase_cost = purchase_cost;
    
    const mainCat = mainCategory || main_category;
    if (mainCat) {
      product.main_category = mainCat;
      product.required_license = (mainCat === 'Tobacco' || mainCat === 'Vape') ? 'Tobacco License' : 'Seller Permit';
    }
    
    const subCat = subCategory || sub_category;
    if (subCat) {
      product.sub_category = subCat;
      product.category = subCat;
    }
    
    if (category) product.category = category;
    if (requiredLicense || required_license) {
      product.required_license = requiredLicense || required_license;
    }

    if (stock_quantity !== undefined) product.stock_quantity = stock_quantity;
    if (image_url !== undefined) product.image_url = image_url;

    await product.save();
    return res.json({ success: true, message: 'Product updated successfully', data: { product } });
  } catch (err) {
    console.error('Error updating product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update product stock
router.patch('/:id/stock', async (req, res) => {
  const { id } = req.params;
  const { stock_quantity } = req.body;

  if (stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'stock_quantity is required' });
  }

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    product.stock_quantity = stock_quantity;
    await product.save();
    return res.json({ success: true, message: 'Product stock updated successfully', data: { product } });
  } catch (err) {
    console.error('Error updating stock:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete product
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    await product.destroy();
    return res.json({ success: true, message: 'Product deleted successfully', data: null });
  } catch (err) {
    console.error('Error deleting product:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;