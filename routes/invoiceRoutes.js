const express = require('express');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const { uploadInvoicePDF } = require('../services/pdfService');

const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');

const router = express.Router();

const checkInvoiceAccess = async (orderId, headers) => {
  const shopId = headers['x-shop-id'];
  const userRole = headers['x-user-role'];
  const userId = headers['x-user-id'];

  const order = await Order.findByPk(orderId);
  if (!order) {
    return { hasAccess: false, status: 404, message: 'Order not found' };
  }

  // 1. If customer (shop)
  if (shopId) {
    if (String(order.shop_id) !== String(shopId)) {
      return { hasAccess: false, status: 403, message: 'Access denied: This invoice does not belong to your shop' };
    }
    return { hasAccess: true, order };
  }

  // 2. If platform user
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

  // Default: Deny access if no credentials are provided
  return { hasAccess: false, status: 401, message: 'Unauthorized: Access credentials missing' };
};

// Get invoice by order ID
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const access = await checkInvoiceAccess(orderId, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }
    const invoice = await Invoice.findOne({ where: { order_id: orderId }, include: [Order] });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    return res.json({ success: true, message: 'Invoice fetched successfully', data: { invoice } });
  } catch (err) {
    console.error('Error fetching invoice:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Generate invoice manually (creates if not exist)
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

// Regenerate invoice manually
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

module.exports = router;