# AP Bill Worker – Overview & Technical Reference



---

## 1. Summary

### What this system does

The **AP Bill Worker** turns **uploaded supplier invoices and receipts** (PDFs or images) into **draft vendor bills** in your accounting system (Odoo). Staff upload a document; the system reads it, identifies the vendor, amounts, taxes, and line items, assigns the right expense accounts, and creates a draft bill so your team only has to review and post instead of typing everything in.

### Why it matters

- **Less manual data entry** – Fewer keystrokes, fewer transposition errors, faster turnaround from receipt to bill.
- **Consistent coding** – Expense accounts are chosen by rules and by what was bought (and optionally by your industry), not just by who sold it.
- **Philippine-ready** – Handles Philippine VAT (12%, inclusive/exempt/zero-rated), TIN formats, and common receipt layouts.
- **Learning over time** – When someone corrects an account on a bill, the system can use that feedback for similar bills later (per database).

### What you get

- **Input:** A document (invoice or receipt) dropped into a designated folder in Odoo (or sent via webhook).
- **Output:** A draft vendor bill in Odoo with vendor, amounts, taxes, and line items filled and linked back to the source document. Your team reviews, adjusts if needed, and posts.

### Where it runs

- The worker runs as a **cloud service** (e.g. Google Cloud Run). It connects to your **source Odoo** (where you define which companies/databases to process) and to each **target Odoo** (where it creates the draft bills). Configuration is stored in Odoo and in the cloud; no spreadsheets required for routing in the current design.

### Risks and limits

- **Accuracy** – Extraction is very good but not perfect; low-quality or handwritten receipts may need manual correction. The system is built for **review-then-post**, not unattended posting.
- **Vendor creation** – The system can create a new vendor in Odoo when confidence is high; otherwise it only matches existing vendors.
- **Tax and compliance** – Tax codes and VAT treatment are applied from your Odoo setup and routing; the worker does not replace your accounting or tax controls.

---

## 2. How it works (plain language)

1. **Document arrives** – Either uploaded to an "AP" folder (or a subfolder inside it) in Odoo or sent to the worker via a webhook.
2. **Read and understand** – The worker uses Gemini to read the document and extract: vendor, invoice number and date, currency, line items (description, quantity, price, discount %, goods vs services, capital goods, imported, VAT treatment), totals, and whether VAT is inclusive.
3. **Vendor research** – Optionally, Gemini uses Google Search grounding to look up the vendor and infer the type of expense (e.g. software vs supplies) for better account suggestions.
4. **Match vendor** – It looks up the vendor in Odoo (by business name, trade name, or proprietor name). If confidence is high and no match exists, it can create a new vendor.
5. **Assign accounts** – It chooses the right expense account for each line using your chart of accounts, industry (if set), vendor research, and feedback from past corrections.
6. **Resolve taxes** – Purchase VAT taxes are auto-resolved from the target Odoo database (no pre-configuration). Per line, the worker picks the correct tax: 12% goods, 12% services, 12% capital goods, 12% imports, 12% non-resident services, 0% exempt, 0% zero-rated, or none.
7. **Create draft bill** – It creates a draft vendor bill with itemized lines (including discounts where extracted), per-line tax assignment, links the document to the bill, and posts a summary in the bill chatter. Your team then reviews and posts.

Philippine VAT (12% goods/services/capital/imports, exempt, zero-rated) and common receipt formats are handled so totals and tax amounts stay correct.

---

## 3. Technical reference – when you need the details

The rest of this document is a **technical reference** for Gemini parameters, extraction schemas, and parsing logic. It assumes Odoo 19 and the current codebase.

---

### Gemini configuration

