const express = require('express');
const { Shop, User, Order, OrderItem, Product, Invoice, SalesExecutiveAssignment } = require('../models');
const { Op } = require('sequelize');
const sequelize = require('../config/db');

const router = express.Router();

router.get('/stats', async (req, res) => {
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  try {
    if (userRole === 'Admin') {
      // 1. Admin Dashboard Stats
      const [
        totalStores,
        pendingApprovals,
        approvedStores,
        totalOrders,
        pendingOrders,
        sellers,
        execs,
        revenueData
      ] = await Promise.all([
        Shop.count(),
        Shop.count({ where: { approval_status: 'Pending' } }),
        Shop.count({ where: { approval_status: 'Approved' } }),
        Order.count(),
        Order.count({ where: { status: 'pending' } }),
        User.count({ where: { role: 'Seller' } }),
        User.count({ where: { role: 'Sales Executive' } }),
        Order.sum('total_amount', { where: { status: { [Op.in]: ['delivered', 'completed'] } } })
      ]);

      // Fetch recent 10 orders with minimal fields
      const recentOrders = await Order.findAll({
        limit: 10,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: OrderItem,
            attributes: ['id']
          },
          {
            model: Invoice,
            attributes: ['pdf_url']
          },
          {
            model: Shop,
            attributes: ['shop_name']
          }
        ]
      });

      return res.json({
        success: true,
        data: {
          totalStores,
          pendingApprovals,
          approvedStores,
          totalOrders,
          pendingOrders,
          sellers,
          execs,
          totalRevenue: revenueData || 0,
          recentOrders: recentOrders.map(o => {
            const json = o.toJSON();
            return {
              id: json.id,
              shop_id: json.shop_id,
              shop_name: json.Shop?.shop_name || `Store #${json.shop_id}`,
              itemCount: json.OrderItems?.length || 0,
              total_amount: json.total_amount,
              status: json.status,
              created_at: json.created_at,
              invoice_generated: !!json.Invoice?.pdf_url
            };
          })
        }
      });
    } else if (userRole === 'Seller') {
      // 2. Seller Dashboard Stats
      const [
        totalProducts,
        lowStock,
        outOfStock,
        totalOrders,
        pendingOrders,
        revenueData
      ] = await Promise.all([
        Product.count(),
        Product.count({ where: { stock_quantity: { [Op.gt]: 0, [Op.lt]: 10 } } }),
        Product.count({ where: { stock_quantity: 0 } }),
        Order.count(),
        Order.count({ where: { status: 'pending' } }),
        Order.sum('total_amount', { where: { status: { [Op.in]: ['delivered', 'completed'] } } })
      ]);

      // Fetch recent 8 orders
      const recentOrders = await Order.findAll({
        limit: 8,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: OrderItem,
            attributes: ['id']
          },
          {
            model: Shop,
            attributes: ['shop_name']
          }
        ]
      });

      return res.json({
        success: true,
        data: {
          totalProducts,
          lowStock,
          outOfStock,
          totalOrders,
          pendingOrders,
          totalRevenue: revenueData || 0,
          recentOrders: recentOrders.map(o => {
            const json = o.toJSON();
            return {
              id: json.id,
              shop_id: json.shop_id,
              shop_name: json.Shop?.shop_name || `Store #${json.shop_id}`,
              itemCount: json.OrderItems?.length || 0,
              total_amount: json.total_amount,
              status: json.status,
              created_at: json.created_at
            };
          })
        }
      });
    } else if (userRole === 'Sales Executive') {
      // 3. Sales Executive Dashboard Stats
      // Active assigned shops
      const assignments = await SalesExecutiveAssignment.findAll({
        where: { sales_exec_id: userId, end_date: null }
      });
      const shopIds = assignments.map(a => a.shop_id);

      if (shopIds.length === 0) {
        return res.json({
          success: true,
          data: {
            assignedStoresCount: 0,
            ordersToday: 0,
            ordersThisMonth: 0,
            deliveredOrders: 0,
            totalSalesValue: 0,
            generatedInvoices: 0,
            totalOrders: 0
          }
        });
      }

      const now = new Date();
      // start of today in California time
      const todayStart = new Date(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' }).format(now));
      // start of this month in California time
      const monthStart = new Date(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: '1' }).format(now));

      const [
        ordersToday,
        ordersThisMonth,
        deliveredOrders,
        totalSalesValue,
        totalOrders,
        generatedInvoices
      ] = await Promise.all([
        Order.count({ where: { shop_id: shopIds, created_at: { [Op.gte]: todayStart } } }),
        Order.count({ where: { shop_id: shopIds, created_at: { [Op.gte]: monthStart } } }),
        Order.count({ where: { shop_id: shopIds, status: { [Op.in]: ['delivered', 'completed'] } } }),
        Order.sum('total_amount', { where: { shop_id: shopIds, status: { [Op.in]: ['delivered', 'completed'] } } }),
        Order.count({ where: { shop_id: shopIds } }),
        Order.count({
          where: { shop_id: shopIds },
          include: [{ model: Invoice, where: { pdf_url: { [Op.ne]: null } }, required: true }]
        })
      ]);

      return res.json({
        success: true,
        data: {
          assignedStoresCount: shopIds.length,
          ordersToday,
          ordersThisMonth,
          deliveredOrders,
          totalSalesValue: totalSalesValue || 0,
          generatedInvoices,
          totalOrders
        }
      });
    } else {
      return res.status(403).json({ success: false, message: 'Access denied: Invalid role' });
    }
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
