const express = require('express');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Shop = require('../models/Shop');
const { uploadInvoicePDF } = require('../services/pdfService');
const sequelize = require('../config/db');
const StockMovement = require('../models/StockMovement');

const router = express.Router();

// Create order
router.post('/', async (req, res) => {
  const { shop_id, total_amount, items } = req.body;
  if (!shop_id || total_amount === undefined || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Invalid order data' });
  }

  try {
    for (const item of items) {
      const product = await Product.findByPk(item.product_id);
      if (!product) {
        return res.status(404).json({ success: false, message: `Product with ID ${item.product_id} not found` });
      }
      if (item.requested_qty > product.stock_quantity) {
        return res.status(400).json({ success: false, message: 'Requested quantity exceeds available stock.' });
      }
    }

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

const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');

// Get orders
router.get('/', async (req, res) => {
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    let whereClause = {};
    if (userRole === 'Sales Executive') {
      const assignments = await SalesExecutiveAssignment.findAll({
        where: { sales_exec_id: userId, end_date: null }
      });
      const shopIds = assignments.map(a => a.shop_id);
      whereClause = { shop_id: shopIds };
    }

    const orders = await Order.findAll({
      where: whereClause,
      include: [
        {
          model: OrderItem,
          include: [Product]
        },
        {
          model: Invoice
        }
      ],
      order: [['created_at', 'DESC']]
    });
    return res.json({ success: true, message: 'Orders fetched successfully', data: { orders } });
  } catch (err) {
    console.error('Error fetching orders:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

const checkSalesExecutiveAccess = async (orderId, userId, userRole) => {
  if (userRole !== 'Sales Executive') return true;
  const order = await Order.findByPk(orderId);
  if (!order) return true; // Let main handler return 404
  const assignment = await SalesExecutiveAssignment.findOne({
    where: { sales_exec_id: userId, shop_id: order.shop_id, end_date: null }
  });
  return !!assignment;
};

// Get order by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    const hasAccess = await checkSalesExecutiveAccess(id, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
    }

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
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to process order' });
  }

  try {
    const hasAccess = await checkSalesExecutiveAccess(id, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
    }

    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot process order in ${order.status} status` });
    }

    let recalculatedTotal = 0;

    await sequelize.transaction(async (t) => {
      // Update each order item
      for (const updateItem of items) {
        const orderItem = await OrderItem.findOne({ 
          where: { id: updateItem.id, order_id: order.id },
          transaction: t
        });
        
        if (orderItem) {
          const product = await Product.findByPk(orderItem.product_id, {
            transaction: t,
            lock: t.LOCK.UPDATE
          });
          if (!product) {
            throw new Error('Product not found');
          }
          if (updateItem.approved_qty > product.stock_quantity) {
            const err = new Error('Requested quantity exceeds available stock.');
            err.statusCode = 400;
            throw err;
          }

          const prevStock = product.stock_quantity;
          product.stock_quantity -= updateItem.approved_qty;
          await product.save({ transaction: t });

          // Log StockMovement
          await StockMovement.create({
            product_id: product.id,
            quantity_changed: -updateItem.approved_qty,
            previous_stock: prevStock,
            new_stock: product.stock_quantity,
            order_id: order.id,
            action: 'Approval'
          }, { transaction: t });

          orderItem.approved_qty = updateItem.approved_qty;
          orderItem.custom_price = (updateItem.custom_price !== undefined && updateItem.custom_price !== null && updateItem.custom_price !== '') ? parseFloat(updateItem.custom_price) : null;
          await orderItem.save({ transaction: t });
          
          const effectivePrice = (orderItem.custom_price !== null && orderItem.custom_price !== undefined) ? orderItem.custom_price : orderItem.price;
          recalculatedTotal += effectivePrice * updateItem.approved_qty;
        }
      }

      order.total_amount = recalculatedTotal;
      order.status = 'approved';
      order.approved_at = new Date();
      await order.save({ transaction: t });
    });

    // Fetch the updated order with full details
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    return res.json({ success: true, message: 'Order processed successfully', data: { order: updatedOrder } });
  } catch (err) {
    console.error('Error processing order:', err);
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update order status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  const validStatuses = ['pending', 'approved', 'processed', 'dispatched', 'delivered', 'completed', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `Valid status (${validStatuses.join(', ')}) is required` });
  }

  try {
    const hasAccess = await checkSalesExecutiveAccess(id, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
    }

    const order = await Order.findByPk(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (status === 'cancelled') {
      if (order.status === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Order is already cancelled' });
      }

      const previousStatus = order.status;

      await sequelize.transaction(async (t) => {
        if (previousStatus !== 'pending') {
          const orderItems = await OrderItem.findAll({
            where: { order_id: order.id },
            transaction: t
          });

          for (const item of orderItems) {
            if (item.approved_qty > 0) {
              const product = await Product.findByPk(item.product_id, {
                transaction: t,
                lock: t.LOCK.UPDATE
              });
              if (product) {
                const prevStock = product.stock_quantity;
                product.stock_quantity += item.approved_qty;
                await product.save({ transaction: t });

                // Log StockMovement
                await StockMovement.create({
                  product_id: product.id,
                  quantity_changed: item.approved_qty,
                  previous_stock: prevStock,
                  new_stock: product.stock_quantity,
                  order_id: order.id,
                  action: 'Cancellation'
                }, { transaction: t });
              }
            }
          }
        }

        order.status = 'cancelled';
        await order.save({ transaction: t });
      });

      return res.json({ success: true, message: 'Order cancelled successfully', data: { order } });
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

    // If order is dispatched, completed or delivered, automatically generate an invoice if it doesn't already exist
    if (status === 'dispatched' || status === 'completed' || status === 'delivered') {
      let invoice = await Invoice.findOne({ where: { order_id: order.id } });
      const fullOrder = await Order.findByPk(order.id, {
        include: [{ model: OrderItem, include: [Product] }]
      });
      const shop = await Shop.findByPk(order.shop_id);

      if (!invoice) {
        let pdfUrl = null;
        if (shop) {
          try {
            pdfUrl = await uploadInvoicePDF(fullOrder, shop);
          } catch (pdfErr) {
            console.error('Failed to generate/upload invoice PDF:', pdfErr);
          }
        }
        await Invoice.create({
          order_id: order.id,
          final_amount: order.total_amount,
          shipping_charge: 0,
          generated_at: now,
          pdf_url: pdfUrl
        });
      } else if (!invoice.pdf_url) {
        if (shop) {
          try {
            const pdfUrl = await uploadInvoicePDF(fullOrder, shop);
            invoice.pdf_url = pdfUrl;
            await invoice.save();
          } catch (pdfErr) {
            console.error('Failed to generate/upload invoice PDF for existing invoice:', pdfErr);
          }
        }
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
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to approve order' });
  }

  try {
    const hasAccess = await checkSalesExecutiveAccess(id, userId, userRole);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
    }

    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot approve order in ${order.status} status` });
    }

    let recalculatedTotal = 0;

    await sequelize.transaction(async (t) => {
      // Update each order item's approved_qty
      for (const updateItem of items) {
        const orderItem = await OrderItem.findOne({ 
          where: { id: updateItem.id, order_id: order.id },
          transaction: t
        });
        
        if (orderItem) {
          const product = await Product.findByPk(orderItem.product_id, {
            transaction: t,
            lock: t.LOCK.UPDATE
          });
          if (!product) {
            throw new Error('Product not found');
          }
          if (updateItem.approved_qty > product.stock_quantity) {
            const err = new Error('Requested quantity exceeds available stock.');
            err.statusCode = 400;
            throw err;
          }

          const prevStock = product.stock_quantity;
          product.stock_quantity -= updateItem.approved_qty;
          await product.save({ transaction: t });

          // Log StockMovement
          await StockMovement.create({
            product_id: product.id,
            quantity_changed: -updateItem.approved_qty,
            previous_stock: prevStock,
            new_stock: product.stock_quantity,
            order_id: order.id,
            action: 'Approval'
          }, { transaction: t });

          orderItem.approved_qty = updateItem.approved_qty;
          orderItem.custom_price = (updateItem.custom_price !== undefined && updateItem.custom_price !== null && updateItem.custom_price !== '') ? parseFloat(updateItem.custom_price) : null;
          await orderItem.save({ transaction: t });

          const effectivePrice = (orderItem.custom_price !== null && orderItem.custom_price !== undefined) ? orderItem.custom_price : orderItem.price;
          recalculatedTotal += effectivePrice * updateItem.approved_qty;
        }
      }

      order.total_amount = recalculatedTotal;
      order.status = 'approved';
      order.approved_at = new Date();
      await order.save({ transaction: t });
    });

    // Fetch the updated order with full details
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    return res.json({ success: true, message: 'Order approved and processed successfully', data: { order: updatedOrder } });
  } catch (err) {
    console.error('Error approving order:', err);
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;