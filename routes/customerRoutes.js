const express = require('express');
const Invoice = require('../models/Invoice');
const InvoicePaymentHistory = require('../models/InvoicePaymentHistory');
const Order = require('../models/Order');
const User = require('../models/User');

const router = express.Router();

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
      const remainingBalance = Math.max(0, inv.final_amount - totalAmountPaid);

      let paymentStatus = 'Unpaid';
      if (totalAmountPaid > 0.01) {
        if (remainingBalance <= 0.01) {
          paymentStatus = 'Paid';
        } else {
          paymentStatus = 'Partially Paid';
        }
      }

      return {
        invoice_id: inv.id,
        invoice_number: `INV-${inv.id}`,
        order_number: `WS-${inv.Order.id}`,
        invoice_date: inv.generated_at,
        total_invoice_amount: inv.final_amount,
        total_amount_paid: totalAmountPaid,
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
