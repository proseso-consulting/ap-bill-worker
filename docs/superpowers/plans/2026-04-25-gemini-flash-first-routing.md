# Gemini Flash-First Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Gemini Pro RPM pressure by ~5× by routing invoice extraction to Gemini Flash by default and escalating to Pro only when Flash output is missing required fields or below a confidence threshold.

**Architecture:** Add a thin `extractWithEscalation` helper that wraps the existing `geminiRequest` HTTP call. Flash is called first; on missing schema fields or low confidence, the same body is replayed against Pro and the better result is returned. On Flash 429 (quota), the helper does NOT escalate (would just shift quota pressure) — it throws a quota error so the upstream (`taskHandler.classifyError` after the queue lands, or the existing retry loop today) can handle it. Other Gemini callers (`assignAccountsWithGemini`, `researchVendorWithGemini`) are not touched — they keep using `geminiWithRetryAndFallback` with Pro as primary.

**Tech Stack:** Node.js 20, Vitest (existing test framework, ESM `.mjs` files), CommonJS source files (`require`/`module.exports`), no new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md` §5.6, §7.1, §8 Phase 0.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/config.js` | Modify | Add three new keys under `config.gemini`: `extractionPrimary`, `extractionFallback`, `escalateConfidenceThreshold` |
| `src/gemini.js` | Modify | Add `parseExtraction`, `shouldEscalateToPro`, `extractWithEscalation` functions; refactor `extractInvoiceWithGemini` to use them |
| `tests/geminiRouting.test.mjs` | Create | Vitest tests covering all escalation triggers and the no-escalation path |

No new files in `src/`. The new functions live alongside the existing extraction code in `gemini.js` because they are tightly coupled to its body-building and parsing logic. Splitting into a separate module would add indirection without isolation benefit.

The three new functions in `gemini.js`:

- `parseExtraction(rawText): object` — pure. Parses Gemini's nested JSON response (the outer envelope wrapping the inner JSON string the model produces). Returns `{}` on any parse failure.
- `shouldEscalateToPro(extracted, threshold): string | null` — pure. Returns an escalation reason string (`"missing_vendor_name"`, `"low_vendor_confidence"`, etc.) or `null` if the Flash output is good enough.
- `extractWithEscalation(body, config, callFn): {text, model, escalated, escalationReason?}` — orchestrator. Calls Flash, decides escalation, returns the chosen result. Takes the network call function as a parameter so it's testable without mocking the whole module.

---

## Task 0.1: Add Flash-routing config keys

**Files:**
- Modify: `src/config.js:61-67`

- [ ] **Step 1: Open `src/config.js` and locate the `gemini` block (lines 61-67)**

The current block:

```js
gemini: {
  apiKey: process.env.GEMINI_API_KEY || "",
  model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
  fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-pro",
  visionFirst: process.env.GEMINI_VISION_FIRST !== "false",
  skipVision: process.env.SKIP_VISION_OCR === "true"
},
```

- [ ] **Step 2: Add three new keys to the `gemini` block**

Replace the `gemini` block with:

```js
gemini: {
  apiKey: process.env.GEMINI_API_KEY || "",
  model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
  fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-pro",
  extractionPrimary: process.env.GEMINI_EXTRACTION_PRIMARY || "gemini-2.5-flash",
  extractionFallback: process.env.GEMINI_EXTRACTION_FALLBACK || "gemini-3-pro-preview",
  escalateConfidenceThreshold: toFloat(process.env.GEMINI_ESCALATE_CONFIDENCE_THRESHOLD, 0.7),
  visionFirst: process.env.GEMINI_VISION_FIRST !== "false",
  skipVision: process.env.SKIP_VISION_OCR === "true"
},
```

The existing `model` and `fallbackModel` keys stay unchanged so `assignAccountsWithGemini` and `researchVendorWithGemini` keep using Pro. The new `extractionPrimary` and `extractionFallback` are extraction-specific.

- [ ] **Step 3: Verify config still loads**

Run: `node --check src/config.js && node -e "console.log(require('./src/config').config.gemini)"`

Expected output includes the three new keys with their default values:

