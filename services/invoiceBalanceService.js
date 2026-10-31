// Shared invoice balance rules: balance = total - paid - credited (credit notes), rounded to cents.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const computeInvoiceBalance = (finalAmount, paid, credited = 0) => {
  const covered = round2(paid) + round2(credited);
  const remaining = round2(finalAmount - covered);
  const payment_status = covered >= finalAmount - 0.005 && covered > 0.005
    ? 'paid'
    : round2(paid) > 0.005 ? 'partially_paid' : 'unsettled';
  return { remaining_balance: remaining < 0.005 ? 0 : remaining, payment_status };
};

module.exports = { round2, computeInvoiceBalance };
