const express = require('express');
const { Op } = require('sequelize');
const { ProductCollection, Product } = require('../models');

const router = express.Router();

// Middleware to restrict write operations to Admins
const checkAdmin = (req, res, next) => {
  const userRole = req.headers['x-user-role'];
  if (!userRole || userRole !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Access denied: Administrator privileges required' });
  }
  next();
};

// 1. Get Collections
// GET /collections
router.get('/', async (req, res) => {
  const { search, active_only } = req.query;
  const where = {};

  if (active_only === 'true') {
    where.is_active = true;
  }

  if (search) {
    where.name = { [Op.iLike]: `%${search}%` };
  }

  try {
    const collections = await ProductCollection.findAll({
      where,
      order: [['id', 'ASC']]
    });

    return res.json({
      success: true,
      data: { collections }
    });
  } catch (err) {
    console.error('Error fetching collections:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 2. Create Collection (Admin Only)
// POST /collections
router.post('/', checkAdmin, async (req, res) => {
  const { name, is_active } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Collection Name is required' });
  }

  const nameTrimmed = String(name).trim();

  try {
    // Check uniqueness
    const existing = await ProductCollection.findOne({
      where: {
        name: { [Op.iLike]: nameTrimmed }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Product Collection "${nameTrimmed}" already exists` });
    }

    const collection = await ProductCollection.create({
      name: nameTrimmed,
      is_active: is_active !== false
    });

    return res.status(201).json({
      success: true,
      message: 'Product Collection created successfully',
      data: { collection }
    });
  } catch (err) {
    console.error('Error creating collection:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

// 3. Update Collection (Admin Only)
// PUT /collections/:id
router.put('/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, is_active } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Collection Name is required' });
  }

  const nameTrimmed = String(name).trim();

  try {
    const collection = await ProductCollection.findByPk(id);
    if (!collection) {
      return res.status(404).json({ success: false, message: 'Product Collection not found' });
    }

    // Check if name is taken by another collection
    const existing = await ProductCollection.findOne({
      where: {
        name: { [Op.iLike]: nameTrimmed },
        id: { [Op.ne]: id }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Product Collection "${nameTrimmed}" already exists` });
    }

    collection.name = nameTrimmed;
    collection.is_active = is_active !== undefined ? !!is_active : collection.is_active;

    await collection.save();

    return res.json({
      success: true,
      message: 'Product Collection updated successfully',
      data: { collection }
    });
  } catch (err) {
    console.error('Error updating collection:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

// 4. Delete Collection (Admin Only)
// DELETE /collections/:id
router.delete('/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const collection = await ProductCollection.findByPk(id);
    if (!collection) {
      return res.status(404).json({ success: false, message: 'Product Collection not found' });
    }

    // Check if any products reference this collection
    const productCount = await Product.count({
      where: {
        product_collection_id: id
      }
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Product Collection "${collection.name}" is in use by ${productCount} products and cannot be deleted. You can disable it (is_active = false) instead.`
      });
    }

    await collection.destroy();

    return res.json({
      success: true,
      message: 'Product Collection deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting collection:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