```
{
  apiKey: '...',
  model: 'gemini-3-pro-preview',
  fallbackModel: 'gemini-2.5-pro',
  extractionPrimary: 'gemini-2.5-flash',
  extractionFallback: 'gemini-3-pro-preview',
  escalateConfidenceThreshold: 0.7,
  ...
}
```

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "feat: add Gemini extraction routing config keys"
```

---

## Task 0.2: Implement `parseExtraction` and `shouldEscalateToPro` helpers (with tests)

**Files:**
- Create: `tests/geminiRouting.test.mjs`
- Modify: `src/gemini.js` (add two new functions, export them)

- [ ] **Step 1: Write the failing test**

Create `tests/geminiRouting.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { parseExtraction, shouldEscalateToPro } from "../src/gemini.js";

describe("parseExtraction", () => {
  it("extracts the inner JSON from Gemini's envelope", () => {
    const raw = JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: '{"vendor":{"name":"Acme","confidence":0.95}}' }]
        }
      }]
    });
    const result = parseExtraction(raw);
    expect(result.vendor.name).toBe("Acme");
    expect(result.vendor.confidence).toBe(0.95);
  });

  it("joins multi-part responses", () => {
    const raw = JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: '{"vendor":' },
            { text: '{"name":"Acme"}}' }
          ]
        }
      }]
    });
    const result = parseExtraction(raw);
    expect(result.vendor.name).toBe("Acme");
  });

  it("returns {} on malformed envelope", () => {
    expect(parseExtraction("not json")).toEqual({});
    expect(parseExtraction(JSON.stringify({ candidates: [] }))).toEqual({});
    expect(parseExtraction(JSON.stringify({}))).toEqual({});
  });

  it("returns {} on malformed inner JSON", () => {
    const raw = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "not json" }] } }]
    });
    expect(parseExtraction(raw)).toEqual({});
  });
});

