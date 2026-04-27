# Cost estimate (revised, 2026-04-27, post-incident)

This doc has been rewritten twice. The original assumed 1,500 bills/month at steady state and predicted $55-65/month. The first revision saw a $200/week bill, took the 7,167 Vision OCR calls at face value, and predicted $170-300/month. Both were wrong because **most of the OCR volume was retry waste, not real bills**.

## What the 7-day $200 bill was actually paying for

Real production traffic (last 7 days, by log query):

| Metric | Count |
|---|---|
| Successful bill creations (HTTP 200 webhooks) | **66** (46 klaro-ventures + 20 proseso-test) |
| Unique doc IDs that reached Gemini extraction | **30** |
| Vision OCR calls billed | **7,167** |
| Cron `/run` sweeps | 326 |
| Webhook 404s (etruscans tenant misconfigured) | 1,703 |
| Webhook 429s (rate-limited) | 297 |

**OCR calls per unique doc: ~239×.** The seven docs with the most reprocessing were `22, 23, 24, 66, 87, 65, 70` — all on klaro-ventures, all hitting the Odoo PH `check_vat_ph` validator with `does not seem to be valid` because vendor TINs were being written without hyphens. Each cron sweep (every 15 minutes × 14 tenants ≈ 326/week) found these docs as "unprocessed" because bill creation had failed and no marker was written, so Vision + 3 Gemini calls fired again. Multiply 7 docs × ~640 sweeps × 4 API calls = ~17,900 wasted calls — ~99% of the $200.

**Per real bill: $200 / 66 ≈ $3.03.** Burnt cost-per-output, not steady-state cost-per-bill.

## What's now in place

| Fix | Effect |
|---|---|
| PR #36 (`2ecee83`) — write VAT as `XXX-XXX-XXX-YYY`, route VAT-format errors to `needs_confirmation` | Stops the specific klaro-ventures retry loop at its source |
| PR #37 (`ca3d34b`) — keep `documents.document.active=true` on retry path | Prevents related cascading-trash retry path |
| PR #38 (`b07164a`) — `gemini-2.5-pro` primary, `gemini-2.5-flash` for assignment + research, `maxOutputTokens` caps, skip vendor research for matched vendors | ~60% cheaper per Gemini call |
| PR #39 (`4a6b754`) — `bs-gemini` cap, summarized-receipt VAT bucket split, reconciliation warning | Tightens BS extraction; correctness, not direct cost |

## Steady-state projection

**Assumption:** real production volume is roughly 10 bills/day across active tenants (~70/week, ~300/month). This number should be confirmed against `documents.document` create counts in Odoo, not against worker logs.

Per real bill, post-PR-38:
- 1 Vision Document Text Detection call ≈ $0.0015
- 1 Gemini extraction (2.5 Pro, ~1,100 in / ~1,500 out) ≈ $0.009
- 1 Gemini account assignment (2.5 Flash, ~3,000 in / ~500 out) ≈ $0.0006
- 0–1 Gemini vendor research (2.5 Flash, only when vendor is newly created) ≈ $0.0002
- ≈ **$0.011/bill**

| Real bills/month | Gemini + Vision | Cloud Run | SQL/secrets/other | Total |
|---|---|---|---|---|
| 300 | ~$3 | ~$5 | ~$15 | **~$25** |
| 1,000 | ~$11 | ~$15 | ~$15 | **~$40** |
| 5,000 | ~$55 | ~$70 | ~$15 | **~$140** |
| 28,000 | ~$310 | ~$170 | ~$30 | **~$510** |

The 28,000 row is what the worker LOOKED like it was processing in the bad week; that row is the ceiling we'd hit if the retry-loop returned.

## What can blow this estimate up again

The `--admin` direction was: **don't add a permanent-failure marker** for docs that fail bill creation. That means any deterministic, persistent failure mode (the way `check_vat_ph` was) will retrigger the same retry loop — different cause, same shape.

Examples that could trigger it:
- A vendor field constraint added by a future Odoo update or studio rule
- Currency mismatch on a tenant where the resolved currency is missing
- Tax-id resolution failing for a new tenant before routing is configured
- New webhook tenant URLs that 404 (etruscans-style)

Without a "fail once, skip thereafter" marker, the cron sweep is unbounded. Cost can return to $200/week from a single batch of stuck docs.

**Operational mitigations** in lieu of the marker:
1. GCP billing alert at $50/week and $100/week on `odoo-ocr-487104` (early warning).
2. Daily check on `gcloud logging read` for `severity>=ERROR` from `ap-bill-ocr-worker` — a single recurring error-fingerprint at >100/day is the loop signal.
3. When a tenant goes live, smoke-test 1 bill end-to-end before enabling the cron sweep.

## What was wrong with earlier versions of this doc

| | Original | First revision | Now |
|---|---|---|---|
| Real bills/month | 1,500 | 28,000 (extrapolated from OCR calls) | ~300 (extrapolated from successful bill creations) |
| Reasoning | Hypothetical scenario | Took OCR calls = unique docs | Tied OCR calls to log-confirmed unique doc IDs |
| Suggested action | "Switch to gemini-2.5-pro" | "More aggressive caching" | "The model swap is in. The dominant cost was a retry loop. Watch for the loop pattern, not the per-call price." |

Pricing references: [Gemini API](https://ai.google.dev/gemini-api/docs/pricing), [Cloud Vision](https://cloud.google.com/vision/pricing), [Cloud Run](https://cloud.google.com/run/pricing).
