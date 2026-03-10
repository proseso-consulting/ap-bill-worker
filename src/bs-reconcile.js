// @ts-nocheck
const { kwWithCompany } = require("./odoo");

/**
 * Attempt to auto-reconcile imported bank statement lines against open invoices/bills.
 *
 * For each statement line, find potential matches among unreconciled account.move.line
 * items (receivables for deposits, payables for withdrawals), score them, and reconcile
 * if above the confidence threshold.
 *
 * Returns { reconciled: number, suggested: number, details: [] }
 */
async function reconcileStatementLines(odoo, companyId, journalId, lineIds, config, logger) {
  const threshold = config.bankStatement?.reconcileThreshold ?? 0.9;
  const results = { reconciled: 0, suggested: 0, unmatched: 0, details: [] };

  if (!lineIds.length) return results;

  const stLines = await odoo.searchRead(
    "account.bank.statement.line",
    [["id", "in", lineIds]],
    ["id", "date", "amount", "payment_ref", "partner_id", "partner_name", "is_reconciled"],
    kwWithCompany(companyId)
  );

  const unreconciledLines = stLines.filter((l) => !l.is_reconciled);
  if (!unreconciledLines.length) return results;

  // Fetch all unreconciled receivable/payable move lines
  const openMoveLines = await odoo.searchRead(
    "account.move.line",
    [
      ["reconciled", "=", false],
      ["parent_state", "=", "posted"],
      ["account_type", "in", ["asset_receivable", "liability_payable"]],
      ["amount_residual", "!=", 0]
    ],
    ["id", "move_id", "move_name", "partner_id", "amount_residual", "amount_residual_currency", "ref", "name", "date", "account_type"],
    kwWithCompany(companyId, { limit: 2000 })
  );

  if (!openMoveLines.length) {
    results.unmatched = unreconciledLines.length;
    return results;
  }

  for (const stLine of unreconciledLines) {
    const match = findBestMatch(stLine, openMoveLines);

    if (!match) {
      results.unmatched += 1;
      results.details.push({
        line_id: stLine.id,
        payment_ref: stLine.payment_ref,
        amount: stLine.amount,
        status: "unmatched",
        confidence: 0
      });
      continue;
    }

    if (match.confidence >= threshold) {
      const success = await tryReconcile(odoo, companyId, stLine, match.moveLines);
      if (success) {
        results.reconciled += 1;
        results.details.push({
          line_id: stLine.id,
          payment_ref: stLine.payment_ref,
          amount: stLine.amount,
          status: "reconciled",
          confidence: match.confidence,
          matched_moves: match.moveLines.map((m) => m.move_name).join(", "),
          reason: match.reason
        });
        // Remove matched move lines from pool
        const matchedIds = new Set(match.moveLines.map((m) => m.id));
        openMoveLines.splice(0, openMoveLines.length, ...openMoveLines.filter((m) => !matchedIds.has(m.id)));
        continue;
      }
    }

    results.suggested += 1;
    results.details.push({
      line_id: stLine.id,
      payment_ref: stLine.payment_ref,
      amount: stLine.amount,
      status: "suggested",
      confidence: match.confidence,
      matched_moves: match.moveLines.map((m) => m.move_name).join(", "),
      reason: match.reason
    });
  }

  return results;
}

/**
 * Find the best matching open move line(s) for a bank statement line.
 * Returns { moveLines: [], confidence: number, reason: string } or null.
 */
function findBestMatch(stLine, openMoveLines) {
  const amount = stLine.amount || 0;
  if (amount === 0) return null;

  const isDeposit = amount > 0;
  const targetType = isDeposit ? "asset_receivable" : "liability_payable";
  const relevantLines = openMoveLines.filter((m) => m.account_type === targetType);

  if (!relevantLines.length) return null;

  let bestMatch = null;
  let bestConfidence = 0;

  // 1. Exact amount + reference match
  const refText = String(stLine.payment_ref || "").trim();
  if (refText) {
    const invoicePatterns = refText.match(/(?:INV|BILL|SO|PO)[\/\-]?\d{4}[\/\-]\d+/gi) || [];
    for (const pattern of invoicePatterns) {
      const patLower = pattern.toLowerCase();
      for (const ml of relevantLines) {
        const moveRef = String(ml.ref || ml.move_name || ml.name || "").toLowerCase();
        if (moveRef.includes(patLower) && amountMatches(amount, ml.amount_residual)) {
          const conf = 0.98;
          if (conf > bestConfidence) {
            bestMatch = { moveLines: [ml], confidence: conf, reason: `Reference "${pattern}" + exact amount` };
            bestConfidence = conf;
          }
        }
      }
    }
  }

  // 2. Exact amount match (single line)
  if (bestConfidence < 0.95) {
    for (const ml of relevantLines) {
      if (amountMatches(amount, ml.amount_residual)) {
        let conf = 0.7;
        // Boost if partner matches
        if (partnersMatch(stLine, ml)) conf += 0.2;
        // Boost if reference partially matches
        if (refPartialMatch(stLine.payment_ref, ml)) conf += 0.1;

        conf = Math.min(conf, 1.0);
        if (conf > bestConfidence) {
          bestMatch = { moveLines: [ml], confidence: conf, reason: "Amount match" + (partnersMatch(stLine, ml) ? " + partner" : "") };
          bestConfidence = conf;
        }
      }
    }
  }

  // 3. Multi-invoice match (same partner, amounts sum to statement line amount)
  if (bestConfidence < 0.85) {
    const byPartner = groupByPartner(relevantLines);
    for (const [partnerId, partnerLines] of byPartner) {
      if (!partnerId) continue;
      const combo = findSubsetSum(partnerLines, amount);
      if (combo) {
        let conf = 0.8;
        if (stLine.partner_id && Number(stLine.partner_id[0] || stLine.partner_id) === partnerId) {
          conf += 0.1;
        }
        if (conf > bestConfidence) {
          bestMatch = { moveLines: combo, confidence: conf, reason: `Multi-invoice match (${combo.length} items, same partner)` };
          bestConfidence = conf;
        }
      }
    }
  }

  return bestMatch;
}