describe("shouldEscalateToPro", () => {
  const THRESHOLD = 0.7;

  it("returns null for a complete, high-confidence extraction", () => {
    const extracted = {
      vendor: { name: "Acme Corp", confidence: 0.95 },
      invoice: { grand_total: 12345 }
    };
    expect(shouldEscalateToPro(extracted, THRESHOLD)).toBeNull();
  });

  it("escalates when extraction is empty", () => {
    expect(shouldEscalateToPro({}, THRESHOLD)).toBe("no_extraction");
    expect(shouldEscalateToPro(null, THRESHOLD)).toBe("no_extraction");
    expect(shouldEscalateToPro(undefined, THRESHOLD)).toBe("no_extraction");
  });

  it("escalates when vendor name is missing", () => {
    const extracted = {
      vendor: { name: "", confidence: 0.95 },
      invoice: { grand_total: 12345 }
    };
    expect(shouldEscalateToPro(extracted, THRESHOLD)).toBe("missing_vendor_name");
  });

  it("escalates when grand_total is missing or zero", () => {
    expect(shouldEscalateToPro({
      vendor: { name: "Acme", confidence: 0.95 },
      invoice: { grand_total: 0 }
    }, THRESHOLD)).toBe("missing_grand_total");

    expect(shouldEscalateToPro({
      vendor: { name: "Acme", confidence: 0.95 },
      invoice: {}
    }, THRESHOLD)).toBe("missing_grand_total");
  });

  it("escalates when vendor confidence is below threshold", () => {
    const extracted = {
      vendor: { name: "Acme", confidence: 0.5 },
      invoice: { grand_total: 12345 }
    };
    expect(shouldEscalateToPro(extracted, THRESHOLD)).toBe("low_vendor_confidence");
  });

  it("does not escalate when confidence is missing (treated as present)", () => {
    const extracted = {
      vendor: { name: "Acme" },
      invoice: { grand_total: 12345 }
    };
    expect(shouldEscalateToPro(extracted, THRESHOLD)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/geminiRouting.test.mjs`

Expected: failures on import — `parseExtraction` and `shouldEscalateToPro` are not exported from `../src/gemini.js`.

- [ ] **Step 3: Implement the two helpers**

In `src/gemini.js`, add the following functions immediately before the `extractInvoiceWithGemini` function (around line 540, after the `extractionSchema` and prompt-building helpers):

```js
function parseExtraction(rawText) {
  const data = safeJsonParse(rawText, {});
  const inner =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";
  const extracted = safeJsonParse(inner, {});
  if (!extracted || typeof extracted !== "object") return {};
  return extracted;
}

function shouldEscalateToPro(extracted, threshold) {
  if (!extracted || typeof extracted !== "object" || !Object.keys(extracted).length) {
    return "no_extraction";
  }
  if (!extracted.vendor?.name) return "missing_vendor_name";
  if (!extracted.invoice?.grand_total) return "missing_grand_total";
  if (
    extracted.vendor?.confidence != null &&
    extracted.vendor.confidence < threshold
  ) {
    return "low_vendor_confidence";
  }
  return null;
}
```

Then add `parseExtraction` and `shouldEscalateToPro` to the `module.exports` object at the bottom of `src/gemini.js`. Locate the existing `module.exports = { extractInvoiceWithGemini, ... }` block (around line 848) and add the two new names:

```js
module.exports = {
  extractInvoiceWithGemini,
  assignAccountsWithGemini,
  researchVendorWithGemini,
  parseExtraction,
  shouldEscalateToPro,
};
```

(Adjust to match the existing exports — only add the two new names; do not remove anything.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/geminiRouting.test.mjs`

Expected: 11 tests pass (4 in `parseExtraction` describe block, 7 in `shouldEscalateToPro`).

- [ ] **Step 5: Run full suite to verify nothing else broke**

Run: `npm test`

Expected: 89 + 11 = 100 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/gemini.js tests/geminiRouting.test.mjs
git commit -m "feat: add parseExtraction and shouldEscalateToPro helpers"
```

---

## Task 0.3: Implement `extractWithEscalation` orchestrator (with tests)

**Files:**
- Modify: `tests/geminiRouting.test.mjs` (append tests)
- Modify: `src/gemini.js` (add `extractWithEscalation` function, export it)

- [ ] **Step 1: Update top imports and append failing tests for `extractWithEscalation`**

First, update the top of `tests/geminiRouting.test.mjs` so the existing imports become:

```js
import { describe, it, expect, vi } from "vitest";
import {
  parseExtraction,
  shouldEscalateToPro,
  extractWithEscalation,
} from "../src/gemini.js";
```

Then append the new `describe` block at the bottom of the file (after the existing two `describe` blocks):

```js
describe("extractWithEscalation", () => {
  const config = {
    gemini: {
      apiKey: "fake-key",
      extractionPrimary: "gemini-2.5-flash",
      extractionFallback: "gemini-3-pro-preview",
      escalateConfidenceThreshold: 0.7,
    }
  };

  // Helper: build a Gemini-shaped envelope around an inner extraction object
  const envelope = (inner) => JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(inner) }] } }]
  });

  it("returns Flash result when Flash output is good", async () => {
    const flashOutput = envelope({
      vendor: { name: "Acme", confidence: 0.95 },
      invoice: { grand_total: 100 }
    });
    const callFn = vi.fn().mockResolvedValue(flashOutput);

    const result = await extractWithEscalation({}, config, callFn);

    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.escalated).toBe(false);
    expect(result.text).toBe(flashOutput);
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(callFn).toHaveBeenCalledWith("gemini-2.5-flash", {}, config);
  });

  it("escalates to Pro when Flash returns missing vendor name", async () => {
    const flashOutput = envelope({
      vendor: { name: "", confidence: 0.95 },
      invoice: { grand_total: 100 }
    });
    const proOutput = envelope({
      vendor: { name: "Acme", confidence: 0.99 },
      invoice: { grand_total: 100 }
    });
    const callFn = vi.fn()
      .mockResolvedValueOnce(flashOutput)
      .mockResolvedValueOnce(proOutput);

    const result = await extractWithEscalation({}, config, callFn);

    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe("missing_vendor_name");
    expect(result.text).toBe(proOutput);
    expect(callFn).toHaveBeenCalledTimes(2);
    expect(callFn).toHaveBeenNthCalledWith(2, "gemini-3-pro-preview", {}, config);
  });

  it("escalates to Pro when Flash returns low confidence", async () => {
    const flashOutput = envelope({
      vendor: { name: "Acme", confidence: 0.5 },
      invoice: { grand_total: 100 }
    });
    const proOutput = envelope({
      vendor: { name: "Acme", confidence: 0.95 },
      invoice: { grand_total: 100 }
    });
    const callFn = vi.fn()
      .mockResolvedValueOnce(flashOutput)
      .mockResolvedValueOnce(proOutput);

    const result = await extractWithEscalation({}, config, callFn);

    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe("low_vendor_confidence");
  });

  it("does NOT escalate on Flash 429 — throws quota error", async () => {
    const err = new Error("Gemini gemini-2.5-flash HTTP 429: quota exceeded");
    err.status = 429;
    const callFn = vi.fn().mockRejectedValue(err);

    await expect(extractWithEscalation({}, config, callFn)).rejects.toThrow(/429|quota/i);
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(callFn).toHaveBeenCalledWith("gemini-2.5-flash", {}, config);
  });

  it("escalates to Pro when Flash throws a non-429 error", async () => {
    const err = new Error("Gemini gemini-2.5-flash HTTP 500: internal");
    err.status = 500;
    const proOutput = envelope({
      vendor: { name: "Acme", confidence: 0.95 },
      invoice: { grand_total: 100 }
    });
    const callFn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(proOutput);

    const result = await extractWithEscalation({}, config, callFn);

    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe("flash_error");
    expect(callFn).toHaveBeenCalledTimes(2);
  });

  it("propagates Pro errors when escalation also fails", async () => {
    const flashErr = new Error("Flash 500");
    flashErr.status = 500;
    const proErr = new Error("Pro 500");
    proErr.status = 500;
    const callFn = vi.fn()
      .mockRejectedValueOnce(flashErr)
      .mockRejectedValueOnce(proErr);

    await expect(extractWithEscalation({}, config, callFn)).rejects.toThrow(/Pro 500/);
  });
});
```

(The top-of-file imports were already updated to include `vi` and `extractWithEscalation` in the snippet above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/geminiRouting.test.mjs`

