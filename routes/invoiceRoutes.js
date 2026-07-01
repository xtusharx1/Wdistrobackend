const express = require('express');
const Invoice = require('../models/Invoice');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const User = require('../models/User');
const { uploadInvoicePDF } = require('../services/pdfService');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const sequelize = require('../config/db');

const router = express.Router();

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
    const newTotal = currentPaid + amount;

    if (newTotal > invoice.final_amount + 0.005) {
      await t.rollback();
      const remaining = invoice.final_amount - currentPaid;
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

    const remaining = invoice.final_amount - newTotal;
    const newStatus = newTotal >= invoice.final_amount - 0.005 ? 'paid' : 'partially_paid';

    await invoice.update({
      total_paid_amount: newTotal,
      remaining_balance: remaining < 0.005 ? 0 : remaining,
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

module.exports = router;
