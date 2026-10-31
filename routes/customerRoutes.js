const express = require('express');
const Invoice = require('../models/Invoice');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const Order = require('../models/Order');
const User = require('../models/User');
const { Op } = require('sequelize');
const CreditNote = require('../models/CreditNote');
const CreditNoteApplication = require('../models/CreditNoteApplication');
const OrderReturn = require('../models/OrderReturn');
const OrderReturnItem = require('../models/OrderReturnItem');
const SalesExecutiveAssignment = require('../models/SalesExecutiveAssignment');
const { round2 } = require('../services/invoiceBalanceService');
const { remainingOf, usageStatusOf } = require('../services/creditNoteService');

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

// Cancelled/rejected orders aren't owed
const BILLABLE_ORDER = (shopId) => ({ shop_id: shopId, status: { [Op.notIn]: ['cancelled', 'rejected'] } });

// ── GET /customers/:customerId/payment-history — payments, credit adjustments and balance summary ──
router.get('/:customerId/payment-history', async (req, res) => {
  const { customerId } = req.params;
  if (!/^\d+$/.test(String(customerId))) return res.status(400).json({ success: false, message: 'Invalid store ID' });
  try {
    if (!(await canViewStoreAccount(customerId, req.headers))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const invoices = await Invoice.findAll({
      include: [
        { model: Order, where: BILLABLE_ORDER(Number(customerId)), attributes: ['id', 'status', 'created_at'] },
        { model: InvoicePaymentHistory, as: 'PaymentHistory' },
        { model: CreditNoteApplication, as: 'CreditApplications', include: [{ model: CreditNote, attributes: ['id', 'credit_note_number'] }] },
      ],
      order: [['id', 'DESC']],
    });
    const notes = await CreditNote.findAll({ include: [{ model: Order, attributes: [], where: { shop_id: Number(customerId) } }] });

    let totalInvoiced = 0, totalPaid = 0, totalCredits = 0, outstanding = 0;
    const payments = [];
    const creditAdjustments = [];
    const invoiceRows = invoices.map((inv) => {
      const number = `INV-${inv.Order.id}`;
      const paid = round2((inv.PaymentHistory || []).reduce((s, p) => s + p.payment_amount, 0));
      const credited = round2((inv.CreditApplications || []).reduce((s, a) => s + a.amount, 0));
      const owed = Math.max(0, round2(inv.final_amount - paid - credited));
      totalInvoiced += inv.final_amount; totalPaid += paid; totalCredits += credited; outstanding += owed;
      for (const p of inv.PaymentHistory || []) {
        payments.push({
          id: p.id,
          payment_date: p.verified_at,
          reference_no: p.payment_reference_no,
          invoice_number: number,
          order_number: `WS-${inv.Order.id}`,
          payment_method: p.payment_method,
          amount: p.payment_amount,
          remarks: p.remarks,
        });
      }
      for (const a of inv.CreditApplications || []) {
        creditAdjustments.push({
          id: a.id,
          date: a.created_at,
          credit_note_number: a.CreditNote?.credit_note_number,
          invoice_number: number,
          amount: a.amount,
          source: a.source,
        });
      }
      return { invoice_number: number, order_number: `WS-${inv.Order.id}`, invoice_date: inv.generated_at, total: inv.final_amount, paid, credited, outstanding: owed };
    });
    payments.sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date));
    creditAdjustments.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json({
      success: true,
      data: {
        summary: {
          total_invoiced: round2(totalInvoiced),
          total_payments: round2(totalPaid),
          total_credits_applied: round2(totalCredits),
          outstanding_balance: round2(outstanding),
          available_credit: round2(notes.reduce((s, cn) => s + remainingOf(cn), 0)),
        },
        payments,
        credit_adjustments: creditAdjustments,
        invoices: invoiceRows,
      }
    });
  } catch (err) {
    console.error('Error fetching payment history:', err);
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