Expected: 6 new tests fail with "extractWithEscalation is not a function" or similar import error. The earlier 11 tests still pass.

- [ ] **Step 3: Implement `extractWithEscalation` and a thin `callGeminiForExtraction` wrapper**

In `src/gemini.js`, add the following two functions immediately after `shouldEscalateToPro`:

```js
async function callGeminiForExtraction(model, body, config) {
  const { resp, text } = await geminiRequest(model, config.gemini.apiKey, body);
  if (!resp.ok) {
    const err = new Error(`Gemini ${model} HTTP ${resp.status}: ${text.slice(0, 600)}`);
    err.status = resp.status;
    throw err;
  }
  return text;
}

async function extractWithEscalation(body, config, callFn = callGeminiForExtraction) {
  const primary = config.gemini.extractionPrimary;
  const fallback = config.gemini.extractionFallback;
  const threshold = config.gemini.escalateConfidenceThreshold;

  // Try primary (Flash by default)
  let primaryText;
  try {
    primaryText = await callFn(primary, body, config);
  } catch (err) {
    if (err?.status === 429) {
      // Flash quota exceeded — DO NOT escalate (would just shift quota pressure).
      // Throw so the upstream retry/queue layer can back off.
      throw err;
    }
    // Non-quota error — escalate to fallback (Pro)
    const fallbackText = await callFn(fallback, body, config);
    return {
      text: fallbackText,
      model: fallback,
      escalated: true,
      escalationReason: "flash_error",
    };
  }

  // Parse primary result, decide whether to escalate
  const parsed = parseExtraction(primaryText);
  const escalationReason = shouldEscalateToPro(parsed, threshold);
  if (!escalationReason) {
    return { text: primaryText, model: primary, escalated: false };
  }

  const fallbackText = await callFn(fallback, body, config);
  return {
    text: fallbackText,
    model: fallback,
    escalated: true,
    escalationReason,
  };
}
```

