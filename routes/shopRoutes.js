const express = require('express');
const Shop = require('../models/Shop');
const User = require('../models/User');
const sequelize = require('../config/db');

const router = express.Router();

// Create shop
router.post('/', async (req, res) => {
  const { shop_name, seller_permit, owner_name, email, password, contact_details } = req.body;
  if (!shop_name || !seller_permit || !owner_name || !email || !password || !contact_details) {
    return res.status(400).json({ success: false, message: 'All required fields must be provided' });
  }

  try {
    const shop = await Shop.create({ shop_name, seller_permit, owner_name, email, password, contact_details });
    return res.status(201).json({ success: true, message: 'Shop created successfully', data: { shop } });
  } catch (err) {
    console.error('Error creating shop:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get shops
router.get('/', async (req, res) => {
  try {
    const shops = await Shop.findAll();
    const mappedShops = shops.map(shop => {
      const s = shop.toJSON();
      s.owner_id = s.user_id;
      return s;
    });
    return res.json({ success: true, message: 'Shops fetched successfully', data: { shops: mappedShops } });
  } catch (err) {
    console.error('Error fetching shops:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});


// Approve shop
router.patch('/:id/approve', async (req, res) => {
  const { id } = req.params;

  try {
    const shop = await Shop.findByPk(id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    shop.approved = true;
    shop.approval_status = 'Approved';
    await shop.save();

    return res.json({ success: true, message: 'Shop approved successfully', data: { shop } });
  } catch (err) {
    console.error('Error approving shop:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reject shop
router.patch('/:id/reject', async (req, res) => {
  const { id } = req.params;

  try {
    const shop = await Shop.findByPk(id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    shop.approved = false;
    shop.approval_status = 'Rejected';
    await shop.save();

    return res.json({ success: true, message: 'Shop rejected successfully', data: { shop } });
  } catch (err) {
    console.error('Error rejecting shop:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;