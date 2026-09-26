const express = require('express');
const Shop = require('../models/Shop');
const User = require('../models/User');
const ShopPermit = require('../models/ShopPermit');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const DraftOrder = require('../models/DraftOrder');
const DraftOrderItem = require('../models/DraftOrderItem');
const Order = require('../models/Order');
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
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    let whereClause = {};
    if (userRole === 'Sales Executive') {
      const assignments = await SalesExecutiveAssignment.findAll({
        where: { sales_exec_id: userId, end_date: null }
      });
      const shopIds = assignments.map(a => a.shop_id);
      whereClause = { id: shopIds };
    }

    const shops = await Shop.findAll({ where: whereClause });
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
  const { allow_explicit_products } = req.body;

  try {
    const shop = await Shop.findByPk(id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    shop.approved = true;
    shop.approval_status = 'Approved';
    if (allow_explicit_products !== undefined) {
      shop.allow_explicit_products = allow_explicit_products === true || allow_explicit_products === 'true';
    }
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

// Update shop fields
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    shop_name,
    seller_permit,
    tobacco_license,
    owner_name,
    email,
    contact_details,
    address,
    city,
    state,
    zip,
    approved,
    approval_status,
    allow_explicit_products
  } = req.body;

  try {
    const shop = await Shop.findByPk(id);
    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    if (shop_name !== undefined) shop.shop_name = shop_name;
    if (seller_permit !== undefined) shop.seller_permit = seller_permit;
    if (tobacco_license !== undefined) shop.tobacco_license = tobacco_license;
    if (owner_name !== undefined) shop.owner_name = owner_name;
    if (email !== undefined) shop.email = email;
    if (contact_details !== undefined) shop.contact_details = contact_details;
    if (address !== undefined) shop.address = address;
    if (city !== undefined) shop.city = city;
    if (state !== undefined) shop.state = state;
    if (zip !== undefined) shop.zip = zip;
    if (approved !== undefined) shop.approved = approved;
    if (approval_status !== undefined) shop.approval_status = approval_status;
    if (allow_explicit_products !== undefined) {
      shop.allow_explicit_products = allow_explicit_products === true || allow_explicit_products === 'true';
    }

    await shop.save();
    return res.json({ success: true, message: 'Shop updated successfully', data: { shop } });
  } catch (err) {
    console.error('Error updating shop:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /shops/:id - Permanently delete a rejected shop account
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const userRole = req.headers['x-user-role'];

  if (userRole && userRole !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Admin access required to delete store' });
  }

  const t = await sequelize.transaction();
  try {
    const shop = await Shop.findByPk(id, { transaction: t });
    if (!shop) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    // Verify the store is actually in Rejected status
    if (shop.approval_status !== 'Rejected') {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: `Only rejected store accounts can be deleted. Current status: ${shop.approval_status}`
      });
    }

    // Check if store has any existing historical orders
    const orderCount = await Order.count({ where: { shop_id: id }, transaction: t });
    if (orderCount > 0) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Cannot delete store because historical orders are associated with it.'
      });
    }

    // 1. Delete DraftOrderItems & DraftOrders if any
    const draftOrders = await DraftOrder.findAll({ where: { shop_id: id }, attributes: ['id'], transaction: t });
    const draftOrderIds = draftOrders.map(d => d.id);
    if (draftOrderIds.length > 0) {
      await DraftOrderItem.destroy({ where: { draft_order_id: draftOrderIds }, transaction: t });
      await DraftOrder.destroy({ where: { id: draftOrderIds }, transaction: t });
    }

    // 2. Delete ShopPermits (force: true to remove paranoid soft-deleted ones as well)
    await ShopPermit.destroy({ where: { shop_id: id }, force: true, transaction: t });

    // 3. Delete SalesExecutiveAssignments
    await SalesExecutiveAssignment.destroy({ where: { shop_id: id }, transaction: t });

    // 4. Permanently delete the Shop record
    await shop.destroy({ transaction: t });

    await t.commit();
    return res.json({ success: true, message: `Store "${shop.shop_name}" was permanently deleted.` });
  } catch (err) {
    await t.rollback();
    console.error('Error deleting shop:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

module.exports = router;