Add `extractWithEscalation` and `callGeminiForExtraction` to the `module.exports` block (only `extractWithEscalation` is needed publicly; `callGeminiForExtraction` is exported only for testability if desired, but the orchestrator's tests inject `callFn` directly so this is optional).

```js
module.exports = {
  extractInvoiceWithGemini,
  assignAccountsWithGemini,
  researchVendorWithGemini,
  parseExtraction,
  shouldEscalateToPro,
  extractWithEscalation,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/geminiRouting.test.mjs`

Expected: 17 tests pass (4 + 7 + 6).

- [ ] **Step 5: Run full suite**

Run: `npm test`

Expected: 89 + 17 = 106 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/gemini.js tests/geminiRouting.test.mjs
git commit -m "feat: add extractWithEscalation orchestrator with Flash-first routing"
```

---

## Task 0.4: Wire `extractWithEscalation` into `extractInvoiceWithGemini`

**Files:**
- Modify: `src/gemini.js:542-575` (the existing `extractInvoiceWithGemini` function)

This is the production cutover. After this task, real traffic uses Flash-first routing.

- [ ] **Step 1: Read the current `extractInvoiceWithGemini`**

Open `src/gemini.js`, locate lines 542-575. Confirm the body shape:

```js
async function extractInvoiceWithGemini(config, attachment, userHint = "", ocrText = "") {
  let promptText = buildPrompt(ocrText);
  if (userHint) {
    promptText += `\n\nUSER HINT (CRITICAL - prioritize this info):\n${userHint}`;
  }
  const parts = [{ text: promptText }];

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
      responseSchema: extractionSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: true });
  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";

  const extracted = safeJsonParse(raw, {});
  if (!extracted || typeof extracted !== "object") return { data: {}, model: result.model };
  return { data: extracted, model: result.model };
}
```

- [ ] **Step 2: Replace the function body to use `extractWithEscalation`**

Replace lines 542-575 with:

```js
async function extractInvoiceWithGemini(config, attachment, userHint = "", ocrText = "") {
  let promptText = buildPrompt(ocrText);
  if (userHint) {
    promptText += `\n\nUSER HINT (CRITICAL - prioritize this info):\n${userHint}`;
  }
  const parts = [{ text: promptText }];

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
      responseSchema: extractionSchema
    }
  };

  const result = await extractWithEscalation(body, config);
  const extracted = parseExtraction(result.text);

  // Structured log entry: tracks escalation rate over time.
  // If escalation rate > 40% in production, the threshold is too aggressive
  // OR Flash isn't pulling its weight — both worth investigating.
  // (logger is not in scope here; the calling worker logs `model` already.)

  return {
    data: extracted,
    model: result.model,
    escalated: result.escalated,
    escalationReason: result.escalationReason || null,
  };
}
```

The return shape is **backward-compatible**: existing callers destructure `{ data, model }` and won't break. The new `escalated` and `escalationReason` are additive — callers can opt into using them.

- [ ] **Step 3: Run full suite**

Run: `npm test`

Expected: 106 tests pass. The existing tests for `worker.js` and `createVendorIfMissing` don't exercise `extractInvoiceWithGemini` directly (they mock the Odoo client, not Gemini), so there should be no test changes needed.

- [ ] **Step 4: Verify the change with `node --check`**

Run: `node --check src/gemini.js && echo OK`

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add src/gemini.js
git commit -m "feat: wire Flash-first extraction into extractInvoiceWithGemini"
```

---

## Task 0.5: Surface escalation in worker logs

**Files:**
- Modify: `src/worker.js` (one log line near the existing Gemini result handling)

The escalation rate is the metric we'll watch in production to tune the confidence threshold. The worker already logs `geminiModel` somewhere; we add `escalated` and `escalationReason` to the same line.

- [ ] **Step 1: Locate the existing Gemini-result logging**

Run: `grep -n "geminiModel\|extractInvoiceWithGemini" /mnt/windows/Users/Admin/Project/Odoo-AP-Worker/src/worker.js | head -10`

Expected output includes at least one assignment like:

```
({ data: extracted, model: geminiModel } = geminiResult.value);
```

(around line 2627 based on prior session context).

- [ ] **Step 2: Update the destructure to capture escalation fields**

Find this pattern (there are two occurrences — one in the Vision-first concurrent branch, one in the legacy sequential branch):

```js
({ data: extracted, model: geminiModel } = geminiResult.value);
```

and

```js
({ data: extracted, model: geminiModel } = await extractInvoiceWithGemini(config, att, userHint, ocrText));
```

Replace both with versions that capture the new fields:

```js
({ data: extracted, model: geminiModel, escalated: geminiEscalated, escalationReason: geminiEscalationReason } = geminiResult.value);
```

and

```js
({ data: extracted, model: geminiModel, escalated: geminiEscalated, escalationReason: geminiEscalationReason } = await extractInvoiceWithGemini(config, att, userHint, ocrText));
```

