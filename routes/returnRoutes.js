const express = require('express');
const {
  Order, OrderItem, Product, Shop, Invoice, User,
  OrderReturn, OrderReturnItem, CreditNote, SalesExecutiveAssignment, StockMovement,
} = require('../models');
const sequelize = require('../config/db');
const { round2 } = require('../services/invoiceBalanceService');
const { uploadCreditNotePDF } = require('../services/creditNotePdfService');
const { outstandingOf, applyCreditToInvoice, remainingOf, usageStatusOf } = require('../services/creditNoteService');

const router = express.Router();

// Goods can only be returned once they've reached the customer; those orders are also locked from editing
const RETURNABLE_STATUSES = ['delivered', 'completed'];

const unitPriceOf = (item) => (item.custom_price !== null && item.custom_price !== undefined ? item.custom_price : item.price);
const orderedQtyOf = (item) => item.approved_qty ?? item.requested_qty;

const canProcessReturns = (headers) =>
  !headers['x-shop-id'] && ['Admin', 'Seller'].includes(headers['x-user-role']);

const canViewReturns = async (order, headers) => {
  if (headers['x-shop-id']) return false;
  const role = headers['x-user-role'];
  if (role === 'Admin' || role === 'Seller') return true;
  if (role === 'Sales Executive' && headers['x-user-id']) {
    const assignment = await SalesExecutiveAssignment.findOne({
      where: { sales_exec_id: headers['x-user-id'], shop_id: order.shop_id, end_date: null }
    });
    return !!assignment;
  }
  return false;
};

// Quantity already returned per order item (approved returns only)
const returnedQtyByItem = async (orderId, transaction) => {
  const rows = await OrderReturnItem.findAll({
    include: [{ model: OrderReturn, attributes: [], where: { order_id: orderId, status: 'approved' } }],
    transaction
  });
  const map = new Map();
  for (const r of rows) map.set(r.order_item_id, (map.get(r.order_item_id) || 0) + r.quantity);
  return map;
};

const RETURN_INCLUDE = [
  { model: OrderReturnItem, as: 'items' },
  { model: CreditNote },
  { model: User, as: 'CreatedBy', attributes: ['id', 'name'] },
];

// Adds remaining credit and usage status to a return's credit note
const withCreditUsage = (r) => {
  const json = typeof r.toJSON === 'function' ? r.toJSON() : r;
  const cn = json.CreditNote;
  return cn ? { ...json, CreditNote: { ...cn, remaining_amount: remainingOf(cn), usage_status: usageStatusOf(cn) } } : json;
};

const INVOICE_ATTRS = ['id', 'order_id', 'final_amount', 'total_paid_amount', 'total_credited_amount', 'remaining_balance', 'payment_status', 'pdf_url'];

