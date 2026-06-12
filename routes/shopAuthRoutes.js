const express = require('express');
const bcrypt = require('bcryptjs');
const Shop = require('../models/Shop');
const sequelize = require('../config/db');

const router = express.Router();

// Helper to sanitize shop response
const sanitizeShop = (shop) => ({
  id: shop.id,
  shop_name: shop.shop_name,
  owner_name: shop.owner_name,
  email: shop.email,
  contact_details: shop.contact_details,
  address: shop.address,
  city: shop.city,
  state: shop.state,
  zip: shop.zip,
  seller_permit: shop.seller_permit,
  tobacco_license: shop.tobacco_license,
  approved: shop.approved,
  approval_status: shop.approval_status
});

// Shop Register Endpoint
router.post('/register', async (req, res) => {
  const {
    ownerName,
    email,
    phone,
    password,
    shopName,
    address,
    city,
    state,
    zip,
    sellerPermit,
    tobaccoLicense
  } = req.body;

  if (!ownerName || !email || !password || !shopName || !sellerPermit) {
    return res.status(400).json({ success: false, message: 'Owner name, email, password, shop name, and seller permit number are required' });
  }

  const transaction = await sequelize.transaction();

  try {
    // Check if shop email already exists
    const existingShopEmail = await Shop.findOne({ where: { email }, transaction });
    if (existingShopEmail) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Shop with this email already exists' });
    }

    // Check if seller permit already exists
    const existingPermit = await Shop.findOne({ where: { seller_permit: sellerPermit }, transaction });
    if (existingPermit) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Shop with this Seller Permit Number already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create standalone Shop
    const shop = await Shop.create({
      shop_name: shopName,
      owner_name: ownerName,
      email,
      password: hashedPassword,
      contact_details: phone || '',
      address: address || '',
      city: city || '',
      state: state || '',
      zip: zip || '',
      seller_permit: sellerPermit,
      tobacco_license: tobaccoLicense || null,
      approved: false,
      approval_status: 'Pending'
    }, { transaction });

    await transaction.commit();

    return res.status(201).json({
      success: true,
      message: 'Registration request submitted successfully',
      data: {
        shop: sanitizeShop(shop)
      }
    });
  } catch (err) {
    await transaction.rollback();
    console.error('Shop registration error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Shop Login Endpoint
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const shop = await Shop.findOne({ where: { email } });
    if (!shop) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, shop.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Enforce approval status check
    if (shop.approval_status === 'Pending') {
      return res.status(403).json({ success: false, message: 'Your shop registration is pending admin approval.' });
    }
    if (shop.approval_status === 'Rejected') {
      return res.status(403).json({ success: false, message: 'Your shop registration was rejected by the admin.' });
    }

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        shop: sanitizeShop(shop)
      }
    });
  } catch (err) {
    console.error('Shop login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Shop Change Password
router.post('/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email, current password, and new password are required' });
  }

  try {
    const shop = await Shop.findOne({ where: { email } });
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, shop.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid current password' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    shop.password = hashedPassword;
    await shop.save();

    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Shop change password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Shop Reset Password
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email and new password are required' });
  }

  try {
    const shop = await Shop.findOne({ where: { email } });
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    shop.password = hashedPassword;
    await shop.save();

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    console.error('Shop reset password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
