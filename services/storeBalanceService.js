// Store account balances from actual records: invoices, payment rows, credit notes and credit applications.
// Receivable (store owes us) and payable (we owe the store) are both derived here, so every screen agrees.
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db');
const { round2 } = require('./invoiceBalanceService');

// Per-invoice figures for billable orders (cancelled/rejected orders aren't owed).
// :shopId may be NULL to cover every store.
const INVOICE_BALANCES_SQL = `
  WITH inv AS (
    SELECT i.id AS invoice_id, i.order_id, o.shop_id, o.created_at AS order_date, i.pdf_url,
           i.final_amount::numeric AS total,
           COALESCE(p.paid, 0)::numeric AS paid,
           COALESCE(p.n, 0)::int AS payment_count,
           p.last_paid_at AS last_payment_at,
           COALESCE(a.credited, 0)::numeric AS credited
    FROM "Invoices" i
    JOIN "Orders" o ON o.id = i.order_id
    LEFT JOIN (
      SELECT invoice_id, SUM(payment_amount) AS paid, COUNT(*) AS n, MAX(verified_at) AS last_paid_at
      FROM "InvoicePaymentHistories" GROUP BY invoice_id
    ) p ON p.invoice_id = i.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount) AS credited FROM "CreditNoteApplications" GROUP BY invoice_id
    ) a ON a.invoice_id = i.id
    WHERE (CAST(:shopId AS INTEGER) IS NULL OR o.shop_id = :shopId)
      AND o.status NOT IN ('cancelled', 'rejected')
  ), calc AS (
    SELECT *,
      GREATEST(0, ROUND(total - paid - credited, 2)) AS outstanding,
      GREATEST(0, ROUND(paid + credited - total, 2)) AS overpaid
    FROM inv
  ), tagged AS (
    SELECT *, CASE
      WHEN outstanding <= 0.005 THEN 'paid'
      WHEN paid + credited > 0.005 THEN 'partially_paid'
      ELSE 'unpaid' END AS status
    FROM calc
  )`;

// Per-store totals. Credit notes are counted once each: issued amount, minus what their applications used.
const STORE_BALANCES_SQL = `${INVOICE_BALANCES_SQL}
  , inv_totals AS (
    SELECT shop_id,
           SUM(total) AS total_invoiced,
           SUM(paid) AS total_payments,
           SUM(GREATEST(0, ROUND(paid - overpaid, 2))) AS payments_applied,
           SUM(credited) AS credits_on_invoices,
           SUM(outstanding) AS receivable,
           SUM(overpaid) AS overpaid,
           COUNT(*)::int AS invoice_count,
           COUNT(*) FILTER (WHERE status <> 'paid')::int AS open_invoice_count
    FROM tagged GROUP BY shop_id
  ), cn AS (
    SELECT o.shop_id,
           SUM(c.amount) AS credits_issued,
           SUM(LEAST(c.amount, COALESCE(u.applied, 0))) AS credits_applied,
           SUM(GREATEST(0, ROUND((c.amount - COALESCE(u.applied, 0))::numeric, 2))) AS unused_credit,
           COUNT(*)::int AS credit_note_count,
           COUNT(*) FILTER (WHERE c.amount - COALESCE(u.applied, 0) > 0.005)::int AS open_credit_note_count
    FROM "CreditNotes" c
    JOIN "Orders" o ON o.id = c.order_id
    LEFT JOIN (SELECT credit_note_id, SUM(amount) AS applied FROM "CreditNoteApplications" GROUP BY credit_note_id) u
      ON u.credit_note_id = c.id
    WHERE (CAST(:shopId AS INTEGER) IS NULL OR o.shop_id = :shopId)
    GROUP BY o.shop_id
  )
  SELECT COALESCE(t.shop_id, cn.shop_id) AS shop_id,
         COALESCE(t.total_invoiced, 0) AS total_invoiced,
         COALESCE(t.total_payments, 0) AS total_payments,
         COALESCE(t.payments_applied, 0) AS payments_applied,
         COALESCE(t.credits_on_invoices, 0) AS credits_on_invoices,
         COALESCE(t.receivable, 0) AS receivable,
         COALESCE(t.overpaid, 0) AS overpaid,
         COALESCE(t.invoice_count, 0) AS invoice_count,
         COALESCE(t.open_invoice_count, 0) AS open_invoice_count,
         COALESCE(cn.credits_issued, 0) AS credits_issued,
         COALESCE(cn.credits_applied, 0) AS credits_applied,
         COALESCE(cn.unused_credit, 0) AS unused_credit,
         COALESCE(cn.credit_note_count, 0) AS credit_note_count,
         COALESCE(cn.open_credit_note_count, 0) AS open_credit_note_count
  FROM inv_totals t
  FULL OUTER JOIN cn ON cn.shop_id = t.shop_id`;

const toBalance = (r, shopId) => {
  const receivable = round2(r?.receivable);
  const unusedCredit = round2(r?.unused_credit);
  const overpaid = round2(r?.overpaid);
  const payable = round2(unusedCredit + overpaid);
  const net = round2(receivable - payable);
  const totalPayments = round2(r?.total_payments);
  const paymentsApplied = round2(r?.payments_applied ?? Math.max(0, round2(totalPayments - overpaid)));
  return {
    shop_id: Number(r?.shop_id ?? shopId),
    total_invoiced: round2(r?.total_invoiced),
    total_payments: totalPayments,
    payments_applied: paymentsApplied,
    total_credits_issued: round2(r?.credits_issued),
    total_credits_applied: round2(r?.credits_applied),
    available_credit: unusedCredit,
    overpayments: overpaid,
    receivable,
    payable,
    net_balance: Math.abs(net),
    net_position: net > 0.005 ? 'store_owes_us' : net < -0.005 ? 'we_owe_store' : 'settled',
    invoice_count: Number(r?.invoice_count || 0),
    open_invoice_count: Number(r?.open_invoice_count || 0),
    credit_note_count: Number(r?.credit_note_count || 0),
    open_credit_note_count: Number(r?.open_credit_note_count || 0),
  };
};

const getStoreBalance = async (shopId) => {
  const rows = await sequelize.query(STORE_BALANCES_SQL, { replacements: { shopId: Number(shopId) }, type: QueryTypes.SELECT });
  return toBalance(rows[0], shopId);
};

// Every store with any invoice or credit note
const getAllStoreBalances = async () => {
  const rows = await sequelize.query(STORE_BALANCES_SQL, { replacements: { shopId: null }, type: QueryTypes.SELECT });
  return rows.map((r) => toBalance(r));
};

module.exports = { INVOICE_BALANCES_SQL, getStoreBalance, getAllStoreBalances };
