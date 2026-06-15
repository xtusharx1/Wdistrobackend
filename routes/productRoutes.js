const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const { Op } = require('sequelize');
const Product = require('../models/Product');

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
  const { name, price, unit, category, stock_quantity, image_url, sku_id } = req.body;
  if (!name || !price || !unit || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, unit, and stock_quantity are required' });
  }

  try {
    const product = await Product.create({ name, price, unit, category: category || 'General', stock_quantity, image_url, sku_id });
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
    const { name, price, unit, stock_quantity } = productsInput[i];
    if (!name || price === undefined || !unit || stock_quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: `Product at index ${i} is missing required fields (name, price, unit, stock_quantity)`
      });
    }
  }

  try {
    const createdProducts = await Product.bulkCreate(
      productsInput.map(p => ({
        name: p.name,
        sku_id: p.sku_id || null,
        price: p.price,
        unit: p.unit,
        category: p.category || 'General',
        stock_quantity: p.stock_quantity,
        image_url: p.image_url || null
      }))
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

    const whereClause = {};
    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
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

    return res.json({ 
      success: true, 
      message: 'Products fetched successfully', 
      data: { 
        products,
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

// Update product
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price, unit, category, stock_quantity, image_url, sku_id } = req.body;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (name) product.name = name;
    if (sku_id !== undefined) product.sku_id = sku_id;
    if (price) product.price = price;
    if (unit) product.unit = unit;
    if (category) product.category = category;
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