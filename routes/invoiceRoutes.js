const express = require('express');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const { uploadInvoicePDF } = require('../services/pdfService');

const router = express.Router();

// Get invoice by order ID
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
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

// Generate invoice manually (or return existing if already generated)
router.post('/:orderId/generate', async (req, res) => {
  const { orderId } = req.params;

  try {
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

    if (!invoice) {
      invoice = await Invoice.create({
        order_id: order.id,
        final_amount: order.total_amount,
        generated_at: new Date(),
        pdf_url: pdfUrl
      });
    } else {
      invoice.pdf_url = pdfUrl;
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

module.exports = router;