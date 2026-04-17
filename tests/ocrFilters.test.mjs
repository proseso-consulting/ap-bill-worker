import { describe, it, expect } from "vitest";
import { stripExampleContext, isInExampleContext } from "../src/ocrFilters.js";

describe("isInExampleContext", () => {
  it("flags amounts near 'Example:'", () => {
    const text = "Example: Service Fee (exclusive of VAT) ₱100,000 + 12% VAT ₱12,000 - 2% EWT ₱2,000 = Net Payable ₱110,000";
    const pos = text.indexOf("110,000");
    expect(isInExampleContext(text, pos)).toBe(true);
  });

  it("flags amounts near 'e.g.'", () => {
    const text = "Fees vary (e.g. ₱15,000 per month for small clients)";
    const pos = text.indexOf("15,000");
    expect(isInExampleContext(text, pos)).toBe(true);
  });

  it("flags amounts inside 'Withholding Tax Note' section", () => {
    const text = "Withholding Tax Note\n- Payments are subject to 2% EWT\n- Sample: ₱100,000 base + ₱12,000 VAT";
    const pos = text.indexOf("12,000");
    expect(isInExampleContext(text, pos)).toBe(true);
  });

  it("flags amounts labeled 'Net Payable' or 'Net Pay'", () => {
    const text = "Quick ref: Net Payable ₱110,000 (illustration)";
    const pos = text.indexOf("110,000");
    expect(isInExampleContext(text, pos)).toBe(true);
  });

  it("does NOT flag amounts in normal invoice lines", () => {
    const text = "Invoice INVPH/2026/00119\n\nAmount 12,000.00\nTotal 13,440.00";
    const pos = text.indexOf("13,440");
    expect(isInExampleContext(text, pos)).toBe(false);
  });

  it("does NOT flag 'VATable' (it's a normal invoice label)", () => {
    const text = "Untaxed Amount 12,000.00\nVATable: 1,440.00\nTotal 13,440.00";
    const pos = text.indexOf("1,440");
    expect(isInExampleContext(text, pos)).toBe(false);
  });

  it("handles position at start of text", () => {
    const text = "₱100,000 base";
    expect(isInExampleContext(text, 0)).toBe(false);
  });

  it("handles position past end of text", () => {
    expect(isInExampleContext("short", 999)).toBe(false);
  });

  it("handles null / empty text", () => {
    expect(isInExampleContext("", 0)).toBe(false);
    expect(isInExampleContext(null, 0)).toBe(false);
  });
});

describe("stripExampleContext", () => {
  it("removes the Withholding Tax Note section wholesale", () => {
    const text = `Invoice INVPH/2026/00119
Amount 12,000.00
Total 13,440.00

Withholding Tax Note
- Payments are subject to 2% EWT
- Example: ₱100,000 + ₱12,000 VAT - ₱2,000 EWT = Net Payable ₱110,000

General Terms and Conditions
Lorem ipsum...`;
    const cleaned = stripExampleContext(text);
    expect(cleaned).toContain("Invoice INVPH/2026/00119");
    expect(cleaned).toContain("13,440");
    expect(cleaned).not.toContain("110,000");
    expect(cleaned).not.toContain("Example:");
  });

  it("removes 'General Terms and Conditions' section", () => {
    const text = "Invoice\nAmount 5,000\n\nGeneral Terms and Conditions\nA fee of ₱99,999 applies if...";
    const cleaned = stripExampleContext(text);
    expect(cleaned).toContain("5,000");
    expect(cleaned).not.toContain("99,999");
  });

  it("removes inline 'Example:' sentences", () => {
    const text = "Total: 13,440. Example: Service Fee ₱100,000 leads to Net Payable ₱110,000. End.";
    const cleaned = stripExampleContext(text);
    expect(cleaned).toContain("13,440");
    expect(cleaned).not.toContain("110,000");
    expect(cleaned).not.toContain("100,000");
  });

  it("preserves original text when no example context present", () => {
    const text = "Invoice\nAmount 12,000\nVAT 1,440\nTotal 13,440";
    expect(stripExampleContext(text)).toBe(text);
  });

  it("handles empty / null input", () => {
    expect(stripExampleContext("")).toBe("");
    expect(stripExampleContext(null)).toBe("");
  });
});
