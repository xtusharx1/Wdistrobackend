const express = require('express');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const Shop = require('../models/Shop');
const User = require('../models/User');

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

// Update an assignment (set end_date to deactivate, or adjust start_date)
router.patch('/assignments/:id', async (req, res) => {
  try {
    const assignment = await SalesExecutiveAssignment.findByPk(req.params.id);
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }

    const { end_date, start_date } = req.body;
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

// Get sales executive incentives
router.get('/incentives', async (req, res) => {
  try {
    const incentives = [];
    return res.json({ success: true, message: 'Sales executive incentives fetched successfully', data: { incentives } });
  } catch (err) {
    console.error('Error fetching sales executive incentives:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;