// @ts-nocheck
const { kwWithCompany } = require("./odoo");

/**
 * Validate extracted bank statement data.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function validateExtraction(extracted, tolerancePercent = 0.5) {
  const errors = [];
  const warnings = [];

  if (!extracted || typeof extracted !== "object") {
    return { valid: false, errors: ["Extraction returned no data."], warnings };
  }

  if (!extracted.transactions || !extracted.transactions.length) {
    errors.push("No transactions extracted from the statement.");
  }

  if (extracted.opening_balance == null || extracted.closing_balance == null) {
    warnings.push("Opening or closing balance not extracted. Math check skipped.");
  } else {
    const txnSum = (extracted.transactions || []).reduce((s, t) => s + (t.amount || 0), 0);
    const expectedClosing = extracted.opening_balance + txnSum;
    const diff = Math.abs(expectedClosing - extracted.closing_balance);
    const absClosing = Math.abs(extracted.closing_balance) || 1;
    const diffPercent = (diff / absClosing) * 100;

    if (diffPercent > tolerancePercent && diff > 0.01) {
      errors.push(
        `Math mismatch: Opening (${fmtNum(extracted.opening_balance)}) + Transactions (${fmtNum(txnSum)}) = ${fmtNum(expectedClosing)}, ` +
        `but Closing Balance is ${fmtNum(extracted.closing_balance)} (difference: ${fmtNum(diff)}).`
      );
    }
  }

  if (!extracted.account_number) {
    warnings.push("No account number extracted. Journal matching may fail.");
  }

  if (!extracted.currency) {
    warnings.push("No currency detected. Defaulting to journal currency.");
  }

  for (let i = 0; i < (extracted.transactions || []).length; i++) {
    const txn = extracted.transactions[i];
    if (!txn.date) warnings.push(`Transaction #${i + 1}: missing date.`);
    if (txn.amount === 0) warnings.push(`Transaction #${i + 1}: zero amount.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check if a statement has already been imported into the given journal.
 * Looks for existing statement lines in the date range with matching balance.
 */
async function checkDuplicate(odoo, companyId, journalId, extracted) {
  if (!journalId || !extracted.statement_date_from || !extracted.statement_date_to) {
    return { isDuplicate: false, existingCount: 0 };
  }

  const domain = [
    ["journal_id", "=", journalId],
    ["date", ">=", extracted.statement_date_from],
    ["date", "<=", extracted.statement_date_to]
  ];

  const existing = await odoo.searchRead(
    "account.bank.statement.line",
    domain,
    ["id", "date", "amount"],
    kwWithCompany(companyId, { limit: 500 })
  );

  if (!existing.length) return { isDuplicate: false, existingCount: 0 };

  const extractedCount = (extracted.transactions || []).length;
  const extractedSum = (extracted.transactions || []).reduce((s, t) => s + (t.amount || 0), 0);
  const existingSum = existing.reduce((s, l) => s + (l.amount || 0), 0);

  if (
    existing.length === extractedCount &&
    Math.abs(existingSum - extractedSum) < 0.01
  ) {
    return { isDuplicate: true, existingCount: existing.length, existingLineIds: existing.map((l) => l.id) };
  }

  return { isDuplicate: false, existingCount: existing.length };
}

/**
 * Check statement continuity: does this statement's opening balance match
 * the previous statement's closing balance in the same journal?
 */
async function checkContinuity(odoo, companyId, journalId, extracted) {
  if (!journalId || !extracted.statement_date_from || extracted.opening_balance == null) {
    return { hasGap: false, message: null };
  }

  const domain = [
    ["journal_id", "=", journalId],
    ["date", "<", extracted.statement_date_from]
  ];

  const prevLines = await odoo.searchRead(
    "account.bank.statement.line",
    domain,
    ["id", "date", "amount"],
    kwWithCompany(companyId, { limit: 1000, order: "date desc, id desc" })
  );

  if (!prevLines.length) return { hasGap: false, message: null };

  // Compute the effective closing balance of previous period by summing all previous lines
  // This is approximate — ideally we'd check the actual last statement's closing balance
  const lastDate = prevLines[0].date;
  const prevSum = prevLines.reduce((s, l) => s + (l.amount || 0), 0);

  // We can't reliably compute the previous closing balance without knowing the original opening.
  // Instead, just warn if there is a time gap.
  const lastDateObj = new Date(lastDate);
  const thisDateObj = new Date(extracted.statement_date_from);
  const gapDays = Math.floor((thisDateObj - lastDateObj) / (1000 * 60 * 60 * 24));

  if (gapDays > 45) {
    return {
      hasGap: true,
      message: `Gap detected: Last recorded transaction was on ${lastDate} (${gapDays} days ago). Statement period missing between ${lastDate} and ${extracted.statement_date_from}.`
    };
  }

  return { hasGap: false, message: null };
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = {
  validateExtraction,
  checkDuplicate,
  checkContinuity,
  fmtNum
};