| Env variable   | Default                  | Purpose                          |
|----------------|--------------------------|----------------------------------|
| `GEMINI_API_KEY` | *(required)*           | Google AI API key                |
| `GEMINI_MODEL` | `gemini-3-pro-preview`  | Main model for extraction        |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-pro` | Backup model if main fails       |

Both AI passes use **structured JSON** (fixed schema) so the worker gets consistent, machine-readable answers.

---

### Pass 1: Invoice extraction

**Role:** Turn the document (OCR text + image/PDF) into structured data: vendor, invoice header, VAT/totals, line items, and expense hints.

**Input:** OCR text plus the **image or PDF bytes** (so the model can “see” the document for better accuracy).

**Main outputs:**

- **Vendor** – Name, confidence, and where it was found (header, body, etc.). Optional: TIN, address, entity type (corporation, sole proprietor, individual), trade name, proprietor name.
- **Invoice** – Number, date, currency.
- **VAT** – Classification (vatable / exempt / zero-rated), goods vs services, vatable base, VAT amount, exempt/zero amounts, and a short evidence snippet.
- **Totals** – Grand total, net total, tax total, and whether amounts are VAT-inclusive.
- **Line items** – For each line: description, quantity, unit price, amount, discount %, expense category, goods vs services, whether it is capital goods or imported, and per-line VAT code (vatable / exempt / zero_rated / no_vat).
- **Expense account hint** – Suggested account name and category for the line/bill.
- **Warnings** – e.g. “Multiple totals found”, “Low vendor confidence”.

**Amount correction (post-processing):** The worker fixes common misreads (e.g. grand total confused with VAT amount, decimal errors, totals not matching line sums) using rules and candidate amounts from the AI.

**Philippine-specific rules in the prompt:**

- Ignore vendor names that appear only near “ATP”, “BIR Permit”, “Printer”, “Accreditation”.
- Treat many PH receipts as VAT-inclusive and derive net as `grand_total / 1.12` when appropriate.
- Prefer totals that are arithmetically consistent with line items; reject a grand total that is many times the line sum (likely misread).
- Ensure grand total is never the VAT/tax component; if grand total ≈ VAT amount, the extraction is wrong and is corrected.

---

### Pass 2: Account assignment

**Role:** For each line (and for the whole bill), pick the right **Odoo expense account** from your chart of accounts.

**Input:** Pass 1 extraction, the company’s **expense account list** from Odoo, **industry** (if set), **vendor research** (optional short summary from Google Search grounding), and OCR text for context.

**Output:** Per-line assignments (account id, code, name, confidence, short reasoning, alternatives) plus a single “bill-level” account suggestion.

**Rules in the prompt:**

- Prefer **specific** accounts (e.g. “Office Supplies – Stationery”) over generic ones (e.g. “Admin Expense”, “Miscellaneous”) when they exist.
- Decide by **what was bought**, not only by vendor name.
- When industry is known, use it to separate **cost of revenue / COGS** (core business purchases) from **operating expense** (e.g. admin, office).
- Think like a Philippine accountant booking a vendor bill.

Industry comes **only** from your **source Odoo** (General task field, e.g. `x_studio_industry`). There is no fallback from the target.

---

### Industry resolution

**Source only – no fallback.** Industry comes **only** from the **source Odoo – General task** (e.g. field `x_studio_industry` or `SOURCE_GENERAL_TASK_INDUSTRY_FIELD`). There is no resolution from the target DB; if the task has no industry, it stays empty.

Industry is passed into the account-assignment step so the AI can choose COGS vs operating expense when set.

---

### Expense account loading (Odoo 19)

The worker loads expense-related accounts from Odoo with a **cascading** strategy (tries stricter filters first, then broader):

1. Types: expense, expense_direct_cost, expense_depreciation, asset_current  
2. Then: expense, expense_direct_cost  
3. Then: code starting with 5 or 6  
4. Then: all accounts  

Company is applied via context so only that company’s chart is used.

---

### Vendor resolution

- **Search order:** Primary vendor name → trade name → proprietor name (supplier partners only).
- **Auto-creation:** If confidence is high (e.g. ≥ 0.9), the vendor is not an ATP/printer name, and no match exists, the worker can create a new partner. For sole proprietors it uses the proprietor’s name as the partner name and can put the trade name in comments.

---

### Tax and VAT

- **Tax resolution:** All purchase tax IDs are **auto-resolved** from the target Odoo database (`account.tax`, type_tax_use = purchase). No pre-configured VAT IDs on the task; the worker discovers 12% VAT goods, 12% VAT services, 12% VAT capital goods, 12% VAT imports, 12% non-resident services, 0% exempt, 0% zero-rated, and applies the correct one per line using extraction (goods_or_services, is_capital_goods, is_imported, vat_code, vendor country).
- **Bill-level vs per-line:** Bill-level classification (vatable / exempt / zero_rated) and goods_or_services give a default; each line can override with its own VAT code and goods/services/capital/import flags for mixed invoices.
- **Price adjustment:** When the invoice is VAT-inclusive but Odoo expects exclusive prices (or the reverse), the worker adjusts unit prices so the bill total and tax stay correct.

---

### Expense account cascade (which account wins)

The worker resolves the expense account for each line in **tiers** (use first that applies and is not overly generic):

1. **Vendor default** – Account set on the vendor in Odoo (if not generic).  
2. **Gemini Pass 2** – AI-assigned account (validated, prefer non-generic).  
3. **Vendor name keywords** – Match vendor name to account names.  
4. **Sheet mapping** – Optional AccountMapping sheet by category + company + target DB.  
5. **Fuzzy match** – Line description and category vs account names (penalize generic).  
6. **Gemini last resort** – Use AI pick even if generic.  
7. **Keyword last resort** – Best non-generic match by description/category/vendor; else first non-generic; else first available.  
8. **Env fallback** – `DEFAULT_EXPENSE_ACCOUNT_ID` from environment.  
9. **None** – No account set; Odoo uses its default.

There is also a **vendor account memory** (from past corrections) that can influence picks when the same vendor and correction pattern repeat.

---

### Bill construction and document linking

- **Lines:** If Pass 1 line items exist and their total is close to the invoice total (e.g. within 5%), the bill is **itemized**; otherwise a **single summary line** is used. Each line can have a **discount %** (from extraction); totals are reconciled so the Odoo bill total matches the extracted grand total (with VAT and discount handled correctly).
- **Per-line tax:** Each line gets the appropriate purchase tax (12% goods, 12% services, 12% capital, 12% imports, 0% exempt, 0% zero-rated, or none) based on extraction and vendor context.
- **Document link:** The worker ensures any **accounting documents folder** in Odoo is unarchived (so opening the bill does not trigger “archived folder” errors), then links the source document to the draft bill using `res_model`/`res_id` and `account_move_id`/`invoice_id`, and posts a short message in the bill’s chatter (link, vendor summary, vendor research if any, account suggestions, warnings).

---

### Reprocessing and stale links

- **Processed marker:** Stored in the attachment description (e.g. `BILL_OCR_PROCESSED|V1|...|doc:<id>|bill:<id>|...`). Used to avoid reprocessing the same document and to detect when the linked bill was deleted.
- **Reprocess:** If the bill was deleted, the marker is cleared and the document is processed again from scratch. A run-one call can request `reprocess` or `force_reprocess` to force a full reprocess.
- **Stale link cleanup:** If the document points to a bill that no longer exists, the worker clears the link fields on the document and then can reprocess.

---

### Retry and fallback

- **Primary model** is tried first; on rate limits or server errors (e.g. 429, 500, 503) the worker retries a few times with backoff.
- If the primary model keeps failing, the **fallback model** is used. Pass 1 fails the run if both fail; Pass 2 can fail and the worker continues using other account-resolution tiers.

---

### Routing and config (Odoo-based)

Routing and accounting config are read from your **source Odoo** (e.g. General tasks), not from a spreadsheet, in the current design. Per target you configure:

- Target database (URL or DB name)
- Target login (e.g. `x_studio_email`) and API key (e.g. `x_studio_api_key`)
- Optional: AP folder, purchase journal, industry

**VAT tax IDs are not configured per target.** They are **auto-resolved** from the target database at runtime (12% goods/services/capital/imports, 0% exempt/zero-rated, etc.).

Some **field names** (which Odoo field holds AP folder, journal, etc.) can be overridden via a JSON file in cloud storage. Documents in **subfolders** inside the AP folder are also scanned.

---

*End of technical reference. For deployment, env vars, and GCS/Secret Manager, see the main README.*
