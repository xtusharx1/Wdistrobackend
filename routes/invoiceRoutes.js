const express = require('express');
const Invoice = require('../models/Invoice');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const User = require('../models/User');
const { uploadInvoicePDF, generateInvoicePDFBuffer } = require('../services/pdfService');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const PaymentEditLog = require('../models/PaymentEditLog');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const { computeInvoiceBalance } = require('../services/invoiceBalanceService');
const CreditNote = require('../models/CreditNote');
const CreditNoteApplication = require('../models/CreditNoteApplication');
const { remainingOf, usageStatusOf, outstandingOf, applyCreditToInvoice } = require('../services/creditNoteService');

const router = express.Router();

const VALID_PAYMENT_METHODS = ['Cash', 'Card', 'Check', 'MO', 'Adjusted'];

const PAYMENT_HISTORY_INCLUDE = {
  model: InvoicePaymentHistory,
  as: 'PaymentHistory',
  include: [{ model: User, as: 'VerifiedBy', attributes: ['id', 'name'] }],
};

const checkInvoiceAccess = async (orderId, headers) => {
  const shopId = headers['x-shop-id'];
  const userRole = headers['x-user-role'];
  const userId = headers['x-user-id'];

  const order = await Order.findByPk(orderId);
  if (!order) {
    return { hasAccess: false, status: 404, message: 'Order not found' };
  }

  if (shopId) {
    if (String(order.shop_id) !== String(shopId)) {
      return { hasAccess: false, status: 403, message: 'Access denied: This invoice does not belong to your shop' };
    }
    return { hasAccess: true, order };
  }

  if (userRole) {
    if (userRole === 'Admin' || userRole === 'Seller') {
      return { hasAccess: true, order };
    }

    if (userRole === 'Sales Executive') {
      if (!userId) {
        return { hasAccess: false, status: 403, message: 'Access denied: User ID is required' };
      }
      const assignment = await SalesExecutiveAssignment.findOne({
        where: { sales_exec_id: userId, shop_id: order.shop_id, end_date: null }
      });
      if (!assignment) {
        return { hasAccess: false, status: 403, message: 'Access denied: You are not assigned to this shop' };
      }
      return { hasAccess: true, order };
    }
  }

  return { hasAccess: false, status: 401, message: 'Unauthorized: Access credentials missing' };
};

