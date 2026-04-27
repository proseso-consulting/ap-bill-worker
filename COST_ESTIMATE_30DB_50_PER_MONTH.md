# Cost estimate (revised against real telemetry, 2026-04-27)

This document was rewritten after the 7-day GCP bill came in at **$200**, with $190 of that on Gemini API. The previous version's volume assumption (1,500 files/month) was ~19× too low; the per-file token math was directionally OK but missed Gemini 3 Pro's reasoning/thinking tokens which count as billed output.

## What we actually saw (last 7 days, billed)

| SKU | Service | Usage | Cost |
|---|---|---|---|
| Gemini 3 Pro short — output tokens | Gemini API | 13,530,817 | **$162.33** |
| Cloud Run CPU Tier 2 | Cloud Run | 2,397,243 sec | $42.72 |
| Gemini 3 Pro short — input tokens | Gemini API | 7,920,123 | $15.71 |
| Gemini 2.5 Pro short — output (fallback path) | Gemini API | 1,018,088 | $10.18 |
| Document Text Detection | Cloud Vision | 7,167 calls | $9.25 |
| Cloud SQL Postgres f1-micro | Cloud SQL | 1,244 hr | $8.05 |
| Gemini 3 Pro — cached input | Gemini API | 12.7M | $2.52 |
| Cloud Run min-instance, memory, secrets | (other) | — | ~$8 |
| **Total billed** | | | **~$200 / 7 days** |

Annualized projection at this rate: ~$10,400/year if nothing changes.

## What drove the bill

- **Volume:** 7,167 bills processed in 7 days ≈ ~28k/month — not the 1.5k/month the original doc assumed.
- **Per-file output tokens:** 13.5M / 7,167 ≈ 1,884 tokens/bill (close to the 1,500 estimate, slightly inflated by Gemini 3 Pro thinking tokens).
- **Per-file input tokens:** 7.9M / 7,167 ≈ 1,103 tokens/bill (the doc assumed 9,500 — 9× too high; PDFs are passed inline as binary not tokenized text).
- **Gemini 3 Pro pricing** at the time of measurement: ~$2/M input, ~$12/M output (the latter includes reasoning tokens). 2.5 Pro is ~$1.25/M input, ~$5/M output.
- **3 Gemini calls per bill on average:** extraction + account assignment + (sometimes) vendor research. Total invocations 13,137 / 7,167 ≈ 1.83 calls/bill.

## What changed (PR #38, merged 2026-04-27)

- Default model swapped: `gemini-3.1-pro-preview` → **`gemini-2.5-pro`** (primary), **`gemini-2.5-flash`** (fallback). Live and pinned in `cloudbuild.yaml`.
- `assignAccountsWithGemini` and `researchVendorWithGemini` route through `gemini-2.5-flash` (text-only, no Pro needed).
- `maxOutputTokens` caps: extraction 4096, assignment 3072, research 512, BS extraction 8192.
- `researchVendorWithGemini` skipped for vendors matched in Odoo (`vendor.created !== true`).

**Expected new run rate** at the same volume:
- Output tokens: extraction stays on 2.5 Pro (~$5/M output) ≈ $30-50; assignment + research move to Flash (~$0.30/M output) ≈ $1-2.
- Research calls drop ~60-80% (most vendors are repeats).
- Cached input: implicit Gemini caching should kick in more reliably on the static prompt prefix.

**Projected total: $40-70 / 7 days** (down from $200), ~$170-300/month at current volume.

## Cost drivers per file (post-PR-38)

| Call | Model | Input | Output | Per-call cost (PHP est.) |
|---|---|---|---|---|
| Extraction | gemini-2.5-pro | ~1,100 | ~1,500 | ~$0.0089 |
| Account assignment | gemini-2.5-flash | ~3,000 | ~500 | ~$0.0006 |
| Vendor research (only when new) | gemini-2.5-flash | ~500 | ~200 | ~$0.0002 |
| Vision OCR | DOC_TEXT | 1 unit (often) | — | ~$0.0015 |

Per-file cost ≈ **$0.011** (cents per bill). At 28k bills/month: **~$310/month** for Gemini + Vision. Add Cloud Run (~$170/mo at this concurrency) and SQL/secrets (~$30/mo) → **~$500/month** total at current scale.

## Scaling table (post-PR-38)

| Bills/month | Gemini + Vision (mid) | Cloud Run | Total |
|---|---|---|---|
| 5,000 | ~$55 | ~$30 | ~$90 |
| 15,000 | ~$165 | ~$90 | ~$260 |
| 30,000 | ~$330 | ~$180 | ~$520 |
| 60,000 | ~$660 | ~$360 | ~$1,040 |

Linear in bill count. Concurrency does not change API volume.

## Remaining cost levers (not yet implemented)

1. **Explicit `cachedContent` for the 288-line extraction prompt** — implicit caching only captured ~$2.50 of $16 cached-input opportunity. Explicit caching can lock in 75% off the cached input portion. Estimated savings: ~$10-15/week. Lift: medium (TTL renewal, lifecycle management).
2. **Gemini Batch API** for non-real-time webhooks — 50% discount, but requires async workflow change.
3. **PDF page cap tightening** — `PDF_OCR_MAX_PAGES=80` is generous; reducing to 20 would cut Vision cost on outlier docs. Negligible at current Vision spend ($9/wk).
4. **Bank statement worker** has no current volume; if it ramps, mirror the bill-side optimizations.

## What this doc got wrong before

| | Old doc | Actual |
|---|---|---|
| Bills/month assumed | 1,500 | ~28,000 |
| Per-file input tokens | 9,500 | 1,103 |
| Total monthly Gemini | $55-60 | ~$760 |
| Reduction action #1 | "switch to gemini-2.5-pro" | done in PR #38 |

Pricing references: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Cloud Vision pricing](https://cloud.google.com/vision/pricing).
