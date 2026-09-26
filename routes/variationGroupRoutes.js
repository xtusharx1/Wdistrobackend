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
          attributes: ['id', 'name', 'image_url', 'price', 'clearance_price', 'is_clearance', 'stock_quantity', 'sku_id', 'main_category', 'product_collection_id', 'deal_price'],
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

// PATCH /variation-groups/:id/bulk-update — bulk update variations belonging to this group
router.patch('/:id/bulk-update', async (req, res) => {
  const { product_ids, updates } = req.body;

  if (!Array.isArray(product_ids) || product_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'product_ids must be a non-empty array of variation product IDs' });
  }

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, message: 'updates object is required' });
  }

  try {
    const group = await ProductVariationGroup.findByPk(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Variation group not found' });

    const targetIds = product_ids.map(Number);
    const groupProductIds = (group.product_ids || []).map(Number);

    // Validate that ALL target IDs belong strictly to this variation group
    const foreignId = targetIds.find(id => !groupProductIds.includes(id));
    if (foreignId) {
      return res.status(400).json({
        success: false,
        message: 'Bulk update can only be performed on variations of the same product.',
      });
    }

    const products = await Product.findAll({ where: { id: { [Op.in]: targetIds } } });
    if (products.length !== targetIds.length) {
      return res.status(404).json({ success: false, message: 'One or more variation products were not found' });
    }

    const updatedProducts = [];
    for (const product of products) {
      if (updates.price !== undefined && updates.price !== '') {
        const p = parseFloat(updates.price);
        if (!isNaN(p) && p >= 0) product.price = p;
      }

      if (updates.purchase_cost !== undefined) {
        if (updates.purchase_cost === '' || updates.purchase_cost === null) {
          product.purchase_cost = null;
        } else {
          const pc = parseFloat(updates.purchase_cost);
          if (!isNaN(pc)) product.purchase_cost = pc;
        }
      }

      if (updates.stock_quantity !== undefined && updates.stock_quantity !== '') {
        const sq = parseInt(updates.stock_quantity, 10);
        if (!isNaN(sq) && sq >= 0) {
          product.stock_quantity = sq;
          if (updates.is_active === undefined) {
            product.is_active = sq > 0;
          }
        }
      }

      if (updates.is_active !== undefined) {
        product.is_active = updates.is_active === true || updates.is_active === 'true';
      }

      if (updates.product_collection_id !== undefined) {
        if (updates.product_collection_id === null || updates.product_collection_id === '' || updates.product_collection_id === 'none') {
          product.product_collection_id = null;
          product.deal_price = null;
          product.is_clearance = false;
          product.clearance_price = null;
        } else {
          product.product_collection_id = parseInt(updates.product_collection_id, 10);
          if (updates.deal_price !== undefined && updates.deal_price !== '') {
            const dp = parseFloat(updates.deal_price);
            if (!isNaN(dp) && dp > 0) product.deal_price = dp;
          }
        }
      } else if (updates.deal_price !== undefined) {
        if (updates.deal_price === '' || updates.deal_price === null) {
          product.deal_price = null;
        } else {
          const dp = parseFloat(updates.deal_price);
          if (!isNaN(dp) && dp > 0) product.deal_price = dp;
        }
      }

      await product.save();
      updatedProducts.push(product.toJSON());
    }

    return res.json({
      success: true,
      message: `Successfully updated ${updatedProducts.length} variations for "${group.group_name}".`,
      data: {
        group_id: group.id,
        group_name: group.group_name,
        count: updatedProducts.length,
        products: updatedProducts,
      },
    });
  } catch (err) {
    console.error('Error in bulk update variations:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
