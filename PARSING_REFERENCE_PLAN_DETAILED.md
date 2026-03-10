# AP Bill Worker – Gemini Parameters & Parsing Logic Reference (Detailed)

Reference for Gemini parameters, extraction schemas, and all parsing logic used in this project. **Assumes Odoo 19.** Updated for Odoo-based routing and current codebase.

---

## Gemini Configuration

| Env Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(required)* | Google AI API key |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Primary model for both passes |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-pro` | Stable fallback if primary fails |

Both passes use **structured JSON output** (`responseMimeType: "application/json"` + `responseSchema`).

---

## Pass 1: Invoice Extraction

**Function**: `extractInvoiceWithGemini(ocrText, config, attachment)`

**Input**: OCR text + **image or PDF bytes** (for multi-modal accuracy). Both `image/*` and `application/pdf` mimetypes are sent to Gemini as inline data so the model can read the document visually. PDFs were previously OCR-only; now the raw PDF is sent for better extraction.

**Output schema** – all fields below are extracted in a single Gemini call:

### vendor
| Field | Type | Description |
|---|---|---|
| `name` | string | Best-guess vendor/seller name |
| `confidence` | number | 0–1 confidence score |
| `source` | string | Where the name was found: `header`, `body`, `atp_printer_box`, `unknown` |

### vendor_candidates
Array of up to 5 alternative vendor guesses, each with `name`, `confidence`, `source`.

### vendor_details
| Field | Type | Description |
|---|---|---|
| `tin` | string | Tax Identification Number (PH format) |
| `branch_code` | string | Branch code if present |
| `address` | string | Vendor address |
| `entity_type` | string | `corporation`, `sole_proprietor`, `individual`, `unknown` |
| `trade_name` | string | Business/DBA name (e.g. "JORJEL LAUNDRY SHOP") |
| `proprietor_name` | string | Owner's personal name for sole proprietors (e.g. "JOCELYN E. SANTOS") |

**Entity type detection rules**:
- `corporation` – name ends with Inc., Corp., Co., LLC, etc.
- `sole_proprietor` – both a trade name AND a personal owner name present (look for "Prop.", "Owner:")
- `individual` – vendor is clearly a person with no business name
- `unknown` – cannot determine

### invoice
| Field | Type | Description |
|---|---|---|
| `number` | string | Invoice/receipt number |
| `date` | string | Date in `YYYY-MM-DD` format |
| `date_confidence` | number | 0–1 |
| `currency` | string | ISO currency code (e.g. "PHP", "USD") |

### vat
| Field | Type | Description |
|---|---|---|
| `classification` | string | `vatable`, `exempt`, `zero_rated`, `unknown` |
| `goods_or_services` | string | `goods`, `services`, `unknown` |
| `vatable_base` | number | Net amount before VAT |
| `vat_amount` | number | VAT amount |
| `exempt_amount` | number | VAT-exempt amount |
| `zero_rated_amount` | number | Zero-rated amount |
| `evidence` | string | Text snippet supporting the classification |

**VAT classification rules**:
- `exempt` – receipt shows "VAT Exempt" or VAT-exempt amount
- `zero_rated` – receipt shows "Zero Rated", "0% ZR"
- `vatable` – shows VAT amount, "VAT Sales", "Vatable Sales", or 12% VAT
- `unknown` – none of the above

### totals
| Field | Type | Description |
|---|---|---|
| `grand_total` | number | Final amount due (VAT-inclusive if applicable) |
| `net_total` | number | Amount BEFORE VAT. Computed as `grand_total / 1.12` if only inclusive total shown |
| `tax_total` | number | Tax amount |
| `amounts_are_vat_inclusive` | boolean | `true` if prices already include 12% VAT |
| `vat_exempt_amount` | number | Exempt portion |
| `zero_rated_amount` | number | Zero-rated portion |

All totals have accompanying `*_confidence` fields (0–1).

### line_items
Array of extracted line items:

| Field | Type | Description |
|---|---|---|
| `description` | string | Item description |
| `quantity` | number | Qty |
| `unit_price` | number | Price per unit (before discount) |
| `amount` | number | Line total (after discount) |
| `discount_percent` | number | Discount % (0–100). 0 if none. Amount = unit_price × qty × (1 − discount_percent/100) |
| `unit_price_includes_vat` | boolean | Whether unit price is VAT-inclusive (overridden by global `amounts_are_vat_inclusive` when true) |
| `expense_category` | string | One of: `office_supplies`, `meals`, `repairs`, `rent`, `fuel`, `professional_fees`, `freight`, `utilities`, `inventory`, `equipment`, `other` |
| `goods_or_services` | string | Per-line: `goods`, `services`, or `unknown`. Used for tax scope (goods vs services) |
| `is_capital_goods` | boolean | true if line is capital asset/equipment (machinery, vehicles, computers, furniture, PPE) |
| `is_imported` | boolean | true if line is clearly imported (foreign supplier, customs); false if domestic or unclear |
| `vat_code` | string | Per-line VAT: `vatable`, `exempt`, `zero_rated`, or `no_vat` |

### expense_account_hint
| Field | Type | Description |
|---|---|---|
| `category` | string | Best-fit category: `office_supplies`, `meals`, `repairs`, `rent`, `fuel`, `professional_fees`, `freight`, `other` (subset of line_items; no utilities, inventory) |
| `suggested_account_name` | string | Human-friendly account name guess |
| `confidence` | number | 0–1 |
| `evidence` | string | Supporting snippet |

### amount_candidates
Array of all notable amounts found, each with `label`, `amount`, `confidence`, `snippet`. Used by `fixExtractedAmounts`.

### warnings
Array of strings flagging potential issues (e.g. "Multiple totals found", "Low confidence vendor match").

### Amount Correction (`fixExtractedAmounts`)

Post-processing corrects Gemini misreads for handwritten/low-quality receipts:

| Case | When | Action |
|---|---|---|
| A | Line sum >> grand total (e.g. 10500 vs 1045) | Use line sum |
| B | Grand total >> line sum (e.g. 85509 vs 8017) | Use line sum or best amount_candidate |
| C | Amount candidate >> grand total (truncated) | Use candidate |
| D | Grand total >> amount candidate (inflated) | Use candidate |
| E | OCR max >> grand total (truncated) | Use OCR max |
| F | Grand total >> OCR max (inflated) | Use OCR max |
| G | Decimal misread (grandTotal/10 or /100 ≈ line sum) | Use line sum or candidate |
| H | grand_total ≈ tax_total or vat_amount (VAT picked as total) | Use vatable_base + tax, or best "total" candidate, or derive from 12% |
| I | tax_total > 20% of grand_total (impossible for PH 12% VAT) | Use best total candidate, line sum, or derive from tax / 0.12 × 1.12 |

### Discount Detection (Pass 1 prompt)

- Look for "Disc.%", "Discount", or "Disc" column on the invoice.
- Set `discount_percent` to the value (e.g. 5 for 5%). Verify: amount = unit_price × quantity × (1 − discount_percent/100).
- `unit_price` is the **original** price before discount; `amount` is the line total after discount.

### Per-Line Goods vs Services / Capital / Import (Pass 1 prompt)

- **goods_or_services**: "goods" for physical products/supplies/inventory; "services" for labor, consulting, professional fees, rent, repairs, subscriptions, SaaS.
- **is_capital_goods**: true only for long-lived assets (machinery, vehicles, computers, furniture, PPE); false for consumables.
- **is_imported**: true when customs/import/foreign supplier is clearly indicated; false for services or domestic/unclear.

### PH-Specific Prompt Rules

- **ATP/Printer box exclusion**: Names found near "ATP", "BIR Permit", "Printer", "Accreditation" are excluded as vendor candidates.
- **VAT-inclusive detection**: Most PH receipts show prices including 12% VAT. The prompt instructs Gemini to detect this and compute `net_total = grand_total / 1.12`.
- **Grand total vs line items**: When totals disagree, prefer the reading where arithmetic is consistent. Never pick a grand total 5x–15x the line item sum (likely misread).
- **VAT vs total (critical)**: grand_total must NEVER be a VAT/tax component. "VAT Amount: 428.57" means the tax is 428.57, NOT the total. If grand_total ≈ tax_total, the wrong number was picked. If tax_total > grand_total, the grand_total is wrong (tax cannot exceed total).
- **Extract ALL line items**: Do not skip items. If the invoice lists 10 products, extract all 10. Re-examine if only one line item was found but the document clearly has more.
- **Sole proprietor detection**: Gemini looks for "Prop.", "Owner", or personal names near trade names.

---

## Vendor Research (Google Search Grounding)

**Function**: `researchVendorWithGemini(vendorName, tradeName, config)`

Before account assignment, the worker can call Gemini with **Google Search grounding** (`tools: [{ google_search: {} }]`) to look up the vendor and get a short summary: what the company does, its industry/sector, and what expense category a purchase from this vendor typically falls under. This context is passed into Pass 2 so that e.g. "Cursor" is classified as software/subscriptions rather than supplies.

Result is truncated to 500 chars and included in the bill chatter. If the call fails or returns "No information found", account assignment continues without it.

---

## Pass 2: Account Assignment

**Function**: `assignAccountsWithGemini(extracted, expenseAccounts, config, targetKey, industry, ocrText, vendorResearch)`

**Input**:
- Extracted data from Pass 1
- Full chart of expense accounts from Odoo (`account.account` where `account_type in [expense, expense_direct_cost, expense_depreciation, asset_current]`)
- Company industry (see [Industry Resolution](#industry-resolution))
- **Vendor research** (optional string from Google Search grounding)
- OCR text (for additional context)

**Output schema**:

| Field | Type | Description |
|---|---|---|
| `assignments` | array | Per-line account picks |
| `assignments[].line_index` | number | 0-based index into line_items |
| `assignments[].account_id` | number | Matched Odoo account ID |
| `assignments[].account_code` | string | Account code |
| `assignments[].account_name` | string | Account name |
| `assignments[].confidence` | number | 0–1 |
| `assignments[].reasoning` | string | Why this account was chosen |
| `assignments[].alternatives` | array | Fallback account picks |
| `bill_level_account_id` | number | Best single account for the whole bill |
| `bill_level_account_code` | string | Account code |
| `bill_level_account_name` | string | Account name |
| `bill_level_confidence` | number | 0–1 |

### Industry in Account Selection

When `industry` is non-empty, the prompt includes company industry and industry-specific mapping rules. Full prompt covers:
- **Core principle**: Purchases for the core business → Cost of Revenue / COGS; back-office → Operating Expense
- **Industry-specific examples**: Restaurant (ingredients→COGS, kitchen supplies→COGS, cleaning→Janitorial), Retail (merchandise→COGS, packaging→COGS), Manufacturing (raw materials→COGS, factory supplies→Overhead), Laundry (detergent→COGS), Construction (cement, lumber→COGS), Professional services (subcontractors→Cost of Revenue)

### Prompt Rules

1. **Specificity over generality**: NEVER pick "Admin Expense", "Miscellaneous", "General Expense" unless no specific account exists.
2. **Match by item description, not vendor**: What was bought matters, not who sold it.
3. **Industry-aware COGS vs OpEx**: When industry is known, use it to decide Cost of Revenue vs Operating Expense.
4. **Philippine accountant persona**: Think like a PH accountant recording a vendor bill.

### Item-to-Account Examples (in prompt)

| Item | Account |
|---|---|
| TABLE CLOTH | Supplies / Housekeeping Supplies |
| LPG REFILL 11KG | Fuel & Oil / Gas & Oil |
| BOND PAPER A4 | Office Supplies / Stationery |
| TONER CARTRIDGE | Office Supplies / Printing |
| ELECTRICITY BILL | Utilities / Power & Light |
| JANITORIAL SUPPLIES | Janitorial / Cleaning Supplies |
| FOOD / MEALS | Meals & Entertainment |
| LEGAL FEES | Professional Fees |
| SHIPPING / DELIVERY | Freight / Shipping |
| FABRIC / CLOTH | Raw Materials (or COGS for mfg) |
| DETERGENT / BLEACH | Janitorial (or COGS for laundry) |

---

## Industry Resolution

**Source only – no fallback.**

Industry comes **only** from the **SOURCE Odoo – General task**:
- Task: name = "General", stage = "General" (or as configured)
- Field: `x_studio_industry` (or `SOURCE_GENERAL_TASK_INDUSTRY_FIELD` from .env)
- Requires: `SOURCE_BASE_URL`, `SOURCE_DB`, `SOURCE_LOGIN`, `SOURCE_PASSWORD` (Secret Manager)

There is **no** industry resolution from the target DB. If the General task has no industry, it stays empty.

Industry is written to the routing data and passed to `assignAccountsWithGemini` for account selection.

---

## Expense Account Loading (Odoo 19)

**Function**: `loadExpenseAccounts(odoo, companyId)`

**Query strategy** (cascading, no `company_id` filter on `account.account`):

1. `account_type in [expense, expense_direct_cost, expense_depreciation, asset_current]`
2. `account_type in [expense, expense_direct_cost]`
3. `code like "5" OR code like "6"`
4. All accounts

Each attempt is logged. Company scoping via `kwWithCompany(companyId)` context.

---

## Vendor Resolution

### Search Order (`findVendor`)

1. Search Odoo `res.partner` by **primary vendor name** (from `vendor.name`)
2. Search by **trade name** (from `vendor_details.trade_name`)
3. Search by **proprietor name** (from `vendor_details.proprietor_name`)

All searches: `name ilike <value>` + `supplier_rank > 0`.

### Auto-Creation (`createVendorIfMissing`)

**Conditions**:
- Vendor confidence >= 0.9
- Not an ATP/printer vendor
- No existing match found

**Sole proprietor handling**:
- If `entity_type` is `sole_proprietor` or `individual` AND `proprietor_name` is present → Odoo vendor created with **proprietor's personal name**
- Trade name goes into `comment` field
- Sets `company_type: "person"` (falls back to `is_company: false`)

**Corporation handling**:
- Vendor created with business name
- Sets `company_type: "company"`

**Fields written**:
- `name`, `supplier_rank: 1`, `street`, `vat`, `comment`

---

## Tax & VAT Logic

All purchase tax IDs are **auto-resolved from the target Odoo database** at runtime. There is no pre-configured VAT tax on the task or routing.

### Tax Map (`pickVatTaxesForCompany`)

Queries `account.tax` where `company_id`, `active`, `type_tax_use in ['purchase','none']`. Returns a **tax map** with IDs for:

| Key | Description |
|-----|-------------|
| `goodsId` | 12% VAT on goods (Tax Scope: Goods), excluding capital/import/NCR |
| `servicesId` | 12% VAT on services (Tax Scope: Services) |
| `capitalId` | 12% VAT capital goods (equipment, PPE) |
| `importsId` | 12% VAT imports |
| `nonResidentId` | 12% VAT non-resident services |
| `ncrId` | 12% VAT not directly attributable (NCR) |
| `exemptId` | 0% VAT exempt (purchases) |
| `exemptImportsId` | 0% VAT exempt imports |
| `zeroRatedId` | 0% Zero rated |
| `genericId` | Fallback 12% purchase VAT |

Name/description/tax_scope and scoring (e.g. service-like vs goods-like) are used to pick the right tax. Withholding and non-purchase taxes are excluded. The map also includes `_meta: { priceInclude, amount }` for price adjustment.

### Bill-Level Tax (`pickBillLevelTaxIds`)

Given extraction: if classification is exempt/zero_rated and no line is vatable → return exempt or zero-rated tax ID, or `[]`. Otherwise return goods, services, or generic ID based on `vat.goods_or_services`.

### Per-Line Tax (`pickLineTaxIds`)

For each line, using line item fields and bill-level goods_or_services and vendor country:

- **vat_code exempt** → exempt (or exempt imports if `is_imported`)
- **vat_code zero_rated** → zero-rated ID
- **vat_code no_vat** → `[]`
- **vat_code vatable** → if `is_capital_goods` or expense_category suggests equipment → capitalId; else if `is_imported` → importsId; else if vendor not PH and services → nonResidentId; else services or goods by `goods_or_services` and category; else genericId

### Tax Metadata (`getTaxMeta`)

Reads from Odoo: `price_include`, `amount` (rate %). Used for price adjustment when bill-level or line tax IDs are present.

---

## Price Adjustment (VAT-Inclusive)

**Function**: `adjustPriceForTax(price, invoiceVatInclusive, taxPriceInclude, taxRate)`

| Invoice Price | Odoo Tax Config | Action |
|---|---|---|
| VAT-inclusive | `price_include = true` | No adjustment |
| VAT-inclusive | `price_include = false` | Divide by `(1 + rate/100)` to get net |
| VAT-exclusive | `price_include = true` | Multiply by `(1 + rate/100)` |
| VAT-exclusive | `price_include = false` | No adjustment |

**Multi-line VAT logic**: When `amounts_are_vat_inclusive` is true, **all** line unit prices are treated as VAT-inclusive (`globalVatInclusive` overrides per-line `unit_price_includes_vat`). This avoids double VAT when Gemini mistakenly sets per-line to false.

---

## Total Reconciliation (Grand Total Prevails)

**Function**: `buildBillVals` – ensures Odoo bill total matches extracted grand total.

1. **Expected untaxed**: `net_total` from extraction, or `grand_total / 1.12` if not provided.
2. **Multi-line path**: After building line items, sum their untaxed amounts (each line: `price_unit × quantity × (1 − discount/100)`). If diff from `expectedUntaxed` > 0.005 and < 15%, adjust one line's `price_unit` to close the gap (prefer a line without discount).
3. **Single-line path**: Use `expectedUntaxed` directly as `price_unit`.

Result: Odoo total = expected untaxed × 1.12 ≈ grand total.

---

## Expense Account Cascade

**Function**: `resolveExpenseAccountId(...)` – 8-tier resolution:

### Tier 1: Vendor Default
Read `property_account_expense_id` from matched `res.partner`. **Skip if that account is generic** (e.g. Admin Expense).

### Tier 2: Gemini Pass 2
Use `account_id` from `assignAccountsWithGemini`. Validated and anti-generic (prefer non-generic alternatives).

### Tier 3: Vendor Name Keywords
Match vendor name (e.g. "FABRIC TRADING") against account names.

### Tier 4: Sheet Mapping (AccountMapping tab)
Lookup by `category` + `company_id` + `target_db` (if mapping source is used).

### Tier 5: Fuzzy Name Match
Match line description + category keywords against account names. Penalizes generic accounts.

### Tier 6: Gemini Last Resort
Use Gemini's primary pick even if generic (better than Odoo default).

### Tier 7: Keyword Last Resort
Best non-generic account matching description/category/vendor keywords; else first non-generic; else first available.

### Tier 8: Env Fallback
`DEFAULT_EXPENSE_ACCOUNT_ID` from environment.

### Tier 9: None
Returns `accountId: 0` – Odoo uses its own default.

*(Vendor account memory from GCS feedback can influence resolution when corrections exist for the same vendor.)*

---

## Bill Construction

**Function**: `buildBillVals(...)`

### Line Items vs Single Line

- If extracted `line_items` exist AND their total is within 5% of invoice total → **itemized lines**
- Otherwise → **single summary line**

### Per-Line Fields

| Field | Source |
|-------|--------|
| `name` | **Itemized**: line item description (max 256 chars). **Single-line fallback**: extracted line item descriptions joined (if any); else `"Vendor Bill"`. |
| `quantity` | From extraction |
| `price_unit` | From extraction (unit_price); adjusted via `adjustPriceForTax()`; last line may be tweaked for total reconciliation |
| `discount` | Set when `discount_percent` > 0 and < 100 (Odoo line discount %) |
| `account_id` | From expense account cascade |
| `tax_ids` | **Per-line**: `[[6, 0, pickLineTaxIds(taxMap, item, ...)]]` — goods, services, capital, imports, exempt, zero-rated, or none. Single-line fallback uses bill-level tax IDs. |

---

## Document Linking

**Function**: `linkDocumentToBill(odoo, companyId, docId, billId, logger, activeApFolderId, useIsFolder, journalId)`

1. **Ensure accounting folder active** (`ensureAccountingFolderActive`): Finds the company/journal accounting documents folder(s) and **unarchives** them so that opening the bill in Odoo does not trigger "It is not possible to create documents in an archived folder." Looks at `res.company.documents_account_folder_id`, `account.journal.documents_folder_id`, or archived folders named like Finance/Accounting.
2. Reads original `folder_id` from the document
3. **Archived folder**: If document is in an archived AP folder, move it to the active AP folder before linking
4. Sets `res_model = "account.move"`, `res_id = billId`, `account_move_id`, `invoice_id`, and `folder_id` in one write
5. **Retry logic** (800, 1500, 3000, 5000 ms): if folder was changed by Odoo after link, restore it
6. Posts a clickable link to the document in the bill chatter

### Chatter Messages

Posted with `body_is_html: true` (Odoo 19). Messages include:
- Source document link
- Vendor extraction details
- **Vendor research** (if Google Search grounding returned a summary)
- Account suggestions per line (code, name, resolution tier)
- Extracted amounts (grand total, net total, tax, VAT-inclusive flag)
- Warnings (if vendor confidence < 0.9 or extraction warnings)

---

## Reprocessing (Deleted Bills)

### Marker Format
```
BILL_OCR_PROCESSED|V1|<target_key>|doc:<doc_id>|bill:<bill_id>|...
```

### Reprocess Flow

1. Read marker from `ir.attachment.description`
2. If bill was **deleted**: clear marker, reprocess from scratch
3. If bill exists: skip
4. **Payload**: `reprocess: true` or `force_reprocess: true` bypasses duplicate check and forces full reprocess (clears marker first)

### `run-one` Stale Link Cleanup

When document's `res_model` points to a deleted `account.move`: clears `res_model`, `res_id`, and (if the model has them) `account_move_id`, `invoice_id`, then reprocesses.

### Document-delete webhook (`handleDocumentDelete`)

When a document is deleted and the worker is notified: if a draft bill was created for that document, the worker clears the document's link fields (`res_model`, `res_id`, `account_move_id`, `invoice_id`) **before** unlinking the bill, to avoid cascade-deleting the document if the bill were still present.

---

## Retry & Fallback

**Function**: `geminiWithRetryAndFallback(config, body, options)`

1. Try **primary model** (`GEMINI_MODEL`)
2. On HTTP 429/500/503: retry up to 2 times with backoff (3s, 6s)
3. If primary exhausted: try **fallback model** (`GEMINI_FALLBACK_MODEL`)
4. Pass 1: throws on total failure
5. Pass 2: returns `null` on failure (cascade continues without Gemini)

---

## Routing & Config (Odoo-Based)

Targets and accounting config come from **source Odoo** (e.g. General task with task URL, company id, and fields such as `x_studio_email`, `x_studio_api_key`). No spreadsheet required for routing when `ROUTING_SOURCE=odoo`.

### Auto-Resolved / Configurable Fields

| Purpose | Source |
|---------|--------|
| **VAT tax IDs** | **Always auto-resolved** from target Odoo at runtime via `pickVatTaxesForCompany` (goods, services, capital, imports, exempt, zero-rated, etc.). No VAT fields on task or routing. |
| `purchase_journal_id` | Target: "Vendor Bills" journal (`account.journal`) – field name from GCS or config |
| AP folder | Target: `documents.document` (Odoo 17+, `is_folder=true`) or `documents.folder`; names tried: "Accounts Payable", "Account Payables", "AP", "Vendor Bills". **Subfolders** of the AP folder are scanned via `resolveSubfolderIds` (documents in child folders are included). |
| `industry` | Source only: General task (`x_studio_industry` or `SOURCE_GENERAL_TASK_INDUSTRY_FIELD`). No fallback from target. |

Core task field names (DB, industry, stage, enabled, bill worker, multi company, company id, email, API key) come from .env (`SOURCE_GENERAL_TASK_*`). Accounting field names (AP folder, purchase journal) are loaded from GCS `odoo_field_names.json` when available.
