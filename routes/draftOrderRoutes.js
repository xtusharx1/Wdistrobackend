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
// individual user accounts. Drafts therefore belong to the shop, and every store query is scoped to it.
// Admin/Seller (the same roles that may set custom prices on orders) identify themselves with x-user-role.
const STAFF_ROLES = ['Admin', 'Seller'];

// Who is calling? A request carrying x-shop-id is ALWAYS a store, whatever role header it also sends, so a
// store can't pass as staff by adding x-user-role. Staff = Admin/Seller role and no shop header.
const resolveCaller = (req) => {
  const raw = req.headers['x-shop-id'];
  if (raw !== undefined && raw !== '') {
    const shopId = parseInt(raw, 10);
    return Number.isInteger(shopId) && shopId > 0 ? { type: 'store', shopId } : null;
  }
  if (STAFF_ROLES.includes(req.headers['x-user-role'])) return { type: 'staff' };
  return null;
};
const unauthorized = (res) => res.status(401).json({ success: false, message: 'Unauthorized: shop or staff credentials required' });

// Custom price is controlled by Admin/Seller. Per item: { provided: false } (key absent), or
// { provided: true, value } where value is a positive price, or null to clear it (null / '' / 0, matching how
// drafts always treated "no custom price"). Stores never provide one: whatever they send is ignored.
const parseItemPrices = (caller, items) => {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (caller.type !== 'staff' || items[i].custom_price === undefined) { out.push({ provided: false }); continue; }
    const raw = items[i].custom_price;
    if (raw === null || raw === '') { out.push({ provided: true, value: null }); continue; }
    const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
    if (!Number.isFinite(n) || n < 0) return { error: `Item ${i + 1}: custom_price must be a positive number (or null to clear it)` };
    out.push({ provided: true, value: n > 0 ? n : null });
  }
  return { values: out };
};

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
    const pricing = pricingMap[item.product_id];
    const price = (item.custom_price != null && item.custom_price > 0) ? item.custom_price : pricing.effective_price;
    return sum + price * item.quantity;
  }, 0);

// ── POST /drafts — create a new draft ──────────────────────────────────────
// Store: creates a draft for its own shop. Staff (Admin/Seller): must pass shop_id and may set custom_price.
router.post('/', async (req, res) => {
  const caller = resolveCaller(req);
  if (!caller) return unauthorized(res);
  const shopId = caller.type === 'store' ? caller.shopId : parseInt(req.body?.shop_id, 10);
  if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ success: false, message: 'shop_id is required' });

  const { items, notes } = req.body;
  const itemsError = validateItems(items);
  if (itemsError) return res.status(400).json({ success: false, message: itemsError });

  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
    return res.status(400).json({ success: false, message: 'Notes must be 500 characters or fewer' });
  }
  const prices = parseItemPrices(caller, items);
  if (prices.error) return res.status(400).json({ success: false, message: prices.error });
  // A new draft starts with no custom prices; only staff-provided ones apply
  const priced = items.map((item, i) => ({ ...item, custom_price: prices.values[i].provided ? prices.values[i].value : null }));

  try {
    const shop = await Shop.findByPk(shopId);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    const result = await buildProductMaps(shop, priced);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    const { pricingMap } = result;

    const total = calcTotal(priced, pricingMap);

    const draft = await sequelize.transaction(async (t) => {
      const d = await DraftOrder.create({
        shop_id: shopId,
        total_amount: total,
        notes: notes ? notes.trim() || null : null,
      }, { transaction: t });

      await DraftOrderItem.bulkCreate(
        priced.map(item => ({
          draft_order_id: d.id,
          product_id: item.product_id,
          quantity: item.quantity,
          price_at_save: pricingMap[item.product_id].effective_price,
          custom_price: item.custom_price,
        })),
        { transaction: t }
      );
      return d;
    });

    const fullDraft = await DraftOrder.findByPk(draft.id, { include: DRAFT_INCLUDE });
    return res.status(201).json({ success: true, data: { draft: fullDraft } });
  } catch (err) {
    console.error('Create draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save draft' });
  }
});

