const express = require('express');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const Shop = require('../models/Shop');

const router = express.Router();

// Get sales executive shops
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
    // Placeholder logic for incentives
    const incentives = [];
    return res.json({ success: true, message: 'Sales executive incentives fetched successfully', data: { incentives } });
  } catch (err) {
    console.error('Error fetching sales executive incentives:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;