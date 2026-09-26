const express = require('express');
const { Shop, User, Order, OrderItem, Product, Invoice, InvoicePaymentHistory, SalesExecutiveAssignment, ShopPermit } = require('../models');
const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/db');

const router = express.Router();

// ── Helper: start-of-day / start-of-month in UTC ────────────────────────────
function startOfDayUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonthUTC(date) {
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Admin-specific aggregated dashboard ──────────────────────────────────────
router.get('/admin-overview', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfDayUTC(now);
    const monthStart = startOfMonthUTC(now);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

    // ── 1. Needs Attention ──────────────────────────────────────────────────
    const [
      pendingStoreApprovals,
      pendingPermits,
      pendingOrders,
    ] = await Promise.all([
      Shop.count({ where: { approval_status: 'Pending' } }),
      ShopPermit.count({ where: { status: 'Pending' } }),
      Order.count({ where: { status: 'pending' } }),
    ]);

    // ── 2. KPI Cards ────────────────────────────────────────────────────────
    const [
      totalOrders,
      ordersToday,
      ordersThisMonth,
      totalRevenue,
      revenueThisMonth,
      avgOrderValue,
    ] = await Promise.all([
      Order.count(),
      Order.count({ where: { created_at: { [Op.gte]: todayStart } } }),
      Order.count({ where: { created_at: { [Op.gte]: monthStart } } }),
      Order.sum('total_amount', { where: { status: { [Op.in]: ['delivered', 'completed'] } } }),
      Order.sum('total_amount', {
        where: {
          status: { [Op.in]: ['delivered', 'completed'] },
          created_at: { [Op.gte]: monthStart },
        },
      }),
      Order.findOne({
        attributes: [[fn('AVG', col('total_amount')), 'avg']],
        where: { status: { [Op.notIn]: ['cancelled', 'rejected'] } },
        raw: true,
      }),
    ]);

    // ── 3. Sales Overview — Daily totals for past 30 days ───────────────────
    const salesByDay = await Order.findAll({
      attributes: [
        [fn('DATE', col('created_at')), 'date'],
        [fn('COUNT', col('id')), 'orderCount'],
        [fn('SUM', col('total_amount')), 'revenue'],
      ],
      where: {
        created_at: { [Op.gte]: thirtyDaysAgo },
        status: { [Op.notIn]: ['cancelled', 'rejected'] },
      },
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
      raw: true,
    });

    // ── 4. Order Status Distribution ────────────────────────────────────────
    const orderStatusDist = await Order.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    });

    // ── 5. Recent Orders (last 10) ──────────────────────────────────────────
    const recentOrders = await Order.findAll({
      limit: 10,
      order: [['created_at', 'DESC']],
      include: [
        { model: OrderItem, attributes: ['id'] },
        { model: Invoice, attributes: ['pdf_url'] },
        { model: Shop, attributes: ['shop_name'] },
      ],
    });

    // ── 6. Inventory Snapshot ───────────────────────────────────────────────
    const [
      totalProducts,
      activeProducts,
      lowStockProducts,
      outOfStockProducts,
      totalStockValue,
    ] = await Promise.all([
      Product.count(),
      Product.count({ where: { is_active: true } }),
      Product.count({ where: { stock_quantity: { [Op.gt]: 0, [Op.lte]: 10 } } }),
      Product.count({ where: { stock_quantity: 0 } }),
      Product.findOne({
        attributes: [[fn('SUM', literal('stock_quantity * price')), 'value']],
        where: { is_active: true },
        raw: true,
      }),
    ]);

    // ── 7. Store Overview ───────────────────────────────────────────────────
    const [totalStores, approvedStores, rejectedStores, pendingStores] = await Promise.all([
      Shop.count(),
      Shop.count({ where: { approval_status: 'Approved' } }),
      Shop.count({ where: { approval_status: 'Rejected' } }),
      Shop.count({ where: { approval_status: 'Pending' } }),
    ]);

    // ── 8. Billing / Invoice Summary ────────────────────────────────────────
    const [
      totalInvoices,
      unsettledInvoices,
      partiallyPaidInvoices,
      paidInvoices,
      totalBilledAmount,
      totalCollected,
      totalOutstanding,
    ] = await Promise.all([
      Invoice.count(),
      Invoice.count({ where: { payment_status: 'unsettled' } }),
      Invoice.count({ where: { payment_status: 'partially_paid' } }),
      Invoice.count({ where: { payment_status: { [Op.in]: ['paid', 'settled'] } } }),
      Invoice.sum('final_amount'),
      Invoice.sum('total_paid_amount'),
      Invoice.sum('remaining_balance', { where: { payment_status: { [Op.notIn]: ['paid', 'settled'] } } }),
    ]);

    // ── 9. Team Counts ──────────────────────────────────────────────────────
    const [sellers, execs] = await Promise.all([
      User.count({ where: { role: 'Seller' } }),
      User.count({ where: { role: 'Sales Executive' } }),
    ]);

    return res.json({
      success: true,
      data: {
        needsAttention: {
          pendingStoreApprovals,
          pendingPermits,
          pendingOrders,
        },
        kpi: {
          totalOrders,
          ordersToday,
          ordersThisMonth,
          totalRevenue: totalRevenue || 0,
          revenueThisMonth: revenueThisMonth || 0,
          avgOrderValue: parseFloat((avgOrderValue?.avg || 0)).toFixed(2),
        },
        salesOverview: salesByDay.map((r) => ({
          date: r.date,
          orderCount: parseInt(r.orderCount, 10),
          revenue: parseFloat(r.revenue || 0),
        })),
        orderStatusDistribution: orderStatusDist.map((r) => ({
          status: r.status,
          count: parseInt(r.count, 10),
        })),
        recentOrders: recentOrders.map((o) => {
          const json = o.toJSON();
          return {
            id: json.id,
            shop_id: json.shop_id,
            shop_name: json.Shop?.shop_name || `Store #${json.shop_id}`,
            itemCount: json.OrderItems?.length || 0,
            total_amount: json.total_amount,
            status: json.status,
            source: json.source,
            created_at: json.created_at,
            invoice_generated: !!json.Invoice?.pdf_url,
          };
        }),
        inventory: {
          totalProducts,
          activeProducts,
          lowStockProducts,
          outOfStockProducts,
          totalStockValue: parseFloat(totalStockValue?.value || 0).toFixed(2),
        },
        stores: {
          totalStores,
          approvedStores,
          rejectedStores,
          pendingStores,
        },
        billing: {
          totalInvoices,
          unsettledInvoices,
          partiallyPaidInvoices,
          paidInvoices,
          totalBilledAmount: totalBilledAmount || 0,
          totalCollected: totalCollected || 0,
          totalOutstanding: totalOutstanding || 0,
        },
        team: { sellers, execs },
      },
    });
  } catch (err) {
    console.error('Error fetching admin overview:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Legacy /stats endpoint (Seller & Sales Exec dashboards) ─────────────────
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
