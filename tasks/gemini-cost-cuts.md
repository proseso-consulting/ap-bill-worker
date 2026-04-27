# Gemini Cost Cuts

## Why

Last 7 days: $190 of $200 GCP bill is Gemini API. Primary model `gemini-3.1-pro-preview` is producing 13.5M output tokens at ~$12/M ($162). Two of the three Gemini calls (`assignAccountsWithGemini`, `researchVendorWithGemini`) are text-only and don't need a Pro model.

## Plan

- [x] Step 1 — Cloud Run env var swap (live): `GEMINI_MODEL=gemini-2.5-pro`, `GEMINI_FALLBACK_MODEL=gemini-2.5-flash`. Already deployed (rev `ap-bill-ocr-worker-00164-zrg`).
- [ ] Step 2 — `cloudbuild.yaml:41` pins both env vars to Pro 3 — will revert Step 1 on next deploy. Update to match.
- [ ] Step 3 — Add `GEMINI_CHEAP_MODEL` (default `gemini-2.5-flash`) to config; let `geminiWithRetryAndFallback` accept a per-call model override.
- [ ] Step 4 — Route `assignAccountsWithGemini` and `researchVendorWithGemini` through the cheap model. Both are text-only structured output.
- [ ] Step 5 — Add `maxOutputTokens` caps: extraction 4096, assignment 3072, research 512.
- [ ] Step 6 — Skip `researchVendorWithGemini` when vendor was matched in Odoo (i.e. `vendor.id && !vendor.created`). Saves ~7k research calls/period for repeat vendors.
- [ ] Step 7 — Test: assert model override flows through to the request URL.
- [ ] Step 8 — `npm test`, commit, PR.

## Decisions

- Skipped `cachedContent` API for now — bigger lift (cache lifecycle, TTL renewal) for smaller savings (~$13/period on input). Revisit if input bill grows.
- "Skip research when vendor exists" uses `vendor.created !== true` rather than reading the Odoo `comment` field. No extra round-trip; same effect for the common case (matched vendor = known vendor).

## Review
- Pending.