function amountMatches(stAmount, moveResidual) {
  // For deposits (positive stLine), we match against positive residuals (receivables)
  // For withdrawals (negative stLine), we match against negative residuals (payables)
  return Math.abs(Math.abs(stAmount) - Math.abs(moveResidual)) < 0.01;
}

function partnersMatch(stLine, moveLine) {
  const stPartnerId = stLine.partner_id
    ? (Array.isArray(stLine.partner_id) ? Number(stLine.partner_id[0]) : Number(stLine.partner_id))
    : 0;
  const mlPartnerId = moveLine.partner_id
    ? (Array.isArray(moveLine.partner_id) ? Number(moveLine.partner_id[0]) : Number(moveLine.partner_id))
    : 0;

  if (stPartnerId && mlPartnerId && stPartnerId === mlPartnerId) return true;

  // Fuzzy name match
  const stName = String(stLine.partner_name || stLine.payment_ref || "").toLowerCase();
  const mlName = moveLine.partner_id
    ? String(Array.isArray(moveLine.partner_id) ? moveLine.partner_id[1] : "").toLowerCase()
    : "";

  if (stName && mlName && (stName.includes(mlName) || mlName.includes(stName))) return true;
  return false;
}

function refPartialMatch(paymentRef, moveLine) {
  if (!paymentRef) return false;
  const ref = String(paymentRef).toLowerCase();
  const moveRef = String(moveLine.ref || moveLine.move_name || moveLine.name || "").toLowerCase();
  if (!moveRef) return false;
  return ref.includes(moveRef) || moveRef.includes(ref);
}

function groupByPartner(moveLines) {
  const map = new Map();
  for (const ml of moveLines) {
    const pid = ml.partner_id ? (Array.isArray(ml.partner_id) ? Number(ml.partner_id[0]) : Number(ml.partner_id)) : 0;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(ml);
  }
  return map;
}

/**
 * Find a subset of moveLines whose absolute residuals sum to the absolute value of targetAmount.
 * Simple greedy approach for up to ~10 items per partner.
 */
function findSubsetSum(moveLines, targetAmount, maxItems = 10) {
  const target = Math.abs(targetAmount);
  const items = moveLines
    .map((ml) => ({ ml, abs: Math.abs(ml.amount_residual) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, maxItems);

  // Try combinations up to 5 items
  const maxCombo = Math.min(items.length, 5);
  for (let size = 2; size <= maxCombo; size++) {
    const result = combos(items, size, target);
    if (result) return result.map((r) => r.ml);
  }
  return null;
}

function combos(items, size, target, start = 0, current = [], sum = 0) {
  if (current.length === size) {
    return Math.abs(sum - target) < 0.01 ? [...current] : null;
  }
  for (let i = start; i < items.length; i++) {
    current.push(items[i]);
    const result = combos(items, size, target, i + 1, current, sum + items[i].abs);
    if (result) return result;
    current.pop();
  }
  return null;
}

/**
 * Attempt to reconcile a statement line with matched move lines via the
 * account.bank.statement.line `action_undo_reconciliation` / partner matching.
 *
 * In Odoo 19, the cleanest external API approach is to set the partner on the
 * statement line and let Odoo's auto-reconciliation handle it, or use
 * account.reconcile.wizard if available.
 */
async function tryReconcile(odoo, companyId, stLine, moveLines) {
  try {
    // Set partner on statement line if we found a match
    const partnerId = moveLines[0]?.partner_id
      ? (Array.isArray(moveLines[0].partner_id) ? Number(moveLines[0].partner_id[0]) : Number(moveLines[0].partner_id))
      : 0;

    if (partnerId && !stLine.partner_id) {
      await odoo.write("account.bank.statement.line", [stLine.id], { partner_id: partnerId });
    }

    // Get the statement line's underlying move lines (the suspense/outstanding line)
    const stMoveLines = await odoo.searchRead(
      "account.move.line",
      [
        ["move_id.statement_line_id", "=", stLine.id],
        ["reconciled", "=", false],
        ["account_type", "in", ["asset_receivable", "liability_payable"]]
      ],
      ["id"],
      kwWithCompany(companyId, { limit: 10 })
    );

    if (!stMoveLines.length) return false;

    // Reconcile via account.move.line reconcile method
    const allIds = [...stMoveLines.map((l) => l.id), ...moveLines.map((l) => l.id)];
    await odoo.executeKw("account.move.line", "reconcile", [allIds], kwWithCompany(companyId));
    return true;
  } catch (err) {
    // Reconciliation via direct API may fail in some Odoo setups — not critical
    return false;
  }
}

module.exports = {
  reconcileStatementLines,
  findBestMatch
};
