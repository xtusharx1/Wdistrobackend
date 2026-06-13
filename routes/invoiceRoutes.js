const express = require('express');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const { uploadInvoicePDF } = require('../services/pdfService');

const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');

const router = express.Router();

const checkInvoiceSalesExecutiveAccess = async (orderId, userId, userRole) => {
  if (userRole !== 'Sales Executive') return true;
  const order = await Order.findByPk(orderId);
  if (!order) return true;
  const assignment = await SalesExecutiveAssignment.findOne({
    where: { sales_exec_id: userId, shop_id: order.shop_id, end_date: null }
  });
  return !!assignment;
};

// Get invoice by order ID
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    const hasAccess = await checkInvoiceSalesExecutiveAccess(orderId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
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
  const shipping_charge = parseFloat(req.body.shipping_charge || 0);
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    const hasAccess = await checkInvoiceSalesExecutiveAccess(orderId, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
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
      pdfUrl = await uploadInvoicePDF(order, shop, shipping_charge);
    } catch (pdfErr) {
      console.error('Failed to generate/upload invoice PDF:', pdfErr);
      return res.status(500).json({ success: false, message: 'Failed to generate/upload invoice PDF' });
    }

    const finalAmount = order.total_amount + shipping_charge;

    if (!invoice) {
      invoice = await Invoice.create({
        order_id: order.id,
        final_amount: finalAmount,
        shipping_charge: shipping_charge,
        generated_at: new Date(),
        pdf_url: pdfUrl
      });
    } else {
      invoice.final_amount = finalAmount;
      invoice.shipping_charge = shipping_charge;
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
  const shipping_charge = parseFloat(req.body.shipping_charge || 0);
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    const invoice = await Invoice.findByPk(invoiceId, { include: [Order] });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const hasAccess = await checkInvoiceSalesExecutiveAccess(invoice.order_id, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
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
      pdfUrl = await uploadInvoicePDF(order, shop, shipping_charge);
    } catch (pdfErr) {
      console.error('Failed to generate/upload invoice PDF:', pdfErr);
      return res.status(500).json({ success: false, message: 'Failed to generate/upload invoice PDF' });
    }

    invoice.final_amount = order.total_amount + shipping_charge;
    invoice.shipping_charge = shipping_charge;
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