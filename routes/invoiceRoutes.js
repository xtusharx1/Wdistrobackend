const express = require('express');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');

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

module.exports = router;