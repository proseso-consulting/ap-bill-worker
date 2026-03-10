// @ts-nocheck
const { kwWithCompany } = require("./odoo");

/**
 * Normalize an account number for comparison: strip spaces, dashes, leading zeros.
 */
function normalizeAccNumber(raw) {
  return String(raw || "")
    .replace(/[\s\-\.]/g, "")
    .replace(/^0+/, "")
    .trim();
}

/**
 * Match bank journal using a cascade:
 * 1. Account number match against journal.bank_acc_number
 * 2. Subfolder name mapping
 * 3. User hint (journal name from chatter)
 * 4. Single journal fallback
 * 5. Error if unresolved
 *
 * Returns { journal: { id, name, bank_acc_number, currency_id }, error: string|null }
 */
async function matchBankJournal(odoo, companyId, extracted, options = {}) {
  const { folderName, userHint, logger } = options;

  const journals = await odoo.searchRead(
    "account.journal",
    [["type", "=", "bank"]],
    ["id", "name", "bank_acc_number", "currency_id", "company_id"],
    kwWithCompany(companyId, { limit: 100 })
  );

  if (!journals.length) {
    return { journal: null, error: "No bank journals found in this Odoo database." };
  }

  // 1. Account number match
  const extractedAccNum = normalizeAccNumber(extracted.account_number);
  if (extractedAccNum) {
    const exactMatch = journals.find(
      (j) => normalizeAccNumber(j.bank_acc_number) === extractedAccNum
    );
    if (exactMatch) {
      logger?.info("bs-journal: matched by exact account number.", { journalId: exactMatch.id, journalName: exactMatch.name });
      return { journal: exactMatch, error: null };
    }

    // Try last-4-digit match
    if (extractedAccNum.length >= 4) {
      const last4 = extractedAccNum.slice(-4);
      const partialMatches = journals.filter(
        (j) => normalizeAccNumber(j.bank_acc_number).endsWith(last4)
      );
      if (partialMatches.length === 1) {
        logger?.info("bs-journal: matched by last-4 digits.", { journalId: partialMatches[0].id, journalName: partialMatches[0].name, last4 });
        return { journal: partialMatches[0], error: null };
      }
    }
  }

  // 2. Subfolder name mapping
  if (folderName) {
    const folderLower = String(folderName).toLowerCase().trim();
    const folderMatch = journals.find(
      (j) => String(j.name || "").toLowerCase().trim().includes(folderLower) ||
             folderLower.includes(String(j.name || "").toLowerCase().trim())
    );
    if (folderMatch) {
      logger?.info("bs-journal: matched by folder name.", { journalId: folderMatch.id, journalName: folderMatch.name, folderName });
      return { journal: folderMatch, error: null };
    }
  }

  // 3. User hint from chatter
  if (userHint) {
    const journalHint = extractJournalHint(userHint);
    if (journalHint) {
      const hintLower = journalHint.toLowerCase().trim();
      const hintMatch = journals.find(
        (j) => String(j.name || "").toLowerCase().trim().includes(hintLower) ||
               hintLower.includes(String(j.name || "").toLowerCase().trim())
      );
      if (hintMatch) {
        logger?.info("bs-journal: matched by user hint.", { journalId: hintMatch.id, journalName: hintMatch.name, hint: journalHint });
        return { journal: hintMatch, error: null };
      }
    }
  }

  // 4. Bank name match from extracted data
  const bankName = String(extracted.bank_name || "").toLowerCase().trim();
  if (bankName) {
    const bankMatch = journals.find(
      (j) => {
        const jName = String(j.name || "").toLowerCase();
        return jName.includes(bankName) || bankName.includes(jName);
      }
    );
    if (bankMatch) {
      logger?.info("bs-journal: matched by bank name.", { journalId: bankMatch.id, journalName: bankMatch.name, bankName });
      return { journal: bankMatch, error: null };
    }
  }

  // 5. Single journal fallback
  if (journals.length === 1) {
    logger?.info("bs-journal: single journal fallback.", { journalId: journals[0].id, journalName: journals[0].name });
    return { journal: journals[0], error: null };
  }

  // 6. Error
  const journalList = journals.map((j) => `"${j.name}" (${j.bank_acc_number || "no account"})`).join(", ");
  return {
    journal: null,
    error: `Could not determine which Bank Journal to use. Extracted account number: "${extracted.account_number || "(none)"}". Available journals: ${journalList}. Please specify: @bot retry journal: <name>`
  };
}

/**
 * Extract a journal name from user hint text (e.g. "journal: BDO Checking").
 */
function extractJournalHint(hintText) {
  if (!hintText) return null;
  const match = String(hintText).match(/journal\s*[:=]\s*(.+?)(?:,|$)/i);
  return match ? match[1].trim() : null;
}

module.exports = {
  matchBankJournal,
  normalizeAccNumber,
  extractJournalHint
};
