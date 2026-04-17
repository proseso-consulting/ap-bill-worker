/**
 * Filters to strip "example" / "terms" / illustrative numeric text from OCR so
 * that downstream amount candidates and maxOcr fallbacks don't lock onto
 * figures that only appear in withholding-tax notes, T&Cs, or example
 * calculations embedded in an otherwise-normal invoice.
 *
 * Motivated by Proseso invoice templates that include:
 *   "Example: Service Fee ₱100,000 + 12% VAT ₱12,000 - 2% EWT ₱2,000
 *    = Net Payable ₱110,000"
 * in the footer. Gemini was picking up ₱110,000 as the real grand total.
 */

const INLINE_EXAMPLE_KEYWORDS = [
  "example:",
  "example :",
  "e.g.",
  "e.g:",
  "for instance",
  "sample:",
  "illustration:",
  "net payable",
  "net pay:",
  "net payable:"
];

const SECTION_HEADERS = [
  "withholding tax note",
  "general terms and conditions",
  "general terms & conditions",
  "terms and conditions",
  "terms & conditions",
  "additional terms and conditions",
  "additional terms & conditions",
  "confidentiality",
  "limitations of scope",
  "client responsibilities",
  "selected services terms"
];

function isInExampleContext(text, position, windowChars = 80) {
  const s = String(text || "");
  if (!s || !Number.isInteger(position) || position < 0 || position >= s.length) return false;
  const from = Math.max(0, position - windowChars);
  const to = Math.min(s.length, position + windowChars);
  const slice = s.slice(from, to).toLowerCase();
  return INLINE_EXAMPLE_KEYWORDS.some((k) => slice.includes(k));
}

function stripExampleContext(text) {
  const s = String(text || "");
  if (!s) return "";

  // Step 1: drop any section starting at a known T&C / provisions header up to
  // the end of text (these sections live at the bottom of Proseso-style bills).
  let earliestHeaderIdx = s.length;
  for (const header of SECTION_HEADERS) {
    const re = new RegExp(`^\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im");
    const m = s.match(re);
    if (m && typeof m.index === "number" && m.index < earliestHeaderIdx) {
      earliestHeaderIdx = m.index;
    }
  }
  let cleaned = earliestHeaderIdx < s.length ? s.slice(0, earliestHeaderIdx) : s;

  // Step 2: remove inline sentences that begin with an example keyword. Each
  // such sentence is scrubbed from its keyword up to the next period or newline.
  for (const kw of INLINE_EXAMPLE_KEYWORDS) {
    const re = new RegExp(
      `${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.\\n]*(\\.|\\n|$)`,
      "gi"
    );
    cleaned = cleaned.replace(re, " ");
  }

  return cleaned;
}

module.exports = {
  isInExampleContext,
  stripExampleContext
};
