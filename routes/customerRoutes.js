const express = require('express');
const Invoice = require('../models/Invoice');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const Order = require('../models/Order');
const User = require('../models/User');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db');
const CreditNote = require('../models/CreditNote');
const CreditNoteApplication = require('../models/CreditNoteApplication');
const OrderReturn = require('../models/OrderReturn');
const OrderReturnItem = require('../models/OrderReturnItem');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const { round2 } = require('../services/invoiceBalanceService');
const { remainingOf, usageStatusOf } = require('../services/creditNoteService');
const { INVOICE_BALANCES_SQL, getStoreBalance, getAllStoreBalances } = require('../services/storeBalanceService');

const router = express.Router();

// Store account (own shop only), Admin/Seller, or the store's assigned Sales Executive
const canViewStoreAccount = async (shopId, headers) => {
  if (headers['x-shop-id']) return String(headers['x-shop-id']) === String(shopId);
  const role = headers['x-user-role'];
  if (role === 'Admin' || role === 'Seller') return true;
  if (role === 'Sales Executive' && headers['x-user-id']) {
    return !!(await SalesExecutiveAssignment.findOne({ where: { sales_exec_id: headers['x-user-id'], shop_id: Number(shopId), end_date: null } }));
  }
  return false;
};

const STATUS_FILTERS = { all: 'TRUE', unpaid: "status <> 'paid'", paid: "status = 'paid'" };

