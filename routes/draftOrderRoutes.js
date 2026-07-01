const express = require('express');
const sequelize = require('../config/db');
const DraftOrder = require('../models/DraftOrder');
const DraftOrderItem = require('../models/DraftOrderItem');
const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Shop = require('../models/Shop');

const router = express.Router();

const requireShop = (req, res) => {
  const shopId = req.headers['x-shop-id'];
  if (!shopId) {
    res.status(401).json({ success: false, message: 'Unauthorized: shop credentials required' });
    return null;
  }
  return parseInt(shopId, 10);
};

const PRODUCT_ATTRS = ['id', 'name', 'price', 'image_url', 'stock_quantity', 'is_active', 'is_clearance', 'clearance_price'];

// POST /drafts — create a new draft
router.post('/', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Draft must have at least one item' });
  }

  try {
    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    const productIds = items.map(i => i.product_id);
    const products = await Product.findAll({ where: { id: productIds, is_active: true } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      if (!productMap[item.product_id]) {
        return res.status(400).json({ success: false, message: `Product ${item.product_id} not found or unavailable` });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ success: false, message: 'Item quantity must be at least 1' });
      }
    }

    const total = items.reduce((sum, item) => {
      const p = productMap[item.product_id];
      const price = item.custom_price || (p.is_clearance && p.clearance_price ? p.clearance_price : p.price);
      return sum + price * item.quantity;
    }, 0);

    const draft = await sequelize.transaction(async (t) => {
      const d = await DraftOrder.create({ shop_id: shopId, total_amount: total }, { transaction: t });
      await DraftOrderItem.bulkCreate(
        items.map(item => ({
          draft_order_id: d.id,
          product_id: item.product_id,
          quantity: item.quantity,
          price_at_save: productMap[item.product_id].is_clearance && productMap[item.product_id].clearance_price
            ? productMap[item.product_id].clearance_price
            : productMap[item.product_id].price,
          custom_price: item.custom_price || null,
        })),
        { transaction: t }
      );
      return d;
    });

    const fullDraft = await DraftOrder.findByPk(draft.id, {
      include: [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }]
    });

    return res.status(201).json({ success: true, data: { draft: fullDraft } });
  } catch (err) {
    console.error('Create draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create draft' });
  }
});

// GET /drafts — list drafts for the shop
router.get('/', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const drafts = await DraftOrder.findAll({
      where: { shop_id: shopId },
      include: [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }],
      order: [['created_at', 'DESC']]
    });
    return res.json({ success: true, data: { drafts } });
  } catch (err) {
    console.error('List drafts error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch drafts' });
  }
});

// GET /drafts/:id — get single draft
router.get('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({
      where: { id: req.params.id, shop_id: shopId },
      include: [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }]
    });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    return res.json({ success: true, data: { draft } });
  } catch (err) {
    console.error('Get draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch draft' });
  }
});

// PUT /drafts/:id — replace all items and recalculate total
router.put('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Draft must have at least one item' });
  }

  try {
    const draft = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId } });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });

    const productIds = items.map(i => i.product_id);
    const products = await Product.findAll({ where: { id: productIds, is_active: true } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      if (!productMap[item.product_id]) {
        return res.status(400).json({ success: false, message: `Product ${item.product_id} not found or unavailable` });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ success: false, message: 'Item quantity must be at least 1' });
      }
    }

    const total = items.reduce((sum, item) => {
      const p = productMap[item.product_id];
      const price = item.custom_price || (p.is_clearance && p.clearance_price ? p.clearance_price : p.price);
      return sum + price * item.quantity;
    }, 0);

    await sequelize.transaction(async (t) => {
      await DraftOrderItem.destroy({ where: { draft_order_id: draft.id }, transaction: t });
      await DraftOrderItem.bulkCreate(
        items.map(item => ({
          draft_order_id: draft.id,
          product_id: item.product_id,
          quantity: item.quantity,
          price_at_save: productMap[item.product_id].is_clearance && productMap[item.product_id].clearance_price
            ? productMap[item.product_id].clearance_price
            : productMap[item.product_id].price,
          custom_price: item.custom_price || null,
        })),
        { transaction: t }
      );
      draft.total_amount = total;
      await draft.save({ transaction: t });
    });

    const fullDraft = await DraftOrder.findByPk(draft.id, {
      include: [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }]
    });

    return res.json({ success: true, data: { draft: fullDraft } });
  } catch (err) {
    console.error('Update draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update draft' });
  }
});

// DELETE /drafts/:id — delete a draft
router.delete('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId } });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });

    await sequelize.transaction(async (t) => {
      await DraftOrderItem.destroy({ where: { draft_order_id: draft.id }, transaction: t });
      await draft.destroy({ transaction: t });
    });

    return res.json({ success: true, message: 'Draft deleted' });
  } catch (err) {
    console.error('Delete draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete draft' });
  }
});

// POST /drafts/:id/submit — validate stock, create order, delete draft
router.post('/:id/submit', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({
      where: { id: req.params.id, shop_id: shopId },
      include: [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }]
    });

    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    if (!draft.DraftOrderItems || draft.DraftOrderItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Draft has no items' });
    }

    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    // Validate stock, availability, and license requirements (mirrors POST /orders)
    const unavailableItems = [];
    for (const item of draft.DraftOrderItems) {
      const product = item.Product;
      if (!product || !product.is_active) {
        unavailableItems.push({ product_id: item.product_id, reason: 'Product is no longer available' });
      } else if (product.stock_quantity < item.quantity) {
        unavailableItems.push({
          product_id: item.product_id,
          name: product.name,
          available: product.stock_quantity,
          requested: item.quantity,
          reason: `Only ${product.stock_quantity} in stock`
        });
      } else if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
        unavailableItems.push({ product_id: item.product_id, name: product.name, reason: 'Seller Permit Required for this product category.' });
      } else if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
        unavailableItems.push({ product_id: item.product_id, name: product.name, reason: 'Tobacco License Required for this product category.' });
      }
    }

    if (unavailableItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Some items are out of stock or unavailable',
        data: { unavailableItems }
      });
    }

    // Use current product prices for the order
    const total = draft.DraftOrderItems.reduce((sum, item) => {
      const p = item.Product;
      const price = item.custom_price || (p.is_clearance && p.clearance_price ? p.clearance_price : p.price);
      return sum + price * item.quantity;
    }, 0);

    const order = await sequelize.transaction(async (t) => {
      const newOrder = await Order.create(
        { shop_id: shopId, total_amount: total, status: 'pending' },
        { transaction: t }
      );

      await OrderItem.bulkCreate(
        draft.DraftOrderItems.map(item => {
          const p = item.Product;
          const price = p.is_clearance && p.clearance_price ? p.clearance_price : p.price;
          return {
            order_id: newOrder.id,
            product_id: item.product_id,
            requested_qty: item.quantity,
            approved_qty: 0,
            price,
            custom_price: item.custom_price || null,
          };
        }),
        { transaction: t }
      );

      await DraftOrderItem.destroy({ where: { draft_order_id: draft.id }, transaction: t });
      await DraftOrder.destroy({ where: { id: draft.id }, transaction: t });

      return newOrder;
    });

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: {
        order: {
          id: order.id,
          displayId: `WS-${order.id}`,
          total_amount: order.total_amount,
          status: order.status
        }
      }
    });
  } catch (err) {
    console.error('Submit draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit draft' });
  }
});

module.exports = router;
