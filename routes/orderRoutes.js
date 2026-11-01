const express = require('express');
const Order = require('../models/Order');
const OrderItem = require('../models/OrderItem');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Shop = require('../models/Shop');
const { uploadInvoicePDF } = require('../services/pdfService');
const sequelize = require('../config/db');
const StockMovement = require('../models/StockMovement');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const OrderEditLog = require('../models/OrderEditLog');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const User = require('../models/User');
const { getProductEffectivePricing } = require('../services/pricingService');
const { computeInvoiceBalance } = require('../services/invoiceBalanceService');
const OrderReturn = require('../models/OrderReturn');
const CreditNote = require('../models/CreditNote');
const CreditNoteApplication = require('../models/CreditNoteApplication');

const router = express.Router();

// Helper to check order access across roles/shops
const checkOrderAccess = async (orderId, headers) => {
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
      return { hasAccess: false, status: 403, message: 'Access denied: This order does not belong to your shop' };
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

// Create order (Customer App or Admin / Manual Order Creation)
router.post('/', async (req, res) => {
  const { shop_id, items, status: requestedStatus, source } = req.body;
  const shopIdHeader = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  if (!shop_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Shop and a valid items array are required' });
  }

  // Enforce order creation authorization
  if (shopIdHeader) {
    if (String(shop_id) !== String(shopIdHeader)) {
      return res.status(403).json({ success: false, message: 'Access denied: Cannot create order for another shop' });
    }
  } else if (userRole) {
    if (userRole === 'Sales Executive') {
      if (!userId) {
        return res.status(403).json({ success: false, message: 'Access denied: User ID is required' });
      }
      const assignment = await SalesExecutiveAssignment.findOne({
        where: { sales_exec_id: userId, shop_id, end_date: null }
      });
      if (!assignment) {
        return res.status(403).json({ success: false, message: 'Access denied: You are not assigned to this shop' });
      }
    } else if (userRole !== 'Admin' && userRole !== 'Seller') {
      return res.status(403).json({ success: false, message: 'Access denied: Invalid user role' });
    }
  } else {
    return res.status(401).json({ success: false, message: 'Unauthorized: Access credentials missing' });
  }

  const isAdminOrSeller = userRole === 'Admin' || userRole === 'Seller';
  const orderSource = source || (isAdminOrSeller ? 'Admin' : (userRole === 'Sales Executive' ? 'Sales Executive' : 'App'));
  const targetStatus = (isAdminOrSeller && requestedStatus === 'approved') ? 'approved' : 'pending';

  try {
    const shop = await Shop.findByPk(shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }
    if (!shop.approved) {
      return res.status(400).json({ success: false, message: 'Orders can only be created for approved stores' });
    }

    // Validate all items & stock server-side
    const validatedProducts = [];
    let calculatedTotal = 0;

    for (const item of items) {
      if (!item.product_id || !item.requested_qty || item.requested_qty <= 0) {
        return res.status(400).json({ success: false, message: 'Each item must have a valid product_id and positive quantity' });
      }

      const product = await Product.findByPk(item.product_id);
      if (!product) {
        return res.status(404).json({ success: false, message: `Product with ID ${item.product_id} not found` });
      }
      if (product.is_active === false) {
        return res.status(400).json({ success: false, message: `"${product.name}" is inactive and can't be added to a new order.` });
      }

      // License restrictions
      if (!isAdminOrSeller) {
        if (product.is_explicit_product && !shop.allow_explicit_products) {
          return res.status(403).json({ success: false, message: `Explicit product "${product.name}" is not allowed for this store.` });
        }
        if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
          return res.status(403).json({ success: false, message: `Seller Permit Required for product "${product.name}".` });
        }
        if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
          return res.status(403).json({ success: false, message: `Tobacco License Required for product "${product.name}".` });
        }
      }

      // Stock validation
      if (item.requested_qty > product.stock_quantity) {
        return res.status(400).json({
          success: false,
          message: `Requested quantity (${item.requested_qty}) for "${product.name}" exceeds available stock (${product.stock_quantity}).`
        });
      }

      // Server-side price calculation respecting deal price eligibility or custom price
      const pricing = await getProductEffectivePricing(product);
      const hasCustomPrice = item.custom_price !== undefined && item.custom_price !== null && item.custom_price !== '' && isAdminOrSeller;
      const customPriceNum = hasCustomPrice ? parseFloat(item.custom_price) : null;
      const effectiveUnitPrice = hasCustomPrice ? customPriceNum : pricing.effective_price;

      calculatedTotal += effectiveUnitPrice * item.requested_qty;

      validatedProducts.push({
        product,
        requested_qty: parseInt(item.requested_qty, 10),
        effectiveUnitPrice,
        itemPrice: pricing.effective_price,
        custom_price: customPriceNum
      });
    }

    let createdOrder;
    let createdItems;

    await sequelize.transaction(async (t) => {
      createdOrder = await Order.create({
        shop_id,
        total_amount: calculatedTotal,
        status: targetStatus,
        source: orderSource,
        approved_at: targetStatus === 'approved' ? new Date() : null
      }, { transaction: t });

      // Sort items in alphabetical order by product name
      validatedProducts.sort((a, b) => (a.product.name || '').localeCompare(b.product.name || '', undefined, { sensitivity: 'base' }));

      const orderItemsData = validatedProducts.map(({ product, requested_qty, itemPrice, custom_price }) => ({
        order_id: createdOrder.id,
        product_id: product.id,
        requested_qty,
        approved_qty: targetStatus === 'approved' ? requested_qty : null,
        price: itemPrice,
        custom_price
      }));

      createdItems = await OrderItem.bulkCreate(orderItemsData, { transaction: t });

      // If created directly in approved status, perform stock deduction and log stock movement
      if (targetStatus === 'approved') {
        for (const { product, requested_qty } of validatedProducts) {
          const lockedProduct = await Product.findByPk(product.id, { transaction: t, lock: t.LOCK.UPDATE });
          const prevStock = lockedProduct.stock_quantity;
          lockedProduct.stock_quantity -= requested_qty;
          await lockedProduct.save({ transaction: t });

          await StockMovement.create({
            product_id: lockedProduct.id,
            quantity_changed: -requested_qty,
            previous_stock: prevStock,
            new_stock: lockedProduct.stock_quantity,
            order_id: createdOrder.id,
            action: 'Manual Order Creation'
          }, { transaction: t });
        }
      }
    });

    // If approved, automatically generate the invoice and PDF
    if (targetStatus === 'approved') {
      try {
        const orderForInvoice = await Order.findByPk(createdOrder.id, {
          include: [{ model: OrderItem, include: [Product] }]
        });
        let pdfUrl = null;
        if (shop) {
          try {
            pdfUrl = await uploadInvoicePDF(orderForInvoice, shop);
          } catch (pdfErr) {
            console.error('Invoice PDF upload error for manual order:', pdfErr);
          }
        }
        await Invoice.create({
          order_id: createdOrder.id,
          final_amount: createdOrder.total_amount,
          generated_at: new Date(),
          pdf_url: pdfUrl
        });
      } catch (invErr) {
        console.error('Invoice creation error for manual order:', invErr);
      }
    }

    const fullOrder = await Order.findByPk(createdOrder.id, {
      include: [
        {
          model: OrderItem,
          include: [{ model: Product, attributes: ['id', 'name', 'price', 'deal_price', 'product_collection_id', 'sku_id', 'image_url', 'stock_quantity'] }]
        },
        {
          model: Invoice
        }
      ]
    });

    return res.status(201).json({
      success: true,
      message: targetStatus === 'approved' ? 'Order created and approved successfully' : 'Order created successfully',
      data: { order: fullOrder }
    });
  } catch (err) {
    console.error('Error creating order:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});


// Get orders
router.get('/', async (req, res) => {
  const shopId = req.headers['x-shop-id'];
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    let whereClause = {};

    if (shopId) {
      // 1. If it's a shop (buyer), only return orders belonging to that shop
      whereClause = { shop_id: shopId };
    } else if (userRole) {
      // 2. If it's a platform user
      if (userRole === 'Admin' || userRole === 'Seller') {
        // Admin and Seller can see all orders
        whereClause = {};
      } else if (userRole === 'Sales Executive') {
        if (!userId) {
          return res.status(403).json({ success: false, message: 'Access denied: User ID is required' });
        }
        const assignments = await SalesExecutiveAssignment.findAll({
          where: { sales_exec_id: userId, end_date: null }
        });
        const shopIds = assignments.map(a => a.shop_id);
        whereClause = { shop_id: shopIds };
      } else {
        return res.status(403).json({ success: false, message: 'Access denied: Invalid user role' });
      }
    } else {
      // Neither x-shop-id nor x-user-role is provided
      return res.status(401).json({ success: false, message: 'Unauthorized: Access credentials missing' });
    }

    const orders = await Order.findAll({
      where: whereClause,
      include: [
        {
          model: OrderItem,
          attributes: ['id', 'order_id', 'product_id', 'requested_qty', 'approved_qty', 'price', 'custom_price'],
          include: [
            {
              model: Product,
              attributes: ['id', 'name', 'price', 'deal_price', 'product_collection_id', 'sku_id', 'image_url', 'stock_quantity', 'is_active']
            }
          ]
        },
        {
          model: Invoice,
          attributes: ['id', 'order_id', 'final_amount', 'generated_at', 'pdf_url', 'payment_status', 'total_paid_amount', 'total_credited_amount', 'remaining_balance']
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

// Get order by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const access = await checkOrderAccess(id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const order = await Order.findByPk(id, {
      include: [{
        model: OrderItem,
        attributes: ['id', 'order_id', 'product_id', 'requested_qty', 'approved_qty', 'price', 'custom_price'],
        include: [{
          model: Product,
          attributes: ['id', 'name', 'price', 'deal_price', 'product_collection_id', 'sku_id', 'image_url', 'stock_quantity', 'is_active']
        }]
      }]
    });
    return res.json({ success: true, message: 'Order fetched successfully', data: { order } });
  } catch (err) {
    console.error('Error fetching order:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Process order (update approved quantities and recalculate total)
router.patch('/:id/process', async (req, res) => {
  const { id } = req.params;
  const { items, create_followup_order } = req.body; // items: [{ id: order_item_id, approved_qty, custom_price }]

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to process order' });
  }

  try {
    const userRole = req.headers['x-user-role'];
    if (!userRole) {
      return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
    }

    const access = await checkOrderAccess(id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot process order in ${order.status} status` });
    }

    const shop = await Shop.findByPk(order.shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop associated with this order not found' });
    }

    let recalculatedTotal = 0;
    let followUpOrderId = null;

    await sequelize.transaction(async (t) => {
      const lockedOrder = await Order.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!lockedOrder) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }
      if (lockedOrder.status !== 'pending') {
        const err = new Error(`Cannot process order in ${lockedOrder.status} status`);
        err.statusCode = 400;
        throw err;
      }

      // Update each order item
      for (const updateItem of items) {
        const orderItem = await OrderItem.findOne({ 
          where: { id: updateItem.id, order_id: lockedOrder.id },
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
          if (updateItem.approved_qty > 0) {
            if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
              const err = new Error('Seller Permit Required for this product category.');
              err.statusCode = 403;
              throw err;
            }
            if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
              const err = new Error('Tobacco License Required for this product category.');
              err.statusCode = 403;
              throw err;
            }
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
            order_id: lockedOrder.id,
            action: 'Approval'
          }, { transaction: t });

          orderItem.approved_qty = updateItem.approved_qty;
          orderItem.custom_price = (updateItem.custom_price !== undefined && updateItem.custom_price !== null && updateItem.custom_price !== '') ? parseFloat(updateItem.custom_price) : null;
          await orderItem.save({ transaction: t });
          
          const effectivePrice = (orderItem.custom_price !== null && orderItem.custom_price !== undefined) ? orderItem.custom_price : orderItem.price;
          recalculatedTotal += effectivePrice * updateItem.approved_qty;
        }
      }

      lockedOrder.total_amount = recalculatedTotal;
      lockedOrder.status = 'approved';
      lockedOrder.approved_at = new Date();
      await lockedOrder.save({ transaction: t });

      // Optional follow-up order for the quantities that couldn't be approved now (user's choice only)
      if (create_followup_order === true) {
        const existing = await Order.findOne({ where: { parent_order_id: lockedOrder.id }, transaction: t, lock: t.LOCK.UPDATE });
        const itemRows = await OrderItem.findAll({ where: { order_id: lockedOrder.id }, transaction: t });
        const shortfall = itemRows
          .map((it) => ({ it, qty: Math.max(0, (it.requested_qty || 0) - (it.approved_qty || 0)) }))
          .filter((x) => x.qty > 0);
        if (!existing && shortfall.length > 0) {
          const followTotal = shortfall.reduce((sum, { it, qty }) => sum + (it.custom_price ?? it.price) * qty, 0);
          const followUp = await Order.create({
            shop_id: lockedOrder.shop_id,
            total_amount: followTotal,
            status: 'pending',
            source: 'Admin',
            parent_order_id: lockedOrder.id,
          }, { transaction: t });
          await OrderItem.bulkCreate(shortfall.map(({ it, qty }) => ({
            order_id: followUp.id,
            product_id: it.product_id,
            requested_qty: qty,
            approved_qty: null,
            price: it.price,
            custom_price: it.custom_price,
          })), { transaction: t });
          followUpOrderId = followUp.id;
        } else if (existing) {
          followUpOrderId = existing.id;
        }
      }
    });

    // Fetch the updated order with full details
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    // Automatically generate invoice upon approval
    let invoice = await Invoice.findOne({ where: { order_id: updatedOrder.id } });
    if (!invoice) {
      let pdfUrl = null;
      if (shop) {
        try {
          pdfUrl = await uploadInvoicePDF(updatedOrder, shop);
        } catch (pdfErr) {
          console.error('Failed to generate/upload invoice PDF:', pdfErr);
        }
      }
      await Invoice.create({
        order_id: updatedOrder.id,
        final_amount: updatedOrder.total_amount,
        generated_at: new Date(),
        pdf_url: pdfUrl
      });
    }

    return res.json({
      success: true,
      message: followUpOrderId
        ? `Order processed. Follow-up order WS-${followUpOrderId} holds the removed quantities.`
        : 'Order processed successfully',
      data: { order: updatedOrder, followup_order_id: followUpOrderId }
    });
  } catch (err) {
    console.error('Error processing order:', err);
    if (err.statusCode === 400 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update order status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'approved', 'processed', 'dispatched', 'delivered', 'completed', 'cancelled', 'rejected'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `Valid status (${validStatuses.join(', ')}) is required` });
  }

  try {
    const userRole = req.headers['x-user-role'];
    if (!userRole) {
      return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
    }

    const access = await checkOrderAccess(id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const order = access.order;
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (status === 'cancelled' || status === 'rejected') {
      if (order.status === status) {
        return res.status(400).json({ success: false, message: `Order is already ${status}` });
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
                  action: status === 'rejected' ? 'Rejection' : 'Cancellation'
                }, { transaction: t });
              }
            }
          }
        }

        order.status = status;
        await order.save({ transaction: t });
      });

      return res.json({ success: true, message: `Order ${status} successfully`, data: { order } });
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

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'items array is required to approve order' });
  }

  try {
    const userRole = req.headers['x-user-role'];
    if (!userRole) {
      return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
    }

    const access = await checkOrderAccess(id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    const order = await Order.findByPk(id, { include: [OrderItem] });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot approve order in ${order.status} status` });
    }

    const shop = await Shop.findByPk(order.shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop associated with this order not found' });
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
          if (updateItem.approved_qty > 0) {
            if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
              const err = new Error('Seller Permit Required for this product category.');
              err.statusCode = 403;
              throw err;
            }
            if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
              const err = new Error('Tobacco License Required for this product category.');
              err.statusCode = 403;
              throw err;
            }
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

    // Automatically generate invoice upon approval
    let invoice = await Invoice.findOne({ where: { order_id: updatedOrder.id } });
    if (!invoice) {
      let pdfUrl = null;
      if (shop) {
        try {
          pdfUrl = await uploadInvoicePDF(updatedOrder, shop);
        } catch (pdfErr) {
          console.error('Failed to generate/upload invoice PDF:', pdfErr);
        }
      }
      await Invoice.create({
        order_id: updatedOrder.id,
        final_amount: updatedOrder.total_amount,
        generated_at: new Date(),
        pdf_url: pdfUrl
      });
    }

    return res.json({ success: true, message: 'Order approved and processed successfully', data: { order: updatedOrder } });
  } catch (err) {
    console.error('Error approving order:', err);
    if (err.statusCode === 400 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Edit order before delivery (draft committed atomically)
router.put('/:id/edit', async (req, res) => {
  const { id } = req.params;
  const { items } = req.body;
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  if (!userRole || (userRole !== 'Admin' && userRole !== 'Seller')) {
    return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'items array with at least one product is required' });
  }

  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity < 1) {
      return res.status(400).json({ success: false, message: 'Each item must have product_id and quantity >= 1' });
    }
  }

  const productIds = items.map(i => i.product_id);
  if (new Set(productIds).size !== productIds.length) {
    return res.status(400).json({ success: false, message: 'Duplicate products in items list' });
  }

  try {
    const order = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const shop = await Shop.findByPk(order.shop_id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop associated with this order not found' });
    }

    const LOCKED_STATUSES = ['delivered', 'completed', 'cancelled', 'rejected'];
    const lockedStatusMessage = (status) =>
      `Order cannot be edited in "${status}" status. Editing is only allowed before delivery.`;
    if (LOCKED_STATUSES.includes(order.status)) {
      return res.status(400).json({ success: false, message: lockedStatusMessage(order.status) });
    }

    let wasPending = order.status === 'pending';
    const isApproved = true;
    const parsedUserId = userId ? parseInt(userId) : null;
    const auditLogs = [];
    let invoiceId = null;

    await sequelize.transaction(async (t) => {
      // Lock the order row and re-check its status so a concurrent "Mark Delivered" can't slip past
      const lockedOrder = await Order.findByPk(order.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (LOCKED_STATUSES.includes(lockedOrder.status)) {
        const err = new Error(lockedStatusMessage(lockedOrder.status));
        err.statusCode = 400;
        throw err;
      }
      wasPending = lockedOrder.status === 'pending';

      const invoice = await Invoice.findOne({ where: { order_id: order.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (invoice && invoice.payment_status === 'settled') {
        const err = new Error('This order\'s invoice has been settled and can no longer be edited.');
        err.statusCode = 409;
        throw err;
      }

      // Re-fetch order items inside transaction with row locks
      const oldItems = await OrderItem.findAll({
        where: { order_id: order.id },
        include: [{ model: Product }],
        transaction: t,
        lock: { level: t.LOCK.UPDATE, of: OrderItem }
      });

      const oldItemMap = new Map(oldItems.map(item => [item.product_id, item]));
      const newItemMap = new Map(items.map(item => [item.product_id, item]));

      // Lock and cache all affected products (old + new) upfront
      const allProductIds = new Set([...productIds, ...oldItems.map(i => i.product_id)]);
      const productCache = new Map();
      for (const pid of allProductIds) {
        const product = await Product.findByPk(pid, { transaction: t, lock: t.LOCK.UPDATE });
        if (product) productCache.set(pid, product);
      }

      // Validate all new products exist and check license requirements
      for (const newItem of items) {
        const product = productCache.get(newItem.product_id);
        if (!product) {
          const err = new Error(`Product ID ${newItem.product_id} not found`);
          err.statusCode = 404;
          throw err;
        }
        // Inactive products can stay on lines they're already on, but can't be newly added
        if (product.is_active === false && !oldItemMap.has(newItem.product_id)) {
          const err = new Error(`"${product.name}" is inactive and can't be added to this order.`);
          err.statusCode = 400;
          throw err;
        }
        if (product.required_license === 'Seller Permit' && !(shop.seller_permit && shop.approved)) {
          const err = new Error(`Seller Permit Required for "${product.name}".`);
          err.statusCode = 403;
          throw err;
        }
        if (product.required_license === 'Tobacco License' && !(shop.tobacco_license && shop.approved)) {
          const err = new Error(`Tobacco License Required for "${product.name}".`);
          err.statusCode = 403;
          throw err;
        }
      }

      // ── Removed items: restore approved_qty back to stock ──────────────
      for (const oldItem of oldItems) {
        if (!newItemMap.has(oldItem.product_id)) {
          const product = productCache.get(oldItem.product_id);
          if (product && oldItem.approved_qty > 0) {
            const prevStock = product.stock_quantity;
            product.stock_quantity += oldItem.approved_qty;
            await product.save({ transaction: t });
            await StockMovement.create({
              product_id: product.id,
              quantity_changed: oldItem.approved_qty,
              previous_stock: prevStock,
              new_stock: product.stock_quantity,
              order_id: order.id,
              action: 'Edit - Item Removed'
            }, { transaction: t });
          }
          auditLogs.push({
            order_id: order.id,
            user_id: parsedUserId,
            action: 'item_removed',
            product_id: oldItem.product_id,
            product_name: oldItem.Product?.name || null,
            previous_value: { quantity: oldItem.approved_qty || oldItem.requested_qty, price: oldItem.custom_price ?? oldItem.price },
            new_value: null
          });
        }
      }

      // ── Added and changed items: adjust stock by delta ─────────────────
      for (const newItem of items) {
        const product = productCache.get(newItem.product_id);
        const oldItem = oldItemMap.get(newItem.product_id);
        const newCustomPrice = (newItem.custom_price != null && newItem.custom_price !== '') ? parseFloat(newItem.custom_price) : null;

        if (!oldItem) {
          // Brand new product added to the order
          if (newItem.quantity > product.stock_quantity) {
            const err = new Error(`Insufficient stock for "${product.name}". Available: ${product.stock_quantity}, requested: ${newItem.quantity}`);
            err.statusCode = 400;
            throw err;
          }
          const prevStock = product.stock_quantity;
          product.stock_quantity -= newItem.quantity;
          await product.save({ transaction: t });
          await StockMovement.create({
            product_id: product.id,
            quantity_changed: -newItem.quantity,
            previous_stock: prevStock,
            new_stock: product.stock_quantity,
            order_id: order.id,
            action: 'Edit - Item Added'
          }, { transaction: t });
          const pricing = await getProductEffectivePricing(product);
          auditLogs.push({
            order_id: order.id,
            user_id: parsedUserId,
            action: 'item_added',
            product_id: newItem.product_id,
            product_name: product.name,
            previous_value: null,
            new_value: { quantity: newItem.quantity, price: newCustomPrice ?? pricing.effective_price }
          });
        } else {
          // Existing product: compute quantity delta
          const oldQty = oldItem.approved_qty || 0;
          const delta = newItem.quantity - oldQty;

          if (delta > 0) {
            if (delta > product.stock_quantity) {
              const err = new Error(`Insufficient stock for "${product.name}". Available: ${product.stock_quantity}, additional needed: ${delta}`);
              err.statusCode = 400;
              throw err;
            }
            const prevStock = product.stock_quantity;
            product.stock_quantity -= delta;
            await product.save({ transaction: t });
            await StockMovement.create({
              product_id: product.id,
              quantity_changed: -delta,
              previous_stock: prevStock,
              new_stock: product.stock_quantity,
              order_id: order.id,
              action: 'Edit - Quantity Increased'
            }, { transaction: t });
          } else if (delta < 0) {
            const restore = -delta;
            const prevStock = product.stock_quantity;
            product.stock_quantity += restore;
            await product.save({ transaction: t });
            await StockMovement.create({
              product_id: product.id,
              quantity_changed: restore,
              previous_stock: prevStock,
              new_stock: product.stock_quantity,
              order_id: order.id,
              action: 'Edit - Quantity Decreased'
            }, { transaction: t });
          }

          const prevQtyForAudit = wasPending ? oldItem.requested_qty : oldQty;
          if (newItem.quantity !== prevQtyForAudit) {
            auditLogs.push({
              order_id: order.id,
              user_id: parsedUserId,
              action: 'quantity_changed',
              product_id: newItem.product_id,
              product_name: product.name,
              previous_value: { quantity: prevQtyForAudit },
              new_value: { quantity: newItem.quantity }
            });
          }

          // Audit price changes (existing lines keep their stored list price)
          const oldEffective = oldItem.custom_price ?? oldItem.price;
          const newEffective = newCustomPrice ?? oldItem.price;
          if (Math.abs(oldEffective - newEffective) > 0.001) {
            auditLogs.push({
              order_id: order.id,
              user_id: parsedUserId,
              action: 'price_changed',
              product_id: newItem.product_id,
              product_name: product.name,
              previous_value: { price: oldEffective },
              new_value: { price: newEffective }
            });
          }
        }
      }

      // ── Replace all order items atomically ─────────────────────────────
      await OrderItem.destroy({ where: { order_id: order.id }, transaction: t });

      let newTotal = 0;
      const sortedItems = [...items].sort((a, b) => {
        const nameA = productCache.get(a.product_id)?.name || '';
        const nameB = productCache.get(b.product_id)?.name || '';
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      });

      const newOrderItems = [];
      for (const newItem of sortedItems) {
        const product = productCache.get(newItem.product_id);
        // Lines already on the order keep their stored list price; only newly added products use current pricing
        const oldItem = oldItemMap.get(newItem.product_id);
        const listPrice = oldItem ? oldItem.price : (await getProductEffectivePricing(product)).effective_price;
        const customPrice = (newItem.custom_price != null && newItem.custom_price !== '') ? parseFloat(newItem.custom_price) : null;
        const effectivePrice = customPrice ?? listPrice;
        newTotal += effectivePrice * newItem.quantity;
        newOrderItems.push({
          order_id: order.id,
          product_id: newItem.product_id,
          requested_qty: newItem.quantity,
          approved_qty: newItem.quantity,
          price: listPrice,
          custom_price: customPrice
        });
      }

      await OrderItem.bulkCreate(newOrderItems, { transaction: t });

      // ── Keep the invoice consistent with the new total and actual payments ──
      const paid = invoice
        ? Math.round((Number(await InvoicePaymentHistory.sum('payment_amount', {
            where: { invoice_id: invoice.id },
            transaction: t
          })) || 0) * 100) / 100
        : 0;
      const credited = invoice ? Number(invoice.total_credited_amount) || 0 : 0;
      if (newTotal < paid + credited - 0.005) {
        const covered = paid + credited;
        const err = new Error(credited > 0.005
          ? `New order total $${newTotal.toFixed(2)} is lower than the $${covered.toFixed(2)} already paid and credited on this invoice.`
          : `New order total $${newTotal.toFixed(2)} is lower than the $${paid.toFixed(2)} already paid on this invoice. Adjust the payments first.`);
        err.statusCode = 400;
        throw err;
      }
      const invoiceTotals = {
        final_amount: newTotal,
        total_paid_amount: paid,
        ...computeInvoiceBalance(newTotal, paid, credited),
      };
      if (invoice) {
        await invoice.update(invoiceTotals, { transaction: t });
        invoiceId = invoice.id;
      } else {
        const created = await Invoice.create({
          order_id: order.id,
          generated_at: new Date(),
          pdf_url: null,
          ...invoiceTotals
        }, { transaction: t });
        invoiceId = created.id;
      }

      lockedOrder.total_amount = newTotal;
      if (wasPending) {
        lockedOrder.status = 'approved';
        lockedOrder.approved_at = new Date();
      }
      await lockedOrder.save({ transaction: t });

      if (auditLogs.length > 0) {
        await OrderEditLog.bulkCreate(auditLogs, { transaction: t });
      }
    });

    // ── Post-transaction: regenerate the invoice PDF (totals are already saved) ──
    const updatedOrder = await Order.findByPk(id, {
      include: [{ model: OrderItem, include: [Product] }]
    });

    let pdfFailed = false;
    if (shop) {
      try {
        const pdfUrl = await uploadInvoicePDF(updatedOrder, shop);
        await Invoice.update({ pdf_url: pdfUrl, generated_at: new Date() }, { where: { id: invoiceId } });
      } catch (pdfErr) {
        pdfFailed = true;
        console.error('Failed to generate/regenerate invoice PDF after order edit:', pdfErr);
      }
    }

    return res.json({
      success: true,
      message: pdfFailed
        ? 'Order updated, but the invoice PDF could not be regenerated. Use Regenerate on the invoice to try again.'
        : 'Order updated successfully',
      data: { order: updatedOrder, invoice_pdf_failed: pdfFailed }
    });
  } catch (err) {
    console.error('Error editing order:', err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PATCH /orders/:id/store — move an order to a different store (Admin/Seller).
// The order keeps its ID, items, invoice and payments; balances follow the order's store.
// Blocked when credit notes are involved, since those are tied to the original store.
router.patch('/:id/store', async (req, res) => {
  const { id } = req.params;
  const userRole = req.headers['x-user-role'];
  if (req.headers['x-shop-id'] || !['Admin', 'Seller'].includes(userRole)) {
    return res.status(403).json({ success: false, message: 'Access denied: Only Admin or Seller users can change an order\'s store' });
  }
  const shopId = Number(req.body?.shop_id);
  if (!/^\d+$/.test(String(id)) || !Number.isInteger(shopId) || shopId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid order ID and shop_id are required' });
  }
  const userId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;

  try {
    let previousShop;
    let newShop;
    await sequelize.transaction(async (t) => {
      const order = await Order.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!order) { const e = new Error('Order not found'); e.statusCode = 404; throw e; }
      if (order.shop_id === shopId) { const e = new Error('The order already belongs to this store.'); e.statusCode = 400; throw e; }

      newShop = await Shop.findByPk(shopId, { transaction: t });
      if (!newShop) { const e = new Error('Store not found'); e.statusCode = 404; throw e; }
      if (newShop.approval_status !== 'Approved') {
        const e = new Error(`"${newShop.shop_name}" is not an approved store.`); e.statusCode = 400; throw e;
      }
      previousShop = await Shop.findByPk(order.shop_id, { transaction: t });

      const invoice = await Invoice.findOne({ where: { order_id: order.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (invoice?.payment_status === 'settled') {
        const e = new Error('This order\'s invoice has been settled; its store can no longer be changed.'); e.statusCode = 409; throw e;
      }
      const [returns, creditsIn] = await Promise.all([
        OrderReturn.count({ where: { order_id: order.id }, transaction: t }),
        invoice ? CreditNoteApplication.count({ where: { invoice_id: invoice.id }, transaction: t }) : 0,
      ]);
      if (returns > 0 || creditsIn > 0) {
        const e = new Error(returns > 0
          ? 'This order has returns and credit notes tied to its current store, so its store can\'t be changed.'
          : 'Credit notes from the current store have been applied to this order\'s invoice, so its store can\'t be changed.');
        e.statusCode = 409; throw e;
      }

      order.shop_id = shopId;
      await order.save({ transaction: t });
      await OrderEditLog.create({
        order_id: order.id,
        user_id: userId,
        action: 'store_changed',
        product_id: 0,
        product_name: null,
        previous_value: { shop_id: previousShop?.id ?? null, shop_name: previousShop?.shop_name ?? null },
        new_value: { shop_id: newShop.id, shop_name: newShop.shop_name },
      }, { transaction: t });
    });

    // The invoice PDF's "Bill To" names the store, so rebuild it (totals are unaffected)
    let pdfFailed = false;
    const invoice = await Invoice.findOne({ where: { order_id: Number(id) } });
    if (invoice) {
      try {
        const fullOrder = await Order.findByPk(id, { include: [{ model: OrderItem, include: [Product] }] });
        const pdfUrl = await uploadInvoicePDF(fullOrder, newShop);
        await invoice.update({ pdf_url: pdfUrl });
      } catch (pdfErr) {
        pdfFailed = true;
        console.error('Failed to regenerate invoice PDF after store change:', pdfErr);
      }
    }
    const order = await Order.findByPk(id, { include: [{ model: OrderItem, include: [Product] }, { model: Invoice }] });
    return res.json({
      success: true,
      message: `Order moved from ${previousShop?.shop_name || 'its previous store'} to ${newShop.shop_name}.`
        + (pdfFailed ? ' The invoice PDF could not be regenerated; use Regenerate on the invoice.' : ''),
      data: { order, invoice_pdf_failed: pdfFailed }
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    console.error('Error changing order store:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /orders/:id/logs — edit history for an order
router.get('/:id/logs', async (req, res) => {
  const { id } = req.params;
  try {
    const order = await Order.findByPk(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const logs = await OrderEditLog.findAll({
      where: { order_id: id },
      include: [{ model: User, attributes: ['id', 'name', 'role'] }],
      order: [['created_at', 'DESC']],
    });
    return res.json({ success: true, data: { logs } });
  } catch (err) {
    console.error('Error fetching order logs:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /orders/:id — permanently delete a rejected order
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userRole = req.headers['x-user-role'];

  if (!userRole || (userRole !== 'Admin' && userRole !== 'Seller')) {
    return res.status(403).json({ success: false, message: 'Access denied: Administrative privileges required' });
  }

  try {
    const access = await checkOrderAccess(id, req.headers);
    if (!access.hasAccess) {
      return res.status(access.status).json({ success: false, message: access.message });
    }

    let deletedOrderInfo = null;

    await sequelize.transaction(async (t) => {
      const order = await Order.findByPk(id, {
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (!order) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
      }

      if (order.status !== 'rejected' && order.status !== 'cancelled') {
        const err = new Error(`Only cancelled or rejected orders can be deleted. Current status is "${order.status}".`);
        err.statusCode = 400;
        throw err;
      }

      deletedOrderInfo = { id: order.id, shop_id: order.shop_id };

      // 1. Delete order edit logs
      await OrderEditLog.destroy({
        where: { order_id: order.id },
        transaction: t
      });

      // 2. Delete invoice & invoice payment histories if any exist
      const invoice = await Invoice.findOne({
        where: { order_id: order.id },
        transaction: t
      });
      if (invoice) {
        await InvoicePaymentHistory.destroy({
          where: { invoice_id: invoice.id },
          transaction: t
        });
        await Invoice.destroy({
          where: { id: invoice.id },
          transaction: t
        });
      }

      // 3. Detach StockMovements (set order_id to null) to maintain immutable inventory audit logs
      await StockMovement.update(
        { order_id: null },
        { where: { order_id: order.id }, transaction: t }
      );

      // 4. Delete OrderItems
      await OrderItem.destroy({
        where: { order_id: order.id },
        transaction: t
      });

      // 5. Delete Order
      await order.destroy({ transaction: t });
    });

    return res.json({
      success: true,
      message: 'Order deleted successfully',
      data: deletedOrderInfo
    });
  } catch (err) {
    console.error('Error deleting rejected order:', err);
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;