// ── GET /customers/balances — receivable/payable for every store (Admin/Seller) ──
router.get('/balances', async (req, res) => {
  if (req.headers['x-shop-id'] || !['Admin', 'Seller'].includes(req.headers['x-user-role'])) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  try {
    return res.json({ success: true, data: { balances: await getAllStoreBalances() } });
  } catch (err) {
    console.error('Error fetching store balances:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /customers/:customerId/balance — one store's receivable, payable and net position ──
router.get('/:customerId/balance', async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(String(customerId))) return res.status(400).json({ success: false, message: 'Invalid store ID' });
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    return res.json({ success: true, data: { balance: await getStoreBalance(customerId) } });
  } catch (err) {
    console.error('Error fetching store balance:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /customers/:customerId/payments-list — the store's payment rows, newest first, paged ──
router.get('/:customerId/payments-list', async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(String(customerId))) return res.status(400).json({ success: false, message: 'Invalid store ID' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const rows = await sequelize.query(`
      SELECT p.id, p.verified_at, p.payment_method, p.payment_amount, p.payment_reference_no, p.remarks,
             i.order_id, u.name AS recorded_by, COUNT(*) OVER()::int AS filtered_total
      FROM "InvoicePaymentHistories" p
      JOIN "Invoices" i ON i.id = p.invoice_id
      JOIN "Orders" o ON o.id = i.order_id
      LEFT JOIN "Users" u ON u.id = p.verified_by_user_id
      WHERE o.shop_id = :shopId AND o.status NOT IN ('cancelled', 'rejected')
      ORDER BY p.verified_at DESC, p.id DESC
      LIMIT :limit OFFSET :offset`,
    { replacements: { shopId: Number(customerId), limit, offset: (page - 1) * limit }, type: QueryTypes.SELECT });
    const total = rows[0]?.filtered_total || 0;
    return res.json({
      success: true,
      data: {
        payments: rows.map((r) => ({
          id: r.id,
          payment_date: r.verified_at,
          payment_method: r.payment_method,
          amount: round2(r.payment_amount),
          reference_no: r.payment_reference_no,
          remarks: r.remarks,
          order_number: `WS-${r.order_id}`,
          invoice_number: `INV-${r.order_id}`,
          recorded_by: r.recorded_by,
        })),
        pagination: { page, limit, total, has_more: page * limit < total },
      }
    });
  } catch (err) {
    console.error('Error fetching store payments:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /customers/:customerId/payment-history — account summary + paged order-wise balances ──
// query: status=unpaid|paid|all (default unpaid), search=<order/invoice number>, page (1+), limit (1-50, default 20)
router.get('/:customerId/payment-history', async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(String(customerId))) return res.status(400).json({ success: false, message: 'Invalid store ID' });
  const status = STATUS_FILTERS[req.query.status] ? req.query.status : 'unpaid';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const digits = String(req.query.search || '').replace(/\D/g, '').slice(0, 12);
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const shopId = Number(customerId);
    const [[counts], rows, balance] = await Promise.all([
      sequelize.query(`${INVOICE_BALANCES_SQL}
        SELECT COUNT(*)::int AS count_all,
               COUNT(*) FILTER (WHERE status <> 'paid')::int AS count_unpaid,
               COUNT(*) FILTER (WHERE status = 'paid')::int AS count_paid
        FROM tagged`, { replacements: { shopId }, type: QueryTypes.SELECT }),
      sequelize.query(`${INVOICE_BALANCES_SQL}
        SELECT *, COUNT(*) OVER()::int AS filtered_total FROM tagged
        WHERE ${STATUS_FILTERS[status]} AND (:digits = '' OR order_id::text LIKE :like)
        ORDER BY order_date DESC, invoice_id DESC
        LIMIT :limit OFFSET :offset`,
      { replacements: { shopId, digits, like: `%${digits}%`, limit, offset: (page - 1) * limit }, type: QueryTypes.SELECT }),
      getStoreBalance(shopId),
    ]);

    const filteredTotal = rows[0]?.filtered_total || 0;
    return res.json({
      success: true,
      data: {
        summary: {
          total_invoiced: balance.total_invoiced,
          total_payments: balance.total_payments,
          total_credits_applied: balance.total_credits_applied,
          outstanding_balance: balance.receivable,
          available_credit: balance.available_credit,
        },
        counts: { all: counts.count_all, unpaid: counts.count_unpaid, paid: counts.count_paid },
        orders: rows.map((r) => ({
          invoice_id: r.invoice_id,
          order_id: r.order_id,
          order_number: `WS-${r.order_id}`,
          invoice_number: `INV-${r.order_id}`,
          order_date: r.order_date,
          total: round2(r.total),
          paid: round2(r.paid),
          credited: round2(r.credited),
          outstanding: round2(r.outstanding),
          status: r.status,
          payment_count: r.payment_count,
          last_payment_at: r.last_payment_at,
        })),
        pagination: { page, limit, total: filteredTotal, has_more: page * limit < filteredTotal },
        filter: { status, search: digits },
      }
    });
  } catch (err) {
    console.error('Error fetching payment history:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /customers/:customerId/orders/:orderId/payment-history — one order's billing timeline ──
router.get('/:customerId/orders/:orderId/payment-history', async (req, res) => {
  const { customerId, orderId } = req.params;
  if (!/^\d+$/.test(String(customerId)) || !/^\d+$/.test(String(orderId))) {
    return res.status(400).json({ success: false, message: 'Invalid store or order ID' });
  }
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const order = await Order.findOne({ where: { id: Number(orderId), shop_id: Number(customerId) } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const invoice = await Invoice.findOne({
      where: { order_id: order.id },
      include: [
        { model: InvoicePaymentHistory, as: 'PaymentHistory' },
        { model: CreditNoteApplication, as: 'CreditApplications', include: [{ model: CreditNote, attributes: ['id', 'credit_note_number'] }] },
      ],
    });
    if (!invoice) return res.status(404).json({ success: false, message: 'This order has not been invoiced yet' });

    const entries = [
      ...(invoice.PaymentHistory || []).map((p) => ({
        type: 'payment', date: p.verified_at, amount: p.payment_amount,
        payment_method: p.payment_method, reference_no: p.payment_reference_no, remarks: p.remarks, payment_id: p.id,
      })),
      ...(invoice.CreditApplications || []).map((a) => ({
        type: 'credit', date: a.created_at, amount: a.amount, credit_note_number: a.CreditNote?.credit_note_number,
      })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = round2(invoice.final_amount);
    const timeline = [{ type: 'invoice', date: order.approved_at || order.created_at, amount: round2(invoice.final_amount), balance_after: balance }];
    for (const e of entries) {
      balance = round2(balance - e.amount);
      timeline.push({ ...e, amount: round2(e.amount), balance_after: Math.max(0, balance) });
    }
    const paid = round2((invoice.PaymentHistory || []).reduce((s, p) => s + p.payment_amount, 0));
    const credited = round2((invoice.CreditApplications || []).reduce((s, a) => s + a.amount, 0));
    const outstanding = Math.max(0, round2(invoice.final_amount - paid - credited));

    return res.json({
      success: true,
      data: {
        order_id: order.id,
        order_number: `WS-${order.id}`,
        invoice_number: `INV-${order.id}`,
        order_date: order.created_at,
        order_status: order.status,
        total: round2(invoice.final_amount),
        paid,
        credited,
        outstanding,
        status: outstanding <= 0.005 ? 'paid' : paid + credited > 0.005 ? 'partially_paid' : 'unpaid',
        invoice_pdf_url: invoice.pdf_url,
        timeline,
      }
    });
  } catch (err) {
    console.error('Error fetching order payment history:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /customers/:customerId/credit-notes — the store's credit notes with usage ──
router.get('/:customerId/credit-notes', async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(String(customerId))) return res.status(400).json({ success: false, message: 'Invalid store ID' });
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const notes = await CreditNote.findAll({
      include: [
        { model: Order, attributes: ['id', 'shop_id'], where: { shop_id: Number(customerId) } },
        { model: OrderReturn, attributes: ['id', 'return_date', 'reason'], include: [{ model: OrderReturnItem, as: 'items' }] },
        { model: CreditNoteApplication, as: 'Applications', include: [{ model: Invoice, attributes: ['id', 'order_id'] }] },
      ],
      order: [['issued_at', 'DESC']],
    });
    const creditNotes = notes.map((cn) => ({
      id: cn.id,
      credit_note_number: cn.credit_note_number,
      order_number: `WS-${cn.order_id}`,
      invoice_number: `INV-${cn.order_id}`,
      issued_at: cn.issued_at,
      return_date: cn.OrderReturn?.return_date,
      reason: cn.OrderReturn?.reason || null,
      amount: cn.amount,
      used_amount: round2(Number(cn.used_amount) || 0),
      remaining_amount: remainingOf(cn),
      status: usageStatusOf(cn),
      pdf_url: cn.pdf_url,
      items: (cn.OrderReturn?.items || []).map((i) => ({
        product_name: i.product_name, sku_id: i.sku_id, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total,
      })),
      usage: (cn.Applications || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((a) => ({ date: a.created_at, invoice_number: `INV-${a.Invoice?.order_id}`, amount: a.amount, source: a.source })),
    }));
    return res.json({
      success: true,
      data: {
        total_available: round2(creditNotes.reduce((s, c) => s + c.remaining_amount, 0)),
        credit_notes: creditNotes,
      }
    });
  } catch (err) {
    console.error('Error fetching credit notes:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/:customerId/payments', async (req, res) => {
  const { customerId } = req.params;
  try {
    const invoices = await Invoice.findAll({
      include: [
        {
          model: Order,
          where: { shop_id: customerId },
          attributes: ['id', 'created_at', 'total_amount', 'status']
        },
        {
          model: InvoicePaymentHistory,
          as: 'PaymentHistory',
          include: [
            {
              model: User,
              as: 'VerifiedBy',
              attributes: ['id', 'name', 'role']
            }
          ]
        }
      ],
      order: [['id', 'DESC']]
    });

    const mappedInvoices = invoices.map((inv) => {
      // Sort payments chronologically by verified_at
      const sortedHistory = (inv.PaymentHistory || []).sort(
        (a, b) => new Date(a.verified_at) - new Date(b.verified_at)
      );

      // Calculate chronological balance after each payment
      let accumulatedPaid = 0;
      const paymentHistory = sortedHistory.map((p) => {
        accumulatedPaid += p.payment_amount;
        const remainingBalanceAfter = Math.max(0, inv.final_amount - accumulatedPaid);
        return {
          id: p.id,
          verified_at: p.verified_at,
          payment_method: p.payment_method,
          payment_amount: p.payment_amount,
          payment_reference_no: p.payment_reference_no,
          remarks: p.remarks,
          verified_by_user_id: p.verified_by_user_id,
          VerifiedBy: p.VerifiedBy,
          remaining_balance_after: remainingBalanceAfter
        };
      });

      // Current calculations dynamically
      const totalAmountPaid = accumulatedPaid;
      const totalCredited = Number(inv.total_credited_amount) || 0;
      const remainingBalance = Math.max(0, inv.final_amount - totalAmountPaid - totalCredited);

      let paymentStatus = 'Unpaid';
      if (totalAmountPaid + totalCredited > 0.01) {
        if (remainingBalance <= 0.01) {
          paymentStatus = 'Paid';
        } else {
          paymentStatus = 'Partially Paid';
        }
      }

      return {
        invoice_id: inv.id,
        invoice_number: `INV-${inv.Order.id}`,
        order_number: `WS-${inv.Order.id}`,
        invoice_date: inv.generated_at,
        total_invoice_amount: inv.final_amount,
        total_amount_paid: totalAmountPaid,
        total_credited_amount: totalCredited,
        remaining_balance: remainingBalance,
        payment_status: paymentStatus,
        payment_history: paymentHistory
      };
    });

    return res.json({
      success: true,
      message: 'Customer payments fetched successfully',
      data: { invoices: mappedInvoices }
    });
  } catch (err) {
    console.error('Error fetching customer payments:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
