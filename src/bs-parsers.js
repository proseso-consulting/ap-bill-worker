// @ts-nocheck
const { parse } = require("csv-parse/sync");
const XLSX = require("xlsx");

/**
 * Detect file format from mimetype and filename, return "csv"|"excel"|"ofx"|"pdf"|"image"|null.
 */
function detectFormat(mimetype, filename) {
  const mime = String(mimetype || "").toLowerCase();
  const name = String(filename || "").toLowerCase();

  if (mime === "text/csv" || name.endsWith(".csv")) return "csv";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls")
  ) return "excel";
  if (
    mime === "application/x-ofx" ||
    mime === "application/vnd.intu.qfx" ||
    name.endsWith(".ofx") ||
    name.endsWith(".qfx") ||
    name.endsWith(".qbo")
  ) return "ofx";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  return null;
}

/**
 * Parse CSV bank statement. Expects columns roughly matching:
 * Date, Description/Payee, Reference, Debit, Credit, Balance (or Amount).
 * Returns { transactions: [{ date, description, reference, amount }], metadata: {} }
 */
function parseCsv(buffer) {
  const text = buffer.toString("utf-8");
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });
  if (!records.length) return { transactions: [], metadata: {} };

  const headers = Object.keys(records[0]).map((h) => h.toLowerCase().trim());
  const findCol = (...candidates) =>
    headers.find((h) => candidates.some((c) => h.includes(c))) || null;

  const dateCol = findCol("date", "posting date", "transaction date", "value date");
  const descCol = findCol("description", "payee", "narration", "particulars", "details", "memo");
  const refCol = findCol("reference", "ref", "cheque", "check");
  const amountCol = findCol("amount");
  const debitCol = findCol("debit", "withdrawal", "dr");
  const creditCol = findCol("credit", "deposit", "cr");
  const balCol = findCol("balance", "running balance", "closing balance");

  const getOrigKey = (lowerKey) => {
    if (!lowerKey) return null;
    return Object.keys(records[0]).find((k) => k.toLowerCase().trim() === lowerKey) || null;
  };

  const transactions = [];
  for (const row of records) {
    const get = (col) => {
      const key = getOrigKey(col);
      return key ? String(row[key] || "").trim() : "";
    };

    const dateStr = get(dateCol);
    if (!dateStr) continue;

    const desc = get(descCol);
    const ref = get(refCol);
    let amount = 0;

    if (amountCol) {
      amount = parseAmount(get(amountCol));
    } else if (debitCol || creditCol) {
      const debit = parseAmount(get(debitCol));
      const credit = parseAmount(get(creditCol));
      amount = credit - debit;
    }

    transactions.push({
      date: normalizeDate(dateStr),
      description: desc,
      reference: ref,
      amount
    });
  }

  return { transactions, metadata: {} };
}

/**
 * Parse Excel bank statement. Tries to find the header row and data rows automatically.
 */
function parseExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { transactions: [], metadata: {} };

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (rows.length < 2) return { transactions: [], metadata: {} };

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i].map((c) => String(c || "").toLowerCase());
    if (row.some((c) => c.includes("date")) && row.some((c) => c.includes("amount") || c.includes("debit") || c.includes("credit"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 0;

  const headers = rows[headerIdx].map((c) => String(c || "").toLowerCase().trim());
  const findCol = (...candidates) => {
    const idx = headers.findIndex((h) => candidates.some((c) => h.includes(c)));
    return idx >= 0 ? idx : -1;
  };

  const dateIdx = findCol("date", "posting date", "transaction date", "value date");
  const descIdx = findCol("description", "payee", "narration", "particulars", "details", "memo");
  const refIdx = findCol("reference", "ref", "cheque", "check");
  const amountIdx = findCol("amount");
  const debitIdx = findCol("debit", "withdrawal", "dr");
  const creditIdx = findCol("credit", "deposit", "cr");

  if (dateIdx < 0) return { transactions: [], metadata: {} };

  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const dateVal = row[dateIdx];
    if (!dateVal) continue;

    const desc = descIdx >= 0 ? String(row[descIdx] || "") : "";
    const ref = refIdx >= 0 ? String(row[refIdx] || "") : "";
    let amount = 0;

    if (amountIdx >= 0) {
      amount = parseAmount(row[amountIdx]);
    } else {
      const debit = debitIdx >= 0 ? parseAmount(row[debitIdx]) : 0;
      const credit = creditIdx >= 0 ? parseAmount(row[creditIdx]) : 0;
      amount = credit - debit;
    }

    const dateStr = dateVal instanceof Date
      ? dateVal.toISOString().slice(0, 10)
      : normalizeDate(String(dateVal));

    transactions.push({ date: dateStr, description: desc.trim(), reference: ref.trim(), amount });
  }

  return { transactions, metadata: {} };
}

/**
 * Parse OFX/QFX file. Uses simple regex extraction since ofx-js may not be reliable.
 */
function parseOfx(buffer) {
  const text = buffer.toString("utf-8");
  const transactions = [];

  const stmtTrnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match;
  while ((match = stmtTrnRegex.exec(text)) !== null) {
    const block = match[1];
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<\\n]+)`, "i"));
      return m ? m[1].trim() : "";
    };

    const trnType = getTag("TRNTYPE").toUpperCase();
    const datePosted = getTag("DTPOSTED");
    const amountStr = getTag("TRNAMT");
    const name = getTag("NAME") || getTag("MEMO");
    const fitId = getTag("FITID");
    const checkNum = getTag("CHECKNUM");

    const amount = parseFloat(amountStr) || 0;
    const date = datePosted
      ? `${datePosted.slice(0, 4)}-${datePosted.slice(4, 6)}-${datePosted.slice(6, 8)}`
      : "";

    transactions.push({
      date,
      description: name,
      reference: checkNum || fitId,
      amount
    });
  }

  const metadata = {};
  const acctIdMatch = text.match(/<ACCTID>([^<\n]+)/i);
  if (acctIdMatch) metadata.account_number = acctIdMatch[1].trim();
  const bankIdMatch = text.match(/<BANKID>([^<\n]+)/i);
  if (bankIdMatch) metadata.bank_id = bankIdMatch[1].trim();
  const curMatch = text.match(/<CURDEF>([^<\n]+)/i);
  if (curMatch) metadata.currency = curMatch[1].trim();
  const balMatch = text.match(/<BALAMT>([^<\n]+)/i);
  if (balMatch) metadata.closing_balance = parseFloat(balMatch[1]) || 0;

  return { transactions, metadata };
}

/**
 * Route to the correct parser based on format.
 */
function parseStructured(buffer, format) {
  switch (format) {
    case "csv": return parseCsv(buffer);
    case "excel": return parseExcel(buffer);
    case "ofx": return parseOfx(buffer);
    default: return null;
  }
}

function parseAmount(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/[^0-9.\-+]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDate(str) {
  if (!str) return "";
  const s = String(str).trim();

  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY or DD/MM/YYYY — assume MM/DD/YYYY (US), swap if month > 12
  const slashMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashMatch) {
    let [, a, b, y] = slashMatch;
    a = a.padStart(2, "0");
    b = b.padStart(2, "0");
    if (Number(a) > 12) return `${y}-${b}-${a}`;
    return `${y}-${a}-${b}`;
  }
  // DD Mon YYYY or Mon DD, YYYY
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

module.exports = {
  detectFormat,
  parseCsv,
  parseExcel,
  parseOfx,
  parseStructured,
  normalizeDate,
  parseAmount
};
