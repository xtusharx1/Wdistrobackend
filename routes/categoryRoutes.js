const express = require('express');
const { Op } = require('sequelize');
const { Category, Product } = require('../models');

const router = express.Router();

// Middleware to restrict write operations to Admins
const checkAdmin = (req, res, next) => {
  const userRole = req.headers['x-user-role'];
  if (!userRole || userRole !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Access denied: Administrator privileges required' });
  }
  next();
};

// 1. Get Categories
// GET /categories
router.get('/', async (req, res) => {
  const { search, active_only } = req.query;
  const where = {};

  if (active_only === 'true') {
    where.is_active = true;
  }

  if (search) {
    where.category_name = { [Op.iLike]: `%${search}%` };
  }

  try {
    const categories = await Category.findAll({
      where,
      order: [
        ['display_order', 'ASC'],
        ['id', 'ASC']
      ]
    });

    return res.json({
      success: true,
      data: { categories }
    });
  } catch (err) {
    console.error('Error fetching categories:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 2. Create Category (Admin Only)
// POST /categories
router.post('/', checkAdmin, async (req, res) => {
  const { category_name, sub_categories, display_order, is_active } = req.body;

  if (!category_name || !String(category_name).trim()) {
    return res.status(400).json({ success: false, message: 'Category Name is required' });
  }

  const nameTrimmed = String(category_name).trim();

  // Validate subcategories
  let subCats = [];
  if (Array.isArray(sub_categories)) {
    subCats = sub_categories
      .map(s => String(s).trim())
      .filter(s => s.length > 0);
    // Prevent duplicates
    subCats = [...new Set(subCats)];
  }

  try {
    // Check if category name already exists
    const existing = await Category.findOne({
      where: {
        category_name: { [Op.iLike]: nameTrimmed }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Category "${nameTrimmed}" already exists` });
    }

    const category = await Category.create({
      category_name: nameTrimmed,
      sub_categories: subCats,
      display_order: display_order != null ? parseInt(display_order) : 0,
      is_active: is_active !== false
    });

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: { category }
    });
  } catch (err) {
    console.error('Error creating category:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

// 3. Update Category (Admin Only)
// PUT /categories/:id
router.put('/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;
  const { category_name, sub_categories, display_order, is_active } = req.body;

  if (!category_name || !String(category_name).trim()) {
    return res.status(400).json({ success: false, message: 'Category Name is required' });
  }

  const nameTrimmed = String(category_name).trim();

  // Validate subcategories
  let subCats = [];
  if (Array.isArray(sub_categories)) {
    subCats = sub_categories
      .map(s => String(s).trim())
      .filter(s => s.length > 0);
    // Prevent duplicates
    subCats = [...new Set(subCats)];
  }

  try {
    const category = await Category.findByPk(id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Check if name is taken by another category
    const existing = await Category.findOne({
      where: {
        category_name: { [Op.iLike]: nameTrimmed },
        id: { [Op.ne]: id }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Category "${nameTrimmed}" already exists` });
    }

    // If changing name or deactivating, wait, let's verify if there is any issue.
    // Deactivating is allowed even if products exist, but we must update the record.
    category.category_name = nameTrimmed;
    category.sub_categories = subCats;
    category.display_order = display_order != null ? parseInt(display_order) : category.display_order;
    category.is_active = is_active !== undefined ? !!is_active : category.is_active;

    await category.save();

    return res.json({
      success: true,
      message: 'Category updated successfully',
      data: { category }
    });
  } catch (err) {
    console.error('Error updating category:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

// 4. Delete Category (Admin Only)
// DELETE /categories/:id
router.delete('/:id', checkAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const category = await Category.findByPk(id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Check if any products are using its category name as main_category
    const productCount = await Product.count({
      where: {
        main_category: category.category_name
      }
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Category "${category.category_name}" is in use by ${productCount} products and cannot be deleted. You can disable it (is_active = false) instead.`
      });
    }

    await category.destroy();

    return res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting category:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
