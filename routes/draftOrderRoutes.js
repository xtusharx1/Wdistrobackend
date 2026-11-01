const express = require('express');
const sequelize = require('../config/db');
const DraftOrder = require('../models/DraftOrder');
const DraftOrderItem = require('../models/DraftOrderItem');
const Product = require('../models/Product');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Shop = require('../models/Shop');
const { getProductEffectivePricing } = require('../services/pricingService');

const router = express.Router();

// Identity model: the store app signs in as a shop and identifies itself with x-shop-id; it has no
// individual user accounts. Drafts therefore belong to the shop, and every query is scoped to it.
// Drafts are a store feature: there is no staff access and no custom pricing here.

const requireShop = (req, res) => {
  const shopId = parseInt(req.headers['x-shop-id'], 10);
  if (!Number.isInteger(shopId) || shopId <= 0) {
    res.status(401).json({ success: false, message: 'Unauthorized: shop credentials required' });
    return null;
  }
  return shopId;
};

const PRODUCT_ATTRS = ['id', 'name', 'price', 'image_url', 'stock_quantity', 'is_active', 'is_clearance', 'clearance_price', 'product_collection_id', 'deal_price', 'is_explicit_product', 'billing_name'];

const DRAFT_INCLUDE = [{ model: DraftOrderItem, include: [{ model: Product, attributes: PRODUCT_ATTRS }] }];

// Submit also needs required_license (kept out of the attribute list returned to the app) so that the
// Seller Permit / Tobacco License rules in the submit validation can actually be evaluated.
const SUBMIT_INCLUDE = [{ model: DraftOrderItem, include: [{ model: Product, attributes: [...PRODUCT_ATTRS, 'required_license'] }] }];

// A request-level failure that should roll back the transaction and become this HTTP response
class HttpError extends Error {
  constructor(status, body) { super(body.message); this.status = status; this.body = { success: false, ...body }; }
}

/** Validate items array and return an error message or null. */
const validateItems = (items) => {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return 'Draft must have at least one item';
  }
  for (const item of items) {
    if (!Number.isInteger(item.product_id) || item.product_id < 1) {
      return 'Each item must have a valid product_id';
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return 'Item quantity must be at least 1';
    }
  }
  return null;
};

/** Load active products and build pricing; returns { productMap, pricingMap } or { error }. */
const buildProductMaps = async (shop, items) => {
  const productIds = items.map(i => i.product_id);
  const products = await Product.findAll({ where: { id: productIds, is_active: true } });
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  for (const item of items) {
    const p = productMap[item.product_id];
    if (!p) {
      return { error: `Product ${item.product_id} not found or is no longer available` };
    }
    if (p.is_explicit_product && !shop.allow_explicit_products) {
      return { error: `Product "${p.name}" is restricted and cannot be added.` };
    }
  }

  const pricingMap = {};
  for (const item of items) {
    pricingMap[item.product_id] = await getProductEffectivePricing(productMap[item.product_id]);
  }

  return { productMap, pricingMap };
};

const calcTotal = (items, pricingMap) =>
  items.reduce((sum, item) => {
    return sum + pricingMap[item.product_id].effective_price * item.quantity;
  }, 0);

// Replace a draft's items and total under the draft's row lock (the same lock submit and delete take), so an
// edit can't interleave with a submit of the same draft.
const replaceItems = async (draftId, items, pricingMap, t) => {
  const total = calcTotal(items, pricingMap);
  await DraftOrderItem.destroy({ where: { draft_order_id: draftId }, transaction: t });
  await DraftOrderItem.bulkCreate(
    items.map(item => ({
      draft_order_id: draftId,
      product_id: item.product_id,
      quantity: item.quantity,
      price_at_save: pricingMap[item.product_id].effective_price,
    })),
    { transaction: t }
  );
  await DraftOrder.update({ total_amount: total }, { where: { id: draftId }, transaction: t });
};

// ── The store's saved cart ─────────────────────────────────────────────────
// One draft per shop is flagged is_cart. The app mirrors its live cart into it and reloads it on start / login,
// so a cart survives closing the app. It is an ordinary draft otherwise (submit and delete work on it), but it
// is left out of the "Saved Drafts" list.

// GET /drafts/cart — the shop's saved cart, or null
router.get('/cart', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;
  try {
    const cart = await DraftOrder.findOne({ where: { shop_id: shopId, is_cart: true }, include: DRAFT_INCLUDE });
    return res.json({ success: true, data: { cart } });
  } catch (err) {
    console.error('Get cart error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch cart' });
  }
});