- [ ] **Step 3: Add a log line after extraction**

Find the next `logger.info` or similar call after the destructure (where the extraction is reported). Add or extend a log entry to include the new fields. Look for an existing call like:

```js
logger.info("Gemini extraction complete.", { docId: doc.id, model: geminiModel, ... });
```

If one exists, add `escalated: !!geminiEscalated, escalationReason: geminiEscalationReason || null` to the meta. If no such log line exists, add one immediately after extraction:

```js
logger.info("Gemini extraction complete.", {
  docId: doc.id,
  model: geminiModel,
  escalated: !!geminiEscalated,
  escalationReason: geminiEscalationReason || null,
});
```

- [ ] **Step 4: Run full suite**

Run: `npm test`

Expected: 106 tests pass.

- [ ] **Step 5: Run syntax check**

Run: `node --check src/worker.js && echo OK`

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/worker.js
git commit -m "feat: surface Gemini escalation in worker logs"
```

---

## Task 0.6: Smoke test against real Gemini API

This task is non-TDD — it verifies the change works end-to-end against the actual Gemini API. It requires a valid `GEMINI_API_KEY` and a small test PDF.

**Files:** none modified.

- [ ] **Step 1: Set up a smoke-test environment**

Ensure `.env` has a valid `GEMINI_API_KEY`. Make a small test PDF available at `/tmp/test-bill.pdf` (any clean invoice PDF works).

- [ ] **Step 2: Write a one-shot Node script**

Create `/tmp/test-extraction.js`:

```js
const { config } = require("/mnt/windows/Users/Admin/Project/Odoo-AP-Worker/src/config");
const { extractInvoiceWithGemini } = require("/mnt/windows/Users/Admin/Project/Odoo-AP-Worker/src/gemini");
const fs = require("fs");

(async () => {
  const datas = fs.readFileSync("/tmp/test-bill.pdf").toString("base64");
  const attachment = { mimetype: "application/pdf", datas };
  const start = Date.now();
  const result = await extractInvoiceWithGemini(config, attachment, "", "");
  const elapsed = Date.now() - start;
  console.log(JSON.stringify({
    elapsed_ms: elapsed,
    model: result.model,
    escalated: result.escalated,
    escalationReason: result.escalationReason,
    vendor: result.data.vendor,
    invoice_total: result.data.invoice?.grand_total,
  }, null, 2));
})();
```

- [ ] **Step 3: Run the script**

Run: `node /tmp/test-extraction.js`

Expected output (approximate):

```json
{
  "elapsed_ms": 8000,    // Flash is faster; if escalated, ~15-20s
  "model": "gemini-2.5-flash",
  "escalated": false,
  "escalationReason": null,
  "vendor": { "name": "...", "confidence": 0.9+, "source": "..." },
  "invoice_total": 12345
}
```

Verify:
- `model` is `gemini-2.5-flash` for a clean invoice (no escalation expected)
- `escalated: false`
- `vendor.confidence` is at or above 0.7 (the threshold)
- Extraction quality is comparable to the previous Pro-only output

If a clean invoice escalates, the threshold may be too high — note the actual confidence value. If extraction is materially worse with Flash, that's a finding worth flagging.

- [ ] **Step 4: Document the smoke-test result in the commit**

No code commit for this task (it's pure verification). Note the smoke-test result (Flash time, escalation outcome) in the eventual PR description.

---

## Task 0.7: PR + deploy

**Files:** none modified.

- [ ] **Step 1: Verify branch state**

Run: `git status && git log --oneline origin/master..HEAD`

Expected: 4-5 commits ahead of master (one per feature task: config, helpers, orchestrator, wire-up, log-surface).

- [ ] **Step 2: Push branch**

Run: `git push -u origin $(git rev-parse --abbrev-ref HEAD)`

Expected: pushed cleanly.

- [ ] **Step 3: Create PR**

Run:

```bash
gh pr create --title "feat: Gemini Flash-first routing for invoice extraction" --base master --body "$(cat <<'EOF'
## Summary

Routes invoice extraction to Gemini Flash by default, escalating to Gemini Pro only when Flash output is missing required fields or confidence is below 0.7. Reduces Pro RPM pressure by ~5× on aggregate.