// ── GET /drafts — list drafts: a store sees its own; staff pass ?shop_id= ──
router.get('/', async (req, res) => {
  const caller = resolveCaller(req);
  if (!caller) return unauthorized(res);
  const shopId = caller.type === 'store' ? caller.shopId : parseInt(req.query.shop_id, 10);
  if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ success: false, message: 'shop_id is required' });

  try {
    const drafts = await DraftOrder.findAll({
      where: { shop_id: shopId },
      include: DRAFT_INCLUDE,
      order: [['updated_at', 'DESC']],
    });
    return res.json({ success: true, data: { drafts } });
  } catch (err) {
    console.error('List drafts error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch drafts' });
  }
});

// ── GET /drafts/:id — a store gets its own draft; staff can read any ──
router.get('/:id', async (req, res) => {
  const caller = resolveCaller(req);
  if (!caller) return unauthorized(res);

  try {
    const where = caller.type === 'store' ? { id: req.params.id, shop_id: caller.shopId } : { id: req.params.id };
    const draft = await DraftOrder.findOne({ where, include: DRAFT_INCLUDE });
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    return res.json({ success: true, data: { draft } });
  } catch (err) {
    console.error('Get draft error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch draft' });
  }
});

// ── PUT /drafts/:id — replace all items and recalculate total ──
// Custom prices already on the draft survive every edit. Only staff can change them (set a price, or null/0 to
// clear it); omitting custom_price keeps the current one. Whatever a store sends is ignored.
router.put('/:id', async (req, res) => {
  const caller = resolveCaller(req);
  if (!caller) return unauthorized(res);

  const { items, notes } = req.body;
  const itemsError = validateItems(items);
  if (itemsError) return res.status(400).json({ success: false, message: itemsError });

  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
    return res.status(400).json({ success: false, message: 'Notes must be 500 characters or fewer' });
  }
  const prices = parseItemPrices(caller, items);
  if (prices.error) return res.status(400).json({ success: false, message: prices.error });

  try {
    const scope = caller.type === 'store' ? { id: req.params.id, shop_id: caller.shopId } : { id: req.params.id };
    const exists = await DraftOrder.findOne({ where: scope, attributes: ['id', 'shop_id'] });
    if (!exists) return res.status(404).json({ success: false, message: 'Draft not found' });

    const shop = await Shop.findByPk(exists.shop_id);
    if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });

    // Only product existence/availability and list prices are needed here; custom prices are resolved
    // under the row lock below so a concurrent price change can't be overwritten.
    const result = await buildProductMaps(shop, items);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    const { pricingMap } = result;

    await sequelize.transaction(async (t) => {
      // Same row lock as submit, so an edit can't interleave with a submit of the same draft
      const draft = await DraftOrder.findOne({ where: { id: exists.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!draft) throw new HttpError(409, { message: 'This draft was submitted or deleted while you were editing it.' });

      const current = await DraftOrderItem.findAll({ where: { draft_order_id: draft.id }, transaction: t });
      const currentPrice = new Map(current.map((i) => [i.product_id, i.custom_price]));
      const priced = items.map((item, i) => ({
        ...item,
        custom_price: prices.values[i].provided ? prices.values[i].value : (currentPrice.get(item.product_id) ?? null),
      }));
      const total = calcTotal(priced, pricingMap);

      await DraftOrderItem.destroy({ where: { draft_order_id: draft.id }, transaction: t });
      await DraftOrderItem.bulkCreate(
        priced.map(item => ({
          draft_order_id: draft.id,
          product_id: item.product_id,
          quantity: item.quantity,
          price_at_save: pricingMap[item.product_id].effective_price,
          custom_price: item.custom_price,
        })),
        { transaction: t }
      );
      const updateFields = { total_amount: total };
      if (notes !== undefined) updateFields.notes = notes ? notes.trim() || null : null;
      await draft.update(updateFields, { transaction: t });
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
  items.map((i) => `${i.id}:${i.product_id}:${i.quantity}:${i.custom_price ?? ''}`).sort().join('|');

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
      const price = (item.custom_price != null && item.custom_price > 0) ? item.custom_price : pricingMap[item.product_id].effective_price;
      return sum + price * item.quantity;
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
          custom_price: (item.custom_price != null && item.custom_price > 0) ? item.custom_price : null,
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
