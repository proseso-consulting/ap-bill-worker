// @ts-nocheck
const { safeJsonParse } = require("./utils");
const { geminiWithRetryAndFallback } = require("./gemini");

const bsExtractionSchema = {
  type: "object",
  properties: {
    bank_name: { type: "string", description: "Name of the bank (e.g. BDO, BPI, Metrobank, RCBC)" },
    account_number: { type: "string", description: "Full bank account number as printed on the statement" },
    account_name: { type: "string", description: "Account holder name as printed on the statement" },
    statement_date_from: { type: "string", description: "Start date of the statement period (YYYY-MM-DD)" },
    statement_date_to: { type: "string", description: "End date of the statement period (YYYY-MM-DD)" },
    opening_balance: { type: "number", description: "Opening/beginning balance for the period" },
    closing_balance: { type: "number", description: "Closing/ending balance for the period" },
    currency: { type: "string", description: "ISO 4217 currency code (e.g. PHP, USD, EUR)" },
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "Transaction date (YYYY-MM-DD)" },
          description: { type: "string", description: "Payee name or transaction description" },
          reference: { type: "string", description: "Check number, reference number, or transaction ID" },
          amount: { type: "number", description: "Transaction amount: POSITIVE for deposits/credits (money in), NEGATIVE for withdrawals/debits (money out)" },
          running_balance: { type: "number", description: "Running balance after this transaction (if shown)" }
        },
        required: ["date", "description", "reference", "amount"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: [
    "bank_name", "account_number", "statement_date_from", "statement_date_to",
    "opening_balance", "closing_balance", "currency", "transactions"
  ]
};

function buildBsPrompt(userHint) {
  return `Extract a bank statement into structured JSON matching the provided schema.

CRITICAL RULES:

SIGN CONVENTION (MOST IMPORTANT):
- Deposits / Credits / Money IN = POSITIVE amount
- Withdrawals / Debits / Money OUT = NEGATIVE amount
- Different banks use different formats:
  - Some show separate "Debit" and "Credit" columns — debit = negative, credit = positive
  - Some show a single "Amount" column with +/- signs
  - Some use "DR" / "CR" labels next to amounts — DR = negative, CR = positive
  - Some show withdrawals as positive in a "Withdrawals" column — convert to NEGATIVE
- ALWAYS normalize to: positive = deposit, negative = withdrawal

BALANCE VERIFICATION:
- opening_balance + sum(all transaction amounts) should equal closing_balance
- If the math does not work, recheck your sign convention — you may have the signs flipped
- The running_balance column (if present) is the strongest signal for correct signs

DATE FORMAT:
- All dates must be YYYY-MM-DD
- Philippine bank statements often use MM/DD/YYYY or DD/Mon/YYYY — convert them
- statement_date_from and statement_date_to define the period covered

ACCOUNT NUMBER:
- Extract the FULL account number exactly as printed
- Do NOT mask or redact digits (some statements show partial numbers — extract what is visible)

CURRENCY:
- Default to PHP if the statement is from a Philippine bank and no currency symbol is shown
- "$" with Philippine bank = PHP (peso sign), not USD
- Look for explicit currency codes or symbols

TRANSACTION EXTRACTION:
- Extract ALL transactions — do not skip any rows
- If a transaction spans multiple lines (e.g. description wraps), combine into one transaction
- Ignore summary rows, subtotals, "Total Debits", "Total Credits" rows — only extract individual transactions
- For check transactions, put the check number in the reference field

MULTI-PAGE HANDLING:
- If the document has multiple pages, extract transactions from ALL pages
- Watch for repeated headers on each page — skip those
- Transactions should be in chronological order

${userHint ? `\nUSER HINT (follow these instructions from the user):\n${userHint}\n` : ""}
Return JSON strictly matching the provided schema. All amounts must be numbers (not strings).`;
}

async function extractBankStatementWithGemini(config, attachment, userHint) {
  const parts = [{ text: buildBsPrompt(userHint || "") }];

  const mimetype = String(attachment?.mimetype || "").toLowerCase();
  const canInline = mimetype.startsWith("image/") || mimetype === "application/pdf";
  if (canInline && attachment?.datas) {
    parts.push({
      inlineData: { mimeType: mimetype, data: attachment.datas }
    });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: bsExtractionSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: true });
  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";

  const extracted = safeJsonParse(raw, {});
  if (!extracted || typeof extracted !== "object") return {};
  return extracted;
}

/**
 * Parse user hint text from chatter message to extract structured hints.
 * Returns cleaned hint string to inject into the Gemini prompt.
 */
function parseChatterHint(messageBody) {
  if (!messageBody) return "";
  let text = String(messageBody)
    .replace(/<[^>]+>/g, " ") // strip HTML tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

  // Remove the @worker command prefix
  text = text.replace(/@worker\s*(retry|run|reconcile|force)?\s*,?\s*/gi, "").trim();
  return text;
}

module.exports = {
  extractBankStatementWithGemini,
  parseChatterHint,
  bsExtractionSchema
};