Spec: \`docs/superpowers/specs/2026-04-25-cloud-tasks-queue-design.md\` §5.6, Phase 0 of the rollout.

## Architecture

- Three new functions in \`src/gemini.js\`: \`parseExtraction\`, \`shouldEscalateToPro\`, \`extractWithEscalation\`
- New config keys: \`GEMINI_EXTRACTION_PRIMARY\` (default \`gemini-2.5-flash\`), \`GEMINI_EXTRACTION_FALLBACK\` (default \`gemini-3-pro-preview\`), \`GEMINI_ESCALATE_CONFIDENCE_THRESHOLD\` (default 0.7)
- \`extractInvoiceWithGemini\` now delegates Gemini calls through \`extractWithEscalation\` instead of \`geminiWithRetryAndFallback\`
- Other Gemini callers (\`assignAccountsWithGemini\`, \`researchVendorWithGemini\`) are unchanged — they keep using Pro

## Escalation rules

| Trigger | Action |
|---|---|
| Flash returns full schema with confidence ≥ 0.7 | Use Flash result, no escalation |
| Flash returns missing \`vendor.name\` | Escalate to Pro |
| Flash returns missing/zero \`invoice.grand_total\` | Escalate to Pro |
| Flash returns \`vendor.confidence < 0.7\` | Escalate to Pro |
| Flash returns 429 (quota) | **Do NOT escalate** — throw quota error so upstream backs off |
| Flash returns other 4xx/5xx | Escalate to Pro |

## Test plan

- [x] 17 new unit tests in \`tests/geminiRouting.test.mjs\` covering all paths
- [x] Full suite passes (\`npm test\`): 106 tests
- [x] Smoke test against real Gemini API with a sample invoice — verify Flash handles clean bills without escalation
- [ ] Monitor escalation rate in Cloud Run logs after deploy; expected < 30% on real traffic

## Rollback

Set \`GEMINI_EXTRACTION_PRIMARY=gemini-3-pro-preview\` in Cloud Run env vars and redeploy. No code changes needed.
EOF
)"
```

- [ ] **Step 4: Trigger PR check**

If the PR check shows `ACTION_REQUIRED`:

```bash
gh pr comment <PR_NUMBER> --body "/gcbrun"
```

- [ ] **Step 5: Wait for PR check, merge, deploy**

After PR check turns green:

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

Cloud Build deploy trigger fires automatically. Verify deploy:

```bash
gcloud run revisions list --service ap-bill-ocr-worker --region asia-southeast1 --project odoo-ocr-487104 --limit 1
```

Expected: new revision active, 100% traffic.

- [ ] **Step 6: Watch escalation rate**

After deploy, monitor for 24 hours:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="ap-bill-ocr-worker" AND jsonPayload.message="Gemini extraction complete."' --project odoo-ocr-487104 --limit 100 --order desc --format json | python3 -c "
import json, sys
entries = json.load(sys.stdin)
total = len(entries)
escalated = sum(1 for e in entries if e.get('jsonPayload',{}).get('meta',{}).get('escalated'))
reasons = {}
for e in entries:
    r = e.get('jsonPayload',{}).get('meta',{}).get('escalationReason')
    if r: reasons[r] = reasons.get(r, 0) + 1
print(f'Total extractions: {total}')
print(f'Escalated: {escalated} ({100*escalated/total:.1f}%)' if total else 'No data')
print(f'Reasons: {reasons}')
"
```

Target: escalation rate < 30%. If higher, the confidence threshold may be too aggressive — tune via env var without redeploy.

---

## Self-review checklist (before handoff)

After completing all tasks:

- [ ] All 106 tests pass (`npm test`)
- [ ] `node --check` clean on `src/gemini.js`, `src/config.js`, `src/worker.js`
- [ ] Smoke test against real Gemini API succeeded
- [ ] PR description includes spec reference and rollback procedure
- [ ] Cloud Run revision shows 100% traffic on new revision
- [ ] Escalation rate < 30% within 24 hours of deploy

If escalation rate is > 40%, consider:
1. Raising the threshold to 0.6 (set `GEMINI_ESCALATE_CONFIDENCE_THRESHOLD=0.6` env var)
2. Investigating which docs are escalating — Cloud Run logs include `escalationReason`
3. Reverting via env var until the issue is understood
