const express = require('express');
const multer = require('multer');
const path = require('path');
const { Op } = require('sequelize');
const Product = require('../models/Product');

const router = express.Router();

// Set up Multer for simple local storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Upload product image
router.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file provided' });
  }

  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  return res.json({ success: true, message: 'Image uploaded successfully', data: { image_url: imageUrl } });
});

// Create product
router.post('/', async (req, res) => {
  const { name, price, unit, category, stock_quantity, image_url } = req.body;
  if (!name || !price || !unit || stock_quantity === undefined) {
    return res.status(400).json({ success: false, message: 'Name, price, unit, and stock_quantity are required' });
  }

  try {
    const product = await Product.create({ name, price, unit, category: category || 'General', stock_quantity, image_url });
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
    const { page = 1, limit = 10, search } = req.query;
    const offset = (page - 1) * limit;

    const whereClause = {};
    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
    }

    const { count, rows: products } = await Product.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    return res.json({ 
      success: true, 
      message: 'Products fetched successfully', 
      data: { 
        products,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
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
  const { name, price, unit, category, stock_quantity, image_url } = req.body;

  try {
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (name) product.name = name;
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