const express = require('express');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');

const router = express.Router();

// Create order
router.post('/', async (req, res) => {
  const { shop_id, total_amount, items } = req.body;
  if (!shop_id || total_amount === undefined || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Invalid order data' });
  }

  try {
    const order = await Order.create({ shop_id, total_amount, status: 'pending' });

    const orderItems = items.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      requested_qty: item.requested_qty,
      approved_qty: 0,
      price: item.price,
    }));

    await OrderItem.bulkCreate(orderItems);

    return res.status(201).json({ success: true, message: 'Order created successfully', data: { order, items: orderItems } });
  } catch (err) {
    console.error('Error creating order:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get orders
router.get('/', async (req, res) => {
  try {
    const orders = await Order.findAll({
      include: [{
        model: OrderItem,
        include: [Product]
      }],
      order: [['created_at', 'DESC']]
    });
    return res.json({ success: true, message: 'Orders fetched successfully', data: { orders } });
  } catch (err) {
    console.error('Error fetching orders:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get order by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const order = await Order.findByPk(id, {
      include: [{
        model: OrderItem,
        include: [Product]
      }]
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    return res.json({ success: true, message: 'Order fetched successfully', data: { order } });
  } catch (err) {
    console.error('Error fetching order:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Process order (update approved quantities and recalculate total)
router.patch('/:id/process', async (req, res) => {
  const { id } = req.params;
  const { items } = req.body; // Array of { id: order_item_id, approved_qty: number }

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to process order' });
  }

  try {
    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot process order in ${order.status} status` });
    }

    let recalculatedTotal = 0;

    // Update each order item
    for (const updateItem of items) {
      const orderItem = await OrderItem.findOne({ 
        where: { id: updateItem.id, order_id: order.id } 
      });
      
      if (orderItem) {
        orderItem.approved_qty = updateItem.approved_qty;
        await orderItem.save();
        recalculatedTotal += orderItem.price * updateItem.approved_qty;
      }
    }

    order.total_amount = recalculatedTotal;
    order.status = 'approved';
    order.approved_at = new Date();
    await order.save();

    // Fetch the updated order with full details
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    return res.json({ success: true, message: 'Order processed successfully', data: { order: updatedOrder } });
  } catch (err) {
    console.error('Error processing order:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update order status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'approved', 'processed', 'dispatched', 'delivered', 'completed'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `Valid status (${validStatuses.join(', ')}) is required` });
  }

  try {
    const order = await Order.findByPk(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Enforce basic flow constraints if necessary, or just allow transitions
    if (order.status === 'completed' || order.status === 'delivered') {
      if (status !== 'completed' && status !== 'delivered') {
        return res.status(400).json({ success: false, message: 'Cannot change status of a completed/delivered order' });
      }
    }

    order.status = status;
    
    // Set appropriate timestamps based on the status set
    const now = new Date();
    if (status === 'approved' || status === 'processed') {
      order.approved_at = now;
    } else if (status === 'dispatched') {
      order.dispatched_at = now;
    } else if (status === 'delivered' || status === 'completed') {
      order.delivered_at = now;
      if (!order.approved_at) order.approved_at = now;
      if (!order.dispatched_at) order.dispatched_at = now;
    }

    await order.save();

    // If order is completed or delivered, automatically generate an invoice if it doesn't already exist
    if (status === 'completed' || status === 'delivered') {
      const existingInvoice = await Invoice.findOne({ where: { order_id: order.id } });
      if (!existingInvoice) {
        await Invoice.create({
          order_id: order.id,
          final_amount: order.total_amount,
          generated_at: now
        });
      }
    }

    return res.json({ success: true, message: 'Order status updated successfully', data: { order } });
  } catch (err) {
    console.error('Error updating order status:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT approve order (sets status to 'processed' and updates approved quantities)
router.put('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { items } = req.body; // Array of { id: order_item_id, approved_qty: number }

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to approve order' });
  }

  try {
    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    let recalculatedTotal = 0;

    // Update each order item's approved_qty
    for (const updateItem of items) {
      const orderItem = await OrderItem.findOne({ 
        where: { id: updateItem.id, order_id: order.id } 
      });
      
      if (orderItem) {
        orderItem.approved_qty = updateItem.approved_qty;
        await orderItem.save();
        recalculatedTotal += orderItem.price * updateItem.approved_qty;
      }
    }

    order.total_amount = recalculatedTotal;
    order.status = 'approved';
    order.approved_at = new Date();
    await order.save();

    // Fetch the updated order with full details
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    return res.json({ success: true, message: 'Order approved and processed successfully', data: { order: updatedOrder } });
  } catch (err) {
    console.error('Error approving order:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;