// ── GET /invoices/payments — all payment history (Admin/Seller/Sales only) ──
// Must be defined before /:orderId to avoid "payments" being parsed as orderId
router.get('/payments', async (req, res) => {
  const userRole = req.headers['x-user-role'];
  if (!userRole || !['Admin', 'Seller', 'Sales Executive'].includes(userRole)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const payments = await InvoicePaymentHistory.findAll({
      include: [
        {
          model: Invoice,
          include: [{ model: Order, include: [Shop] }]
        },
        { model: User, as: 'VerifiedBy', attributes: ['id', 'name'] }
      ],
      order: [['created_at', 'DESC']]
    });
    return res.json({ success: true, data: { payments } });
  } catch (err) {
    console.error('Error fetching all payments:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── PATCH /invoices/payments/:paymentId — edit an existing payment record ──
// Invoice link and verifier are immutable; invoice totals are recomputed from the DB.
const EDITABLE_PAYMENT_FIELDS = ['payment_method', 'payment_amount', 'payment_reference_no', 'remarks', 'verified_at'];

const validatePaymentEdit = (body) => {
  const errors = {};
  const values = {};

  if (body.payment_method !== undefined) {
    if (!VALID_PAYMENT_METHODS.includes(body.payment_method)) {
      errors.payment_method = `Must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`;
    } else {
      values.payment_method = body.payment_method;
    }
  }

  if (body.payment_amount !== undefined) {
    const raw = body.payment_amount;
    const amount = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      errors.payment_amount = 'Amount must be a positive number';
    } else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      errors.payment_amount = 'Amount can have at most 2 decimal places';
    } else {
      values.payment_amount = Math.round(amount * 100) / 100;
    }
  }

  if (body.payment_reference_no !== undefined) {
    if (body.payment_reference_no !== null && typeof body.payment_reference_no !== 'string') {
      errors.payment_reference_no = 'Reference number must be text';
    } else {
      const ref = (body.payment_reference_no || '').trim();
      if (ref.length > 255) errors.payment_reference_no = 'Reference number must be 255 characters or fewer';
      else values.payment_reference_no = ref || null;
    }
  }

  if (body.remarks !== undefined) {
    if (body.remarks !== null && typeof body.remarks !== 'string') {
      errors.remarks = 'Remarks must be text';
    } else {
      const remarks = (body.remarks || '').trim();
      if (remarks.length > 2000) errors.remarks = 'Remarks must be 2000 characters or fewer';
      else values.remarks = remarks || null;
    }
  }

  if (body.verified_at !== undefined) {
    const d = typeof body.verified_at === 'string' ? new Date(body.verified_at) : null;
    if (!d || isNaN(d.getTime())) {
      errors.verified_at = 'Payment date is invalid';
    } else if (d.getTime() > Date.now() + 5 * 60 * 1000) {
      errors.verified_at = 'Payment date cannot be in the future';
    } else if (d.getFullYear() < 2000) {
      errors.verified_at = 'Payment date is too far in the past';
    } else {
      values.verified_at = d;
    }
  }

  return { errors, values };
};

router.patch('/payments/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : null;

  // Store (shop) accounts may never edit payments, only staff roles
  if (req.headers['x-shop-id'] || !userRole || !['Admin', 'Seller', 'Sales Executive'].includes(userRole)) {
    return res.status(403).json({ success: false, message: 'Access denied: You are not allowed to edit payments' });
  }

  if (!/^\d+$/.test(String(paymentId))) {
    return res.status(400).json({ success: false, message: 'Invalid payment ID' });
  }

  const body = req.body || {};
  const immutable = Object.keys(body).filter((k) => !EDITABLE_PAYMENT_FIELDS.includes(k));
  if (immutable.length > 0) {
    return res.status(400).json({
      success: false,
      message: `These fields cannot be edited: ${immutable.join(', ')}`
    });
  }

  const { errors, values } = validatePaymentEdit(body);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, message: 'Please correct the highlighted fields.', errors });
  }
  if (Object.keys(values).length === 0) {
    return res.status(400).json({ success: false, message: 'No editable fields provided' });
  }

  const t = await sequelize.transaction();
  try {
    const existing = await InvoicePaymentHistory.findByPk(paymentId, { transaction: t });
    if (!existing) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    // Lock the invoice first (same order as payment recording), then the payment row
    const invoice = await Invoice.findByPk(existing.invoice_id, { transaction: t, lock: true });
    if (!invoice) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Invoice for this payment not found' });
    }

    const access = await checkInvoiceAccess(invoice.order_id, req.headers);
    if (!access.hasAccess) {
      await t.rollback();
      return res.status(access.status).json({ success: false, message: access.message });
    }

    if (invoice.payment_status === 'settled') {
      await t.rollback();
      return res.status(409).json({
        success: false,
        message: 'This invoice has been settled. Its payments are locked and can no longer be edited.'
      });
    }

    const payment = await InvoicePaymentHistory.findByPk(paymentId, { transaction: t, lock: true });

    // Only keep fields whose value actually changes
    const previous = {};
    const next = {};
    for (const [key, val] of Object.entries(values)) {
      const cur = payment[key];
      const same = key === 'verified_at'
        ? new Date(cur).getTime() === val.getTime()
        : key === 'payment_amount'
          ? Math.abs(Number(cur) - val) < 0.005
          : (cur ?? null) === val;
      if (!same) {
        previous[key] = cur;
        next[key] = val;
      }
    }

    if (Object.keys(next).length === 0) {
      await t.rollback();
      return res.status(200).json({ success: true, message: 'No changes to save', data: { payment } });
    }

    if (next.payment_amount !== undefined) {
      const otherPaid = Number(await InvoicePaymentHistory.sum('payment_amount', {
        where: { invoice_id: invoice.id, id: { [Op.ne]: payment.id } },
        transaction: t
      })) || 0;
      const newTotal = Math.round((otherPaid + next.payment_amount) * 100) / 100;
      const credited = Number(invoice.total_credited_amount) || 0;

      if (newTotal + credited > invoice.final_amount + 0.005) {
        await t.rollback();
        const maxAllowed = Math.max(0, invoice.final_amount - otherPaid - credited);
        return res.status(400).json({
          success: false,
          message: credited > 0.005
            ? `Amount would exceed the invoice total of $${invoice.final_amount.toFixed(2)} less $${credited.toFixed(2)} in credit notes.`
            : `Amount would exceed the invoice total of $${invoice.final_amount.toFixed(2)}.`,
          errors: { payment_amount: `Maximum allowed for this payment is $${maxAllowed.toFixed(2)}` }
        });
      }

      await invoice.update({
        total_paid_amount: newTotal,
        ...computeInvoiceBalance(invoice.final_amount, newTotal, credited),
      }, { transaction: t });
    }

    await payment.update(next, { transaction: t });

    await PaymentEditLog.create({
      payment_id: payment.id,
      invoice_id: invoice.id,
      user_id: userId,
      previous_value: previous,
      new_value: next,
    }, { transaction: t });

    await t.commit();

    const updatedPayment = await InvoicePaymentHistory.findByPk(payment.id, {
      include: [
        { model: Invoice, include: [{ model: Order, include: [Shop] }] },
        { model: User, as: 'VerifiedBy', attributes: ['id', 'name'] }
      ]
    });

    return res.json({ success: true, message: 'Payment updated successfully', data: { payment: updatedPayment } });
  } catch (err) {
    await t.rollback();
    console.error('Error updating payment:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /invoices/:orderId/pdf — one invoice PDF as a file download ──
// Used by the admin panel's multi-invoice download, which fetches the selected invoices one by one. The stored
// PDF is on S3 without CORS headers, so the browser can't read it directly; this returns it from here with a
// download filename. If the stored copy can't be fetched it is rendered with the normal invoice generator
// (the stored invoice is never rewritten). Same access rules as GET /invoices/:orderId.
const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const PDF_FETCH_TIMEOUT_MS = 30000;

router.get('/:orderId/pdf', async (req, res) => {
  const { orderId } = req.params;
  try {
    const access = await checkInvoiceAccess(orderId, req.headers);
    if (!access.hasAccess) return res.status(access.status).json({ success: false, message: access.message });

    const invoice = await Invoice.findOne({ where: { order_id: orderId }, attributes: ['id', 'pdf_url'] });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const shop = await Shop.findByPk(access.order.shop_id);

    let pdf = null;
    if (invoice.pdf_url) {
      try {
        const r = await fetch(invoice.pdf_url, { signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.subarray(0, 5).toString() === '%PDF-') pdf = buf;
        }
      } catch (e) { /* fall back to rendering */ }
    }
    if (!pdf) {
      if (!shop) return res.status(502).json({ success: false, message: 'Invoice PDF could not be fetched or generated' });
      const full = await Order.findByPk(orderId, { include: [{ model: OrderItem, include: [Product] }] });
      pdf = await generateInvoicePDFBuffer(full, shop);
    }

    const name = `INV-${orderId}_WS-${orderId}${shop ? `_${safeName(shop.shop_name)}` : ''}.pdf`;
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return res.end(pdf);
  } catch (err) {
    console.error('Error downloading invoice PDF:', err);
    return res.status(500).json({ success: false, message: 'Failed to download invoice PDF' });
  }
});

// ── GET /invoices/:orderId — get invoice by order ID ──
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const access = await checkInvoiceAccess(orderId, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }
    const invoice = await Invoice.findOne({
      where: { order_id: orderId },
      include: [
        Order,
        {
          ...PAYMENT_HISTORY_INCLUDE,
          separate: true,
          order: [['created_at', 'DESC']]
        }
      ]
    });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    return res.json({ success: true, message: 'Invoice fetched successfully', data: { invoice } });
  } catch (err) {
    console.error('Error fetching invoice:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── POST /invoices/:orderId/generate ──
router.post('/:orderId/generate', async (req, res) => {
  const { orderId } = req.params;

  try {
    const access = await checkInvoiceAccess(orderId, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    let invoice = await Invoice.findOne({ where: { order_id: orderId }, include: [Order] });
    if (invoice && invoice.pdf_url) {
      return res.json({
        success: true,
        message: 'Invoice already exists',
        data: { invoice }
      });
    }

    const order = await Order.findByPk(orderId, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const shop = await Shop.findByPk(order.shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop details not found for order' });
    }

    let pdfUrl = null;
    try {
      pdfUrl = await uploadInvoicePDF(order, shop);
    } catch (pdfErr) {
      console.error('Failed to generate/upload invoice PDF:', pdfErr);
      return res.status(500).json({ success: false, message: 'Failed to generate/upload invoice PDF' });
    }

    const finalAmount = order.total_amount;

    if (!invoice) {
      invoice = await Invoice.create({
        order_id: order.id,
        final_amount: finalAmount,
        generated_at: new Date(),
        pdf_url: pdfUrl
      });
    } else {
      invoice.final_amount = finalAmount;
      invoice.pdf_url = pdfUrl;
      invoice.generated_at = new Date();
      await invoice.save();
    }

    return res.json({
      success: true,
      message: 'Invoice generated successfully',
      data: { invoice }
    });
  } catch (err) {
    console.error('Error generating invoice:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── POST /invoices/:invoiceId/regenerate ──
router.post('/:invoiceId/regenerate', async (req, res) => {
  const { invoiceId } = req.params;

  try {
    const invoice = await Invoice.findByPk(invoiceId, { include: [Order] });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const access = await checkInvoiceAccess(invoice.order_id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const order = await Order.findByPk(invoice.order_id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found for invoice' });
    }

    const shop = await Shop.findByPk(order.shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop details not found for order' });
    }

    let pdfUrl = null;
    try {
      pdfUrl = await uploadInvoicePDF(order, shop);
    } catch (pdfErr) {
      console.error('Failed to generate/upload invoice PDF:', pdfErr);
      return res.status(500).json({ success: false, message: 'Failed to generate/upload invoice PDF' });
    }

    invoice.final_amount = order.total_amount;
    invoice.pdf_url = pdfUrl;
    invoice.generated_at = new Date();
    await invoice.save();

    return res.json({
      success: true,
      message: 'Invoice regenerated successfully',
      data: { invoice }
    });
  } catch (err) {
    console.error('Error regenerating invoice:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /invoices/:invoiceId/payments — payment history for one invoice ──
router.get('/:invoiceId/payments', async (req, res) => {
  const { invoiceId } = req.params;

  try {
    const invoice = await Invoice.findByPk(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const access = await checkInvoiceAccess(invoice.order_id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const payments = await InvoicePaymentHistory.findAll({
      where: { invoice_id: invoiceId },
      include: [{ model: User, as: 'VerifiedBy', attributes: ['id', 'name'] }],
      order: [['created_at', 'DESC']]
    });
    return res.json({ success: true, data: { payments } });
  } catch (err) {
    console.error('Error fetching invoice payments:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── POST /invoices/:invoiceId/payments — record a new payment ──
router.post('/:invoiceId/payments', async (req, res) => {
  const { invoiceId } = req.params;
  const { payment_method, payment_amount, payment_reference_no, remarks } = req.body;

  const VALID_METHODS = ['Cash', 'Card', 'Check', 'MO', 'Adjusted'];
  if (!payment_method || !VALID_METHODS.includes(payment_method)) {
    return res.status(400).json({
      success: false,
      message: `payment_method is required and must be one of: ${VALID_METHODS.join(', ')}`
    });
  }

  const amount = Number(payment_amount);
  if (!payment_amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'payment_amount must be a positive number' });
  }

  const t = await sequelize.transaction();
  try {
    const invoice = await Invoice.findByPk(invoiceId, { transaction: t, lock: true });
    if (!invoice) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const access = await checkInvoiceAccess(invoice.order_id, req.headers);
    if (!access.hasAccess) {
      await t.rollback();
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const currentPaid = Number(invoice.total_paid_amount) || 0;
    const credited = Number(invoice.total_credited_amount) || 0;
    const newTotal = currentPaid + amount;

    if (newTotal + credited > invoice.final_amount + 0.005) {
      await t.rollback();
      const remaining = Math.max(0, invoice.final_amount - currentPaid - credited);
      return res.status(400).json({
        success: false,
        message: `Payment of $${amount.toFixed(2)} would exceed the remaining balance of $${remaining.toFixed(2)}.`
      });
    }

    const verifiedByUserId = req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : null;

    await InvoicePaymentHistory.create({
      invoice_id: Number(invoiceId),
      payment_method,
      payment_amount: amount,
      payment_reference_no: payment_reference_no || null,
      remarks: remarks || null,
      verified_by_user_id: verifiedByUserId,
      verified_at: new Date(),
    }, { transaction: t });

    const { remaining_balance, payment_status: newStatus } = computeInvoiceBalance(invoice.final_amount, newTotal, credited);

    await invoice.update({
      total_paid_amount: newTotal,
      remaining_balance,
      payment_status: newStatus,
    }, { transaction: t });

    await t.commit();

    // Return updated invoice with full payment history
    const updatedInvoice = await Invoice.findByPk(invoiceId, {
      include: [
        {
          ...PAYMENT_HISTORY_INCLUDE,
          separate: true,
          order: [['created_at', 'DESC']]
        }
      ]
    });

    const statusMsg = newStatus === 'paid' ? 'Invoice fully paid' : 'Partial payment recorded';
    return res.json({ success: true, message: statusMsg, data: { invoice: updatedInvoice } });
  } catch (err) {
    await t.rollback();
    console.error('Error recording payment:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Credit notes applied to invoices (credit adjustments, not payments) ──
const canApplyCredit = (headers) => !headers['x-shop-id'] && ['Admin', 'Seller'].includes(headers['x-user-role']);

const creditNoteSummary = (cn, order) => ({
  id: cn.id,
  credit_note_number: cn.credit_note_number,
  order_number: `WS-${cn.order_id}`,
  invoice_number: `INV-${cn.order_id}`,
  shop_id: order?.shop_id,
  issued_at: cn.issued_at,
  amount: cn.amount,
  used_amount: Number(cn.used_amount) || 0,
  remaining_amount: remainingOf(cn),
  usage_status: usageStatusOf(cn),
  pdf_url: cn.pdf_url,
});

// ── GET /invoices/:invoiceId/available-credit-notes — the invoice store's credit notes with credit left ──
router.get('/:invoiceId/available-credit-notes', async (req, res) => {
  if (!canApplyCredit(req.headers)) return res.status(403).json({ success: false, message: 'Access denied' });
  if (!/^\d+$/.test(String(req.params.invoiceId))) return res.status(400).json({ success: false, message: 'Invalid invoice ID' });
  try {
    const invoice = await Invoice.findByPk(req.params.invoiceId, { include: [Order] });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const notes = await CreditNote.findAll({
      include: [{ model: Order, attributes: ['id', 'shop_id'], where: { shop_id: invoice.Order.shop_id } }],
      order: [['issued_at', 'ASC']],
    });
    const { outstanding } = await outstandingOf(invoice);
    return res.json({
      success: true,
      data: {
        invoice_outstanding: outstanding,
        credit_notes: notes.map((cn) => creditNoteSummary(cn, cn.Order)).filter((cn) => cn.remaining_amount > 0.005),
      }
    });
  } catch (err) {
    console.error('Error fetching available credit notes:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── POST /invoices/:invoiceId/credit-applications — apply (part of) a credit note to this invoice ──
// body: { credit_note_number, amount, request_key }
router.post('/:invoiceId/credit-applications', async (req, res) => {
  if (!canApplyCredit(req.headers)) {
    return res.status(403).json({ success: false, message: 'Access denied: Only Admin or Seller users can apply credit notes' });
  }
  const { invoiceId } = req.params;
  if (!/^\d+$/.test(String(invoiceId))) return res.status(400).json({ success: false, message: 'Invalid invoice ID' });

  const { credit_note_number, amount: rawAmount, request_key } = req.body || {};
  const errors = {};
  const number = typeof credit_note_number === 'string' ? credit_note_number.trim().toUpperCase() : '';
  if (!/^CN-\d+-\d+$/.test(number)) errors.credit_note_number = 'Enter a credit note number like CN-12-1';
  const amount = typeof rawAmount === 'string' && rawAmount.trim() !== '' ? Number(rawAmount) : rawAmount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) errors.amount = 'Amount must be a positive number';
  else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) errors.amount = 'Amount can have at most 2 decimal places';
  if (typeof request_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request_key)) errors.request_key = 'A request key is required';
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, message: 'Please correct the highlighted fields.', errors });
  }
  const applyAmount = Math.round(amount * 100) / 100;
  const userId = req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : null;

  try {
    let application;
    await sequelize.transaction(async (t) => {
      // Lock order: invoice, then credit note (same as returns and backfill)
      const invoice = await Invoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!invoice) { const e = new Error('Invoice not found'); e.statusCode = 404; throw e; }
      if (invoice.payment_status === 'settled') {
        const e = new Error('This invoice has been settled and can no longer be adjusted.'); e.statusCode = 409; throw e;
      }
      const duplicate = await CreditNoteApplication.findOne({ where: { request_key }, transaction: t });
      if (duplicate) {
        const e = new Error('This credit application has already been recorded.'); e.statusCode = 409;
        e.extra = { duplicate_application_id: duplicate.id }; throw e;
      }

      const creditNote = await CreditNote.findOne({ where: { credit_note_number: number }, transaction: t, lock: t.LOCK.UPDATE });
      if (!creditNote) { const e = new Error(`Credit note ${number} was not found.`); e.statusCode = 404; e.extra = { errors: { credit_note_number: e.message } }; throw e; }

      const [invoiceOrder, creditOrder] = await Promise.all([
        Order.findByPk(invoice.order_id, { transaction: t }),
        Order.findByPk(creditNote.order_id, { transaction: t }),
      ]);
      if (!invoiceOrder || !creditOrder || invoiceOrder.shop_id !== creditOrder.shop_id) {
        const e = new Error(`Credit note ${number} belongs to a different store and cannot be applied to this invoice.`);
        e.statusCode = 400; e.extra = { errors: { credit_note_number: e.message } }; throw e;
      }
      if (creditNote.used_amount === null) {
        const e = new Error('This credit note is still being migrated. Please try again shortly.'); e.statusCode = 409; throw e;
      }

      const remaining = remainingOf(creditNote);
      if (applyAmount > remaining + 0.005) {
        const e = new Error(remaining <= 0.005
          ? `Credit note ${number} has been fully used.`
          : `Credit note ${number} only has $${remaining.toFixed(2)} available.`);
        e.statusCode = 400; e.extra = { errors: { amount: e.message } }; throw e;
      }
      const { outstanding } = await outstandingOf(invoice, t);
      if (applyAmount > outstanding + 0.005) {
        const e = new Error(`This invoice only has $${outstanding.toFixed(2)} outstanding.`);
        e.statusCode = 400; e.extra = { errors: { amount: e.message } }; throw e;
      }

      application = await applyCreditToInvoice({
        creditNote, invoice, shopId: invoiceOrder.shop_id, amount: applyAmount,
        source: 'manual', userId, requestKey: request_key, transaction: t,
      });
    });

    const updatedInvoice = await Invoice.findByPk(invoiceId, {
      include: [{ ...PAYMENT_HISTORY_INCLUDE, separate: true, order: [['created_at', 'DESC']] }]
    });
    const creditNote = await CreditNote.findByPk(application.credit_note_id, { include: [{ model: Order, attributes: ['id', 'shop_id'] }] });
    return res.status(201).json({
      success: true,
      message: `$${application.amount.toFixed(2)} from ${creditNote.credit_note_number} applied to INV-${updatedInvoice.order_id}.`,
      data: { invoice: updatedInvoice, credit_note: creditNoteSummary(creditNote, creditNote.Order), application }
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message, ...(err.extra || {}) });
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'This credit application has already been recorded.' });
    }
    console.error('Error applying credit note:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
