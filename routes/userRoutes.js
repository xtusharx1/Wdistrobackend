const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const router = express.Router();

// Create user
router.post('/', async (req, res) => {
  const { name, email, password, role, phone } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword, role, phone: phone || null });
    return res.status(201).json({ success: true, message: 'User created successfully', data: { user } });
  } catch (err) {
    console.error('Error creating user:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get users
router.get('/', async (req, res) => {
  try {
    const users = await User.findAll();
    return res.json({ success: true, message: 'Users fetched successfully', data: { users } });
  } catch (err) {
    console.error('Error fetching users:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Approve / Activate user
router.patch('/:id/approve', async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.is_active = true;
    await user.save();
    return res.json({ success: true, message: 'User activated successfully', data: { user } });
  } catch (err) {
    console.error('Error activating user:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reject / Deactivate user
router.patch('/:id/reject', async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.is_active = false;
    await user.save();
    return res.json({ success: true, message: 'User deactivated successfully', data: { user } });
  } catch (err) {
    console.error('Error deactivating user:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update user details
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, role, phone, password } = req.body;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (name) user.name = name;
    if (email) user.email = email;
    if (role) user.role = role;
    if (phone !== undefined) user.phone = phone;
    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    return res.json({ success: true, message: 'User updated successfully', data: { user } });
  } catch (err) {
    console.error('Error updating user:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;