// PUT /drafts/cart — replace the saved cart with these items; an empty list clears it
router.put('/cart', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;
  const { items } = req.body;

  try {
    if (Array.isArray(items) && items.length === 0) {
      await clearCart(shopId);
      return res.json({ success: true, data: { cart: null } });
    }
    const itemsError = validateItems(items);
    if (itemsError) return res.status(400).json({ success: false, message: itemsError });

    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
    const result = await buildProductMaps(shop, items);
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    const cartId = await sequelize.transaction(async (t) => {
      // Serialise this shop's cart writes so two first saves can't create two carts
      await Shop.findOne({ where: { id: shopId }, transaction: t, lock: t.LOCK.UPDATE });
      let cart = await DraftOrder.findOne({ where: { shop_id: shopId, is_cart: true }, transaction: t, lock: t.LOCK.UPDATE });
      if (!cart) cart = await DraftOrder.create({ shop_id: shopId, is_cart: true, total_amount: 0 }, { transaction: t });
      await replaceItems(cart.id, items, result.pricingMap, t);
      return cart.id;
    });

    const cart = await DraftOrder.findByPk(cartId, { include: DRAFT_INCLUDE });
    return res.json({ success: true, data: { cart } });
  } catch (err) {
    console.error('Save cart error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save cart' });
  }
});

const clearCart = (shopId) => sequelize.transaction(async (t) => {
  const cart = await DraftOrder.findOne({ where: { shop_id: shopId, is_cart: true }, transaction: t, lock: t.LOCK.UPDATE });
  if (!cart) return;
  await DraftOrderItem.destroy({ where: { draft_order_id: cart.id }, transaction: t });
  await DraftOrder.destroy({ where: { id: cart.id }, transaction: t });
});

// DELETE /drafts/cart — clear the saved cart
router.delete('/cart', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;
  try {
    await clearCart(shopId);
    return res.json({ success: true, message: 'Cart cleared' });
  } catch (err) {
    console.error('Clear cart error:', err);
    return res.status(500).json({ success: false, message: 'Failed to clear cart' });
  }
});

// ── POST /drafts — save a new draft for the shop ───────────────────────────
router.post('/', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const { items } = req.body;
  const itemsError = validateItems(items);
  if (itemsError) return res.status(400).json({ success: false, message: itemsError });

  try {
    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    const result = await buildProductMaps(shop, items);
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    const draftId = await sequelize.transaction(async (t) => {
      const d = await DraftOrder.create({ shop_id: shopId, total_amount: 0 }, { transaction: t });
      await replaceItems(d.id, items, result.pricingMap, t);
      return d.id;
    });

    const fullDraft = await DraftOrder.findByPk(draftId, { include: DRAFT_INCLUDE });
    return res.status(201).json({ success: true, data: { draft: fullDraft } });
  } catch (err) {
    console.error('Create draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save draft' });
  }
});

// ── GET /drafts — the shop's saved drafts (not the live cart) ──────────────
router.get('/', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const drafts = await DraftOrder.findAll({
      where: { shop_id: shopId, is_cart: false },
      include: DRAFT_INCLUDE,
      order: [['updated_at', 'DESC']],
    });
    return res.json({ success: true, data: { drafts } });
  } catch (err) {
    console.error('List drafts error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch drafts' });
  }
});

// ── GET /drafts/:id — one of the shop's drafts ──
router.get('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId }, include: DRAFT_INCLUDE });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    return res.json({ success: true, data: { draft } });
  } catch (err) {
    console.error('Get draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch draft' });
  }
});

// ── PUT /drafts/:id — replace all items and recalculate total ──
router.put('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const { items } = req.body;
  const itemsError = validateItems(items);
  if (itemsError) return res.status(400).json({ success: false, message: itemsError });

  try {
    const exists = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId }, attributes: ['id'] });
    if (!exists) return res.status(404).json({ success: false, message: 'Draft not found' });

    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    const result = await buildProductMaps(shop, items);
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    await sequelize.transaction(async (t) => {
      const draft = await DraftOrder.findOne({ where: { id: exists.id, shop_id: shopId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!draft) throw new HttpError(409, { message: 'This draft was submitted or deleted while you were editing it.' });
      await replaceItems(draft.id, items, result.pricingMap, t);
    });

    const fullDraft = await DraftOrder.findOne({ where: { id: exists.id }, include: DRAFT_INCLUDE });
    return res.json({ success: true, data: { draft: fullDraft } });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error('Update draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update draft' });
  }
});

// ── DELETE /drafts/:id — delete one of the shop's drafts ──
router.delete('/:id', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId }, attributes: ['id'] });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });

    await sequelize.transaction(async (t) => {
      const locked = await DraftOrder.findOne({ where: { id: draft.id, shop_id: shopId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!locked) throw new HttpError(409, { message: 'This draft was already submitted or deleted.' });
      await DraftOrderItem.destroy({ where: { draft_order_id: locked.id }, transaction: t });
      await DraftOrder.destroy({ where: { id: locked.id }, transaction: t });
    });

    return res.json({ success: true, message: 'Draft deleted' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error('Delete draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete draft' });
  }
});

