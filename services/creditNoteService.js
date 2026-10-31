// Credit-note usage: applying credit to invoices, usage status, and backfilling notes issued before tracking.
const { CreditNote, CreditNoteApplication, Invoice, InvoicePaymentHistory, Order } = require('../models');
const sequelize = require('../config/db');
const { round2, computeInvoiceBalance } = require('./invoiceBalanceService');

const remainingOf = (cn) => Math.max(0, round2(cn.amount - (Number(cn.used_amount) || 0)));

const usageStatusOf = (cn) => {
  const used = Number(cn.used_amount) || 0;
  if (used <= 0.005) return 'Available';
  return remainingOf(cn) <= 0.005 ? 'Fully Used' : 'Partially Used';
};

const paidOn = async (invoiceId, transaction) =>
  round2(Number(await InvoicePaymentHistory.sum('payment_amount', { where: { invoice_id: invoiceId }, transaction })) || 0);

// What is still owed on an invoice, from actual payments and applied credits
const outstandingOf = async (invoice, transaction) => {
  const paid = await paidOn(invoice.id, transaction);
  return { paid, outstanding: Math.max(0, round2(invoice.final_amount - paid - (Number(invoice.total_credited_amount) || 0))) };
};

// Caller must hold row locks on the invoice and the credit note inside `transaction`
const applyCreditToInvoice = async ({ creditNote, invoice, shopId, amount, source, userId = null, requestKey = null, transaction }) => {
  const applied = round2(amount);
  const application = await CreditNoteApplication.create({
    credit_note_id: creditNote.id,
    invoice_id: invoice.id,
    shop_id: shopId,
    amount: applied,
    source,
    applied_by_user_id: userId,
    request_key: requestKey,
  }, { transaction });

  await creditNote.update({ used_amount: round2((Number(creditNote.used_amount) || 0) + applied) }, { transaction });

  const paid = await paidOn(invoice.id, transaction);
  const credited = round2((Number(invoice.total_credited_amount) || 0) + applied);
  await invoice.update({
    total_paid_amount: paid,
    total_credited_amount: credited,
    ...computeInvoiceBalance(invoice.final_amount, paid, credited),
  }, { transaction });

  return application;
};

// Notes issued before usage tracking added their full amount to the original invoice.
// Re-apply them in issue order, capped at what each invoice still owed; the rest stays available.
const backfillLegacyCreditNotes = async () => {
  const legacy = await CreditNote.findAll({ where: { used_amount: null }, order: [['issued_at', 'ASC'], ['id', 'ASC']] });
  const invoiceIds = [...new Set(legacy.map((cn) => cn.invoice_id))];
  for (const invoiceId of invoiceIds) {
    await sequelize.transaction(async (t) => {
      const invoice = await Invoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
      const order = await Order.findByPk(invoice.order_id, { transaction: t });
      const notes = await CreditNote.findAll({
        where: { invoice_id: invoiceId, used_amount: null },
        order: [['issued_at', 'ASC'], ['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      // Start from tracked applications only, dropping the legacy full-amount credits
      const tracked = round2(Number(await CreditNoteApplication.sum('amount', { where: { invoice_id: invoiceId }, transaction: t })) || 0);
      await invoice.update({ total_credited_amount: tracked }, { transaction: t });
      for (const cn of notes) {
        await cn.update({ used_amount: 0 }, { transaction: t });
        const { outstanding } = await outstandingOf(invoice, t);
        const amount = Math.min(cn.amount, outstanding);
        if (amount > 0.005) {
          await applyCreditToInvoice({ creditNote: cn, invoice, shopId: order.shop_id, amount, source: 'return_original', transaction: t });
        }
      }
      const paid = await paidOn(invoice.id, t);
      await invoice.update({
        total_paid_amount: paid,
        ...computeInvoiceBalance(invoice.final_amount, paid, Number(invoice.total_credited_amount) || 0),
      }, { transaction: t });
    });
  }
  return legacy.length;
};

module.exports = { remainingOf, usageStatusOf, outstandingOf, applyCreditToInvoice, backfillLegacyCreditNotes };
