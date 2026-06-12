const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Shop = require('../models/Shop');
const sequelize = require('../config/db');

const router = express.Router();

// Basic helpers
const sanitizeUser = (user) => ({ id: user.id, name: user.name, email: user.email });

// Login route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Check approval status for Buyers
    if (user.role === 'Buyer') {
      if (user.approval_status === 'Pending') {
        return res.status(403).json({ success: false, message: 'Your shop registration is pending admin approval.' });
      }
      if (user.approval_status === 'Rejected') {
        return res.status(403).json({ success: false, message: 'Your shop registration was rejected by the admin.' });
      }
    }

    return res.json({ success: true, message: 'Login successful', data: { user: sanitizeUser(user) } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Logout route
router.post('/logout', (req, res) => {
  return res.json({ success: true, message: 'Logged out successfully', data: null });
});

// Register/Signup route
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
    // Check if user already exists
    const existingUser = await User.findOne({ where: { email }, transaction });
    if (existingUser) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'User with this email already exists' });
    }

    // Check if shop already exists
    const existingShop = await Shop.findOne({ where: { seller_permit: sellerPermit }, transaction });
    if (existingShop) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Shop with this Seller Permit Number already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create User
    const user = await User.create({
      name: ownerName,
      email,
      phone,
      password: hashedPassword,
      role: 'Buyer',
      approval_status: 'Pending'
    }, { transaction });

    // Create Shop
    const shop = await Shop.create({
      shop_name: shopName,
      seller_permit: sellerPermit,
      tobacco_license: tobaccoLicense || null,
      contact_details: phone || '',
      address: address || '',
      city: city || '',
      state: state || '',
      zip: zip || '',
      user_id: user.id
    }, { transaction });

    await transaction.commit();

    return res.status(201).json({
      success: true,
      message: 'Registration request submitted successfully',
      data: {
        user: sanitizeUser(user),
        shop
      }
    });
  } catch (err) {
    await transaction.rollback();
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Change Password route
router.post('/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email, current password, and new password are required' });
  }

  try {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid current password' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reset Password route (admin/direct password reset without current password verification)
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email and new password are required' });
  }

  try {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