// ── GET /returns/order/:orderId — eligible quantities, return history and credit notes ──
router.get('/order/:orderId', async (req, res) => {
  const { orderId } = req.params;
  if (!/^\d+$/.test(String(orderId))) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }
  try {
    const order = await Order.findByPk(orderId, { include: [{ model: OrderItem, include: [Product] }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!(await canViewReturns(order, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const [invoice, returned, returns] = await Promise.all([
      Invoice.findOne({ where: { order_id: order.id }, attributes: INVOICE_ATTRS }),
      returnedQtyByItem(order.id),
      OrderReturn.findAll({ where: { order_id: order.id }, include: RETURN_INCLUDE, order: [['created_at', 'DESC']] }),
    ]);

    const items = order.OrderItems.map((item) => {
      const ordered = orderedQtyOf(item) || 0;
      const returnedQty = returned.get(item.id) || 0;
      return {
        order_item_id: item.id,
        product_id: item.product_id,
        product_name: item.Product?.billing_name || item.Product?.name || `Product #${item.product_id}`,
        sku_id: item.Product?.sku_id || null,
        ordered_qty: ordered,
        returned_qty: returnedQty,
        eligible_qty: Math.max(0, ordered - returnedQty),
        unit_price: unitPriceOf(item),
      };
    }).sort((a, b) => a.product_name.localeCompare(b.product_name, undefined, { sensitivity: 'base' }));

    let blocked_reason = null;
    if (!RETURNABLE_STATUSES.includes(order.status)) blocked_reason = 'Returns can only be recorded for delivered or completed orders.';
    else if (!invoice) blocked_reason = 'This order has no invoice yet.';
    else if (invoice.payment_status === 'settled') blocked_reason = 'This order\'s invoice has been settled.';
    else if (!items.some((i) => i.eligible_qty > 0)) blocked_reason = 'Every item on this order has already been returned.';

    return res.json({
      success: true,
      data: { order_id: order.id, order_status: order.status, invoice, items, returns: returns.map(withCreditUsage), can_return: !blocked_reason, blocked_reason }
    });
  } catch (err) {
    console.error('Error fetching returns:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Build the PDF after commit; totals are already saved, so a PDF failure only leaves pdf_url empty
const generateCreditNotePdf = async (creditNoteId) => {
  const creditNote = await CreditNote.findByPk(creditNoteId);
  const orderReturn = await OrderReturn.findByPk(creditNote.return_id, { include: [{ model: OrderReturnItem, as: 'items' }] });
  const order = await Order.findByPk(creditNote.order_id);
  const shop = await Shop.findByPk(order.shop_id);
  const invoice = await Invoice.findByPk(creditNote.invoice_id);
  const pdfUrl = await uploadCreditNotePDF({ creditNote, orderReturn, order, shop, invoice });
  await creditNote.update({ pdf_url: pdfUrl });
  return pdfUrl;
};

// ── POST /returns/order/:orderId — record a return and issue its credit note ──
// body: { items: [{ order_item_id, quantity }], reason?, return_date?, request_key, restock_inventory? }
router.post('/order/:orderId', async (req, res) => {
  const { orderId } = req.params;
  if (!canProcessReturns(req.headers)) {
    return res.status(403).json({ success: false, message: 'Access denied: Only Admin or Seller users can process returns' });
  }
  if (!/^\d+$/.test(String(orderId))) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  const { items, reason, return_date, request_key, restock_inventory } = req.body || {};
  const errors = {};
  if (typeof request_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request_key)) {
    errors.request_key = 'A request key (8-100 letters, digits, - or _) is required';
  }
  if (!Array.isArray(items) || items.length === 0) {
    errors.items = 'Select at least one item to return';
  } else if (items.length > 500) {
    errors.items = 'Too many items';
  } else {
    const seen = new Set();
    for (const it of items) {
      if (!it || !Number.isInteger(it.order_item_id) || it.order_item_id <= 0 || !Number.isInteger(it.quantity) || it.quantity <= 0) {
        errors.items = 'Each item needs a valid order_item_id and a whole-number quantity of at least 1';
        break;
      }
      if (seen.has(it.order_item_id)) { errors.items = 'Each order item can only appear once per return'; break; }
      seen.add(it.order_item_id);
    }
  }
  if (restock_inventory !== undefined && typeof restock_inventory !== 'boolean') {
    errors.restock_inventory = 'restock_inventory must be true or false';
  }
  const restock = restock_inventory === true;
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 1000)) {
    errors.reason = 'Reason must be text of 1000 characters or fewer';
  }
  let returnDate = new Date();
  if (return_date !== undefined && return_date !== null && return_date !== '') {
    returnDate = typeof return_date === 'string' ? new Date(return_date) : null;
    if (!returnDate || isNaN(returnDate.getTime())) errors.return_date = 'Return date is invalid';
    else if (returnDate.getTime() > Date.now() + 5 * 60 * 1000) errors.return_date = 'Return date cannot be in the future';
  }
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, message: 'Please correct the highlighted fields.', errors });
  }

  const userId = req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : null;
  let createdReturnId;
  let creditNoteId;

  try {
    await sequelize.transaction(async (t) => {
      // Order row lock serializes returns on the same order, so eligible quantities can't be overrun
      const order = await Order.findByPk(orderId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!order) { const e = new Error('Order not found'); e.statusCode = 404; throw e; }

      const duplicate = await OrderReturn.findOne({ where: { request_key }, transaction: t });
      if (duplicate) {
        const e = new Error('This return has already been recorded.');
        e.statusCode = 409; e.extra = { duplicate_return_id: duplicate.id };
        throw e;
      }

      if (!RETURNABLE_STATUSES.includes(order.status)) {
        const e = new Error(`Returns can only be recorded for delivered or completed orders (this order is "${order.status}").`);
        e.statusCode = 400; throw e;
      }
      if (returnDate.getTime() < new Date(order.created_at).getTime()) {
        const e = new Error('Return date cannot be before the order date.');
        e.statusCode = 400; e.extra = { errors: { return_date: e.message } }; throw e;
      }

      const invoice = await Invoice.findOne({ where: { order_id: order.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!invoice) { const e = new Error('This order has no invoice yet. Generate the invoice before recording a return.'); e.statusCode = 400; throw e; }
      if (invoice.payment_status === 'settled') {
        const e = new Error('This order\'s invoice has been settled and can no longer be credited.');
        e.statusCode = 409; throw e;
      }

      const orderItems = await OrderItem.findAll({ where: { order_id: order.id }, include: [Product], transaction: t });
      const itemById = new Map(orderItems.map((i) => [i.id, i]));
      const returned = await returnedQtyByItem(order.id, t);

      const lines = [];
      const lineErrors = [];
      for (const req_ of items) {
        const item = itemById.get(req_.order_item_id);
        if (!item) { lineErrors.push(`Item ${req_.order_item_id} is not part of order WS-${order.id}`); continue; }
        const name = item.Product?.billing_name || item.Product?.name || `Product #${item.product_id}`;
        const eligible = Math.max(0, (orderedQtyOf(item) || 0) - (returned.get(item.id) || 0));
        if (req_.quantity > eligible) {
          lineErrors.push(`${name}: only ${eligible} of ${orderedQtyOf(item) || 0} can still be returned`);
          continue;
        }
        const unitPrice = unitPriceOf(item);
        lines.push({
          order_item_id: item.id,
          product_id: item.product_id,
          product_name: name,
          sku_id: item.Product?.sku_id || null,
          quantity: req_.quantity,
          unit_price: unitPrice,
          line_total: round2(unitPrice * req_.quantity),
        });
      }
      if (lineErrors.length > 0) {
        const e = new Error(lineErrors.join('; ')); e.statusCode = 400; e.extra = { item_errors: lineErrors }; throw e;
      }

      const total = round2(lines.reduce((s, l) => s + l.line_total, 0));
      const issuedOnOrder = round2(Number(await CreditNote.sum('amount', { where: { order_id: order.id }, transaction: t })) || 0);
      if (issuedOnOrder + total > invoice.final_amount + 0.005) {
        const e = new Error(`Credit notes would exceed the invoice total of $${invoice.final_amount.toFixed(2)}.`);
        e.statusCode = 400; throw e;
      }

      const orderReturn = await OrderReturn.create({
        order_id: order.id,
        invoice_id: invoice.id,
        status: 'approved',
        return_date: returnDate,
        reason: reason ? reason.trim() || null : null,
        total_amount: total,
        created_by_user_id: userId,
        request_key,
        restock_inventory: restock,
        restocked_at: restock ? new Date() : null,
      }, { transaction: t });
      await OrderReturnItem.bulkCreate(lines.map((l) => ({ ...l, return_id: orderReturn.id })), { transaction: t });

      // Optional restock, inside this transaction so a retried request (same request_key) can't restock twice.
      // Credit and invoice figures don't depend on it.
      if (restock) {
        for (const l of lines) {
          const product = await Product.findByPk(l.product_id, { transaction: t, lock: t.LOCK.UPDATE });
          if (!product) continue;
          const prevStock = product.stock_quantity;
          product.stock_quantity = prevStock + l.quantity;
          await product.save({ transaction: t });
          await StockMovement.create({
            product_id: product.id,
            quantity_changed: l.quantity,
            previous_stock: prevStock,
            new_stock: product.stock_quantity,
            order_id: order.id,
            action: 'Return Restock',
          }, { transaction: t });
        }
      }

      const seq = (await CreditNote.count({ where: { order_id: order.id }, transaction: t })) + 1;
      const creditNote = await CreditNote.create({
        credit_note_number: `CN-${order.id}-${seq}`,
        return_id: orderReturn.id,
        order_id: order.id,
        invoice_id: invoice.id,
        amount: total,
        used_amount: 0,
        status: 'issued',
        issued_at: new Date(),
        created_by_user_id: userId,
      }, { transaction: t });

      // Apply the credit to this order's own invoice up to what it still owes; the rest stays available
      const { outstanding } = await outstandingOf(invoice, t);
      const applyNow = Math.min(total, outstanding);
      if (applyNow > 0.005) {
        await applyCreditToInvoice({
          creditNote, invoice, shopId: order.shop_id, amount: applyNow,
          source: 'return_original', userId, transaction: t,
        });
      }

      createdReturnId = orderReturn.id;
      creditNoteId = creditNote.id;
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message, ...(err.extra || {}) });
    }
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'This return has already been recorded.' });
    }
    console.error('Error recording return:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }

  let pdfFailed = false;
  try {
    await generateCreditNotePdf(creditNoteId);
  } catch (pdfErr) {
    pdfFailed = true;
    console.error('Failed to generate credit note PDF:', pdfErr);
  }

  const created = await OrderReturn.findByPk(createdReturnId, { include: RETURN_INCLUDE });
  const invoice = await Invoice.findByPk(created.invoice_id, { attributes: INVOICE_ATTRS });
  return res.status(201).json({
    success: true,
    message: (pdfFailed
      ? `Return recorded and credit note ${created.CreditNote.credit_note_number} issued, but its PDF could not be generated. Use Generate PDF to retry.`
      : `Return recorded and credit note ${created.CreditNote.credit_note_number} issued.`)
      + (created.restock_inventory ? ' Returned quantities were added back to inventory.' : ' Inventory was not changed.'),
    data: { return: withCreditUsage(created), invoice, pdf_failed: pdfFailed }
  });
});

// ── POST /returns/credit-notes/:id/pdf — (re)generate a credit note's PDF ──
router.post('/credit-notes/:id/pdf', async (req, res) => {
  if (!canProcessReturns(req.headers)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({ success: false, message: 'Invalid credit note ID' });
  }
  try {
    const creditNote = await CreditNote.findByPk(req.params.id);
    if (!creditNote) return res.status(404).json({ success: false, message: 'Credit note not found' });
    const pdfUrl = await generateCreditNotePdf(creditNote.id);
    return res.json({ success: true, message: 'Credit note PDF generated', data: { pdf_url: pdfUrl } });
  } catch (err) {
    console.error('Error generating credit note PDF:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate credit note PDF' });
  }
});

module.exports = router;