// ── POST /drafts/:id/submit — validate, create the order and consume the draft atomically ──
//
// 1. Read, validate and price the draft WITHOUT holding a transaction. Pricing needs its own database
//    connections, so doing it inside the transaction could exhaust the small connection pool when several
//    submits arrive together (every transaction waiting for a second connection that never frees).
// 2. Then one short transaction claims the draft with SELECT ... FOR UPDATE SKIP LOCKED:
//    * A simultaneous submit of the same draft finds it locked (or already consumed) and gets 409
//      immediately, without waiting on a connection, so exactly one request creates the order.
//    * The claim re-checks that the draft's items are unchanged since validation (409 if edited meanwhile).
//    * Order, order items and draft removal commit together. Any failure rolls everything back, so no order
//      is created and the draft is left exactly as it was, ready to fix and retry.
// A retry after a successful submit finds no draft and gets 404 ("may have already been submitted").
const itemsSignature = (items) =>
  items.map((i) => `${i.id}:${i.product_id}:${i.quantity}`).sort().join('|');

router.post('/:id/submit', async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const draft = await DraftOrder.findOne({ where: { id: req.params.id, shop_id: shopId }, include: SUBMIT_INCLUDE });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found. It may have already been submitted.' });
    const draftItems = draft.DraftOrderItems || [];
    if (draftItems.length === 0) return res.status(400).json({ success: false, message: 'Draft has no items' });

    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
    // Same rule and message as POST /orders
    if (!shop.approved) return res.status(400).json({ success: false, message: 'Orders can only be created for approved stores' });

    // Validate stock, availability, and license requirements (mirrors POST /orders)
    const unavailableItems = [];
    for (const item of draftItems) {
      const product = item.Product;
      if (!product || !product.is_active) {
        unavailableItems.push({ product_id: item.product_id, reason: 'Product is no longer available' });
      } else if (product.is_explicit_product && !shop.allow_explicit_products) {
        unavailableItems.push({ product_id: item.product_id, name: product.name, reason: 'Explicit products are not allowed for this store.' });
      } else if (product.stock_quantity < item.quantity) {
        unavailableItems.push({
          product_id: item.product_id,
          name: product.name,
          available: product.stock_quantity,
          requested: item.quantity,
          reason: `Only ${product.stock_quantity} in stock`,
        });
      } else if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
        unavailableItems.push({ product_id: item.product_id, name: product.name, reason: 'Seller Permit Required for this product category.' });
      } else if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
        unavailableItems.push({ product_id: item.product_id, name: product.name, reason: 'Tobacco License Required for this product category.' });
      }
    }
    if (unavailableItems.length > 0) {
      return res.status(400).json({ success: false, message: 'Some items are out of stock or unavailable', data: { unavailableItems } });
    }

    // Current product prices respecting deal eligibility (outside the transaction, see above)
    const pricingMap = {};
    for (const item of draftItems) {
      pricingMap[item.product_id] = await getProductEffectivePricing(item.Product);
    }
    const total = draftItems.reduce((sum, item) => {
      return sum + pricingMap[item.product_id].effective_price * item.quantity;
    }, 0);
    const validatedSignature = itemsSignature(draftItems);

    const order = await sequelize.transaction(async (t) => {
      const claimed = await DraftOrder.findOne({
        where: { id: draft.id, shop_id: shopId },
        transaction: t,
        lock: t.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!claimed) {
        throw new HttpError(409, { message: 'This draft is already being submitted or was just submitted. Check your orders before trying again.' });
      }
      const current = await DraftOrderItem.findAll({ where: { draft_order_id: claimed.id }, transaction: t });
      if (itemsSignature(current) !== validatedSignature) {
        throw new HttpError(409, { message: 'This draft was changed while it was being submitted. Please review it and submit again.' });
      }

      const newOrder = await Order.create({ shop_id: shopId, total_amount: total, status: 'pending' }, { transaction: t });
      await OrderItem.bulkCreate(
        draftItems.map((item) => ({
          order_id: newOrder.id,
          product_id: item.product_id,
          requested_qty: item.quantity,
          approved_qty: null,
          price: pricingMap[item.product_id].effective_price,
        })),
        { transaction: t }
      );

      await DraftOrderItem.destroy({ where: { draft_order_id: claimed.id }, transaction: t });
      const consumed = await DraftOrder.destroy({ where: { id: claimed.id }, transaction: t });
      if (consumed !== 1) throw new HttpError(409, { message: 'This draft was already submitted.' });

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
          status: order.status,
        },
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error('Submit draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit draft' });
  }
});

module.exports = router;
