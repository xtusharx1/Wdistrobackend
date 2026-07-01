const express = require('express');
const { Op, literal } = require('sequelize');
const ProductVariationGroup = require('../models/ProductVariationGroup');
const Product = require('../models/Product');

const router = express.Router();

// GET /variation-groups — all groups with embedded product details for the admin table
router.get('/', async (req, res) => {
  try {
    const groups = await ProductVariationGroup.findAll({ order: [['created_at', 'DESC']] });

    const allIds = [...new Set(groups.flatMap(g => g.product_ids))];
    const products = allIds.length > 0
      ? await Product.findAll({
          where: { id: { [Op.in]: allIds } },
          attributes: ['id', 'name', 'image_url', 'price', 'clearance_price', 'is_clearance', 'stock_quantity', 'sku_id', 'main_category'],
        })
      : [];

    const productMap = {};
    for (const p of products) productMap[p.id] = p.toJSON();

    const result = groups.map(g => ({
      ...g.toJSON(),
      products: g.product_ids.map(id => productMap[id] || { id, name: 'Unknown' }),
    }));

    return res.json({ success: true, message: 'Variation groups fetched successfully', data: { groups: result } });
  } catch (err) {
    console.error('Error fetching variation groups:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /variation-groups/:id — single group with full product details
router.get('/:id', async (req, res) => {
  try {
    const group = await ProductVariationGroup.findByPk(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Variation group not found' });

    const products = group.product_ids.length > 0
      ? await Product.findAll({ where: { id: { [Op.in]: group.product_ids } } })
      : [];

    return res.json({ success: true, data: { group: group.toJSON(), products: products.map(p => p.toJSON()) } });
  } catch (err) {
    console.error('Error fetching variation group:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /variation-groups — create
router.post('/', async (req, res) => {
  const { group_name, product_ids } = req.body;

  if (!group_name || !group_name.trim()) {
    return res.status(400).json({ success: false, message: 'group_name is required' });
  }
  if (!Array.isArray(product_ids) || product_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'product_ids must be a non-empty array' });
  }

  try {
    // Enforce: each product may belong to only one group
    const existing = await ProductVariationGroup.findAll();
    for (const g of existing) {
      const conflict = product_ids.find(id => g.product_ids.includes(Number(id)));
      if (conflict) {
        const conflicting = await Product.findByPk(conflict, { attributes: ['name'] });
        return res.status(409).json({
          success: false,
          message: `Product "${conflicting?.name || conflict}" already belongs to variation group "${g.group_name}".`,
        });
      }
    }

    const group = await ProductVariationGroup.create({
      group_name: group_name.trim(),
      product_ids: product_ids.map(Number),
    });

    return res.status(201).json({ success: true, message: 'Variation group created', data: { group } });
  } catch (err) {
    console.error('Error creating variation group:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PATCH /variation-groups/:id — update name or product list
router.patch('/:id', async (req, res) => {
  const { group_name, product_ids } = req.body;

  try {
    const group = await ProductVariationGroup.findByPk(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Variation group not found' });

    if (product_ids !== undefined) {
      if (!Array.isArray(product_ids) || product_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'product_ids must be a non-empty array' });
      }
      // Check no product in the new list belongs to a different group
      const others = await ProductVariationGroup.findAll({ where: { id: { [Op.ne]: group.id } } });
      for (const g of others) {
        const conflict = product_ids.find(id => g.product_ids.includes(Number(id)));
        if (conflict) {
          const conflicting = await Product.findByPk(conflict, { attributes: ['name'] });
          return res.status(409).json({
            success: false,
            message: `Product "${conflicting?.name || conflict}" already belongs to variation group "${g.group_name}".`,
          });
        }
      }
      group.product_ids = product_ids.map(Number);
    }

    if (group_name && group_name.trim()) group.group_name = group_name.trim();

    await group.save();
    return res.json({ success: true, message: 'Variation group updated', data: { group } });
  } catch (err) {
    console.error('Error updating variation group:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /variation-groups/:id — delete group (products are NOT deleted)
router.delete('/:id', async (req, res) => {
  try {
    const group = await ProductVariationGroup.findByPk(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Variation group not found' });
    await group.destroy();
    return res.json({ success: true, message: 'Variation group deleted' });
  } catch (err) {
    console.error('Error deleting variation group:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
