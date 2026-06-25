const express = require('express');
const { Op } = require('sequelize');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const Shop = require('../models/Shop');
const User = require('../models/User');
const Order = require('../models/Order');

const router = express.Router();

// Get all assignments (includes Shop + SalesExecutive user) — used by admin
router.get('/assignments', async (req, res) => {
  try {
    const assignments = await SalesExecutiveAssignment.findAll({
      include: [
        { model: User, as: 'SalesExecutive', attributes: ['id', 'name', 'email', 'phone'] },
        { model: Shop, attributes: ['id', 'shop_name', 'owner_name', 'contact_details', 'city', 'state'] },
      ],
      order: [['start_date', 'DESC']],
    });
    return res.json({ success: true, message: 'Assignments fetched successfully', data: { assignments } });
  } catch (err) {
    console.error('Error fetching assignments:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create a new assignment
router.post('/assignments', async (req, res) => {
  try {
    const { sales_exec_id, shop_id, start_date } = req.body;
    if (!sales_exec_id || !shop_id || !start_date) {
      return res.status(400).json({ success: false, message: 'sales_exec_id, shop_id, and start_date are required' });
    }

    const exec = await User.findOne({ where: { id: sales_exec_id, role: 'Sales Executive' } });
    if (!exec) {
      return res.status(400).json({ success: false, message: 'Sales executive not found' });
    }

    const shop = await Shop.findByPk(shop_id);
    if (!shop) {
      return res.status(400).json({ success: false, message: 'Shop not found' });
    }

    const assignment = await SalesExecutiveAssignment.create({ sales_exec_id, shop_id, start_date });
    const full = await SalesExecutiveAssignment.findByPk(assignment.id, {
      include: [
        { model: User, as: 'SalesExecutive', attributes: ['id', 'name', 'email', 'phone'] },
        { model: Shop, attributes: ['id', 'shop_name', 'owner_name', 'contact_details', 'city', 'state'] },
      ],
    });
    return res.status(201).json({ success: true, message: 'Assignment created successfully', data: { assignment: full } });
  } catch (err) {
    console.error('Error creating assignment:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update an assignment (set end_date to deactivate, adjust start_date, or edit exec/shop)
router.patch('/assignments/:id', async (req, res) => {
  try {
    const assignment = await SalesExecutiveAssignment.findByPk(req.params.id);
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }

    const { end_date, start_date, sales_exec_id, shop_id } = req.body;
    
    if (sales_exec_id !== undefined) {
      const exec = await User.findOne({ where: { id: sales_exec_id, role: 'Sales Executive' } });
      if (!exec) {
        return res.status(400).json({ success: false, message: 'Sales executive not found' });
      }
      assignment.sales_exec_id = sales_exec_id;
    }

    if (shop_id !== undefined) {
      const shop = await Shop.findByPk(shop_id);
      if (!shop) {
        return res.status(400).json({ success: false, message: 'Shop not found' });
      }
      assignment.shop_id = shop_id;
    }

    if (end_date !== undefined) assignment.end_date = end_date;
    if (start_date !== undefined) assignment.start_date = start_date;
    await assignment.save();

    const full = await SalesExecutiveAssignment.findByPk(assignment.id, {
      include: [
        { model: User, as: 'SalesExecutive', attributes: ['id', 'name', 'email', 'phone'] },
        { model: Shop, attributes: ['id', 'shop_name', 'owner_name', 'contact_details', 'city', 'state'] },
      ],
    });
    return res.json({ success: true, message: 'Assignment updated successfully', data: { assignment: full } });
  } catch (err) {
    console.error('Error updating assignment:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get sales executive shops (legacy — used by Sales Exec mobile/app pages)
router.get('/shops', async (req, res) => {
  try {
    const assignments = await SalesExecutiveAssignment.findAll({
      include: [Shop],
    });
    return res.json({ success: true, message: 'Sales executive shops fetched successfully', data: { assignments } });
  } catch (err) {
    console.error('Error fetching sales executive shops:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get sales executive sales performance
router.get('/incentives', async (req, res) => {
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    let whereClause = {};
    if (userRole === 'Sales Executive') {
      whereClause = { sales_exec_id: userId };
    } else if (req.query.sales_exec_id) {
      whereClause = { sales_exec_id: req.query.sales_exec_id };
    }

    const assignments = await SalesExecutiveAssignment.findAll({
      where: whereClause,
      include: [
        { model: User, as: 'SalesExecutive', attributes: ['id', 'name', 'email'] },
        { model: Shop, attributes: ['id', 'shop_name'] }
      ]
    });

    if (assignments.length === 0) {
      return res.json({ success: true, message: 'Sales performance fetched successfully', data: { performance: [] } });
    }

    const shopIds = assignments.map(a => a.shop_id);
    const allOrders = await Order.findAll({
      where: {
        shop_id: shopIds,
        status: { [Op.ne]: 'pending' }
      },
      order: [['created_at', 'DESC']]
    });

    const performanceData = [];

    for (const assignment of assignments) {
      const shopOrders = allOrders.filter(order => {
        if (order.shop_id !== assignment.shop_id) return false;
        const orderDate = new Date(order.created_at);
        if (orderDate < new Date(assignment.start_date)) return false;
        if (assignment.end_date && orderDate > new Date(assignment.end_date)) return false;
        return true;
      });

      for (const order of shopOrders) {
        performanceData.push({
          sales_exec: {
            id: assignment.SalesExecutive?.id,
            name: assignment.SalesExecutive?.name,
            email: assignment.SalesExecutive?.email
          },
          shop: {
            id: assignment.Shop?.id,
            shop_name: assignment.Shop?.shop_name
          },
          order: {
            id: order.id,
            total_amount: order.total_amount,
            status: order.status,
            created_at: order.created_at
          }
        });
      }
    }

    // Sort by order date desc
    performanceData.sort((a, b) => new Date(b.order.created_at) - new Date(a.order.created_at));

    return res.json({ success: true, message: 'Sales performance fetched successfully', data: { performance: performanceData } });
  } catch (err) {
    console.error('Error fetching sales performance:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;