import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OdooClient } from "../src/odoo.js";

/**
 * Live integration test against proseso-accounting-test.odoo.com.
 *
 * Verifies that Odoo PH localization's `check_vat_ph` enforces the hyphenated
 * format documented in the user-facing error ("expected format is 123-456-789-123")
 * and that the worker's new VAT shape (XXX-XXX-XXX-YYY) is accepted.
 *
 * Skipped unless RUN_LIVE_VAT_TESTS=1. Creds are loaded from the local
 * proseso-ventures registry (~/Project/proseso-ventures/proseso_clients/data/).
 */

const LIVE = process.env.RUN_LIVE_VAT_TESTS === "1";
const SECRETS_PATH = process.env.PROSESO_SECRETS_PATH
  || join(process.env.HOME || "/home/joseph", "Project/proseso-ventures/proseso_clients/data/clients.secrets.json");

const TEST_DB_URL = "https://proseso-accounting-test.odoo.com";
const TEST_DB_NAME = "proseso-accounting-test";
const TEST_DB_PROJECT_ID = "202";
const TEST_USER = "admin@proseso-consulting.com";

function loadOdoo() {
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  const apiKey = secrets?.api_keys?.[TEST_DB_PROJECT_ID];
  if (!apiKey) throw new Error(`Missing API key for project ${TEST_DB_PROJECT_ID} in ${SECRETS_PATH}`);
  return new OdooClient({
    baseUrl: TEST_DB_URL,
    db: TEST_DB_NAME,
    login: TEST_USER,
    password: apiKey,
  });
}

describe.skipIf(!LIVE)("VAT format — live proseso-accounting-test", () => {
  const odoo = LIVE ? loadOdoo() : null;
  const created = [];
  let phCountryId = null;

  afterAll(async () => {
    if (!LIVE || !odoo) return;
    if (created.length) await odoo.write("res.partner", created, { active: false }).catch(() => {});
    if (created.length) await odoo.executeKw("res.partner", "unlink", [created]).catch(() => {});
  });

  async function ensurePhId() {
    if (phCountryId) return phCountryId;
    const rows = await odoo.searchRead("res.country", [["code", "=", "PH"]], ["id"], { limit: 1 });
    phCountryId = rows?.[0]?.id;
    return phCountryId;
  }

  async function tryCreate(label, vat, branchCode) {
    const ph = await ensurePhId();
    const vals = {
      name: `_VATPROBE_${label}_${Date.now()}`,
      supplier_rank: 1,
      street: "N/A",
      city: "N/A",
      country_id: ph,
      is_company: true,
      vat,
    };
    if (branchCode !== undefined) vals.branch_code = branchCode;
    try {
      const id = await odoo.create("res.partner", vals);
      created.push(Number(id));
      return { ok: true, id: Number(id) };
    } catch (e) {
      return { ok: false, msg: String(e?.message || e) };
    }
  }

  it("rejects 9-digit unhyphenated TIN with the canonical error", async () => {
    const r = await tryCreate("9DIG_NOHYPHEN", "103303074", "000");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/does not seem to be valid/i);
    expect(r.msg).toMatch(/123-456-789-123/);
  }, 30_000);

  it("accepts 12-digit hyphenated TIN with branch_code (worker's new shape)", async () => {
    const r = await tryCreate("12DIG_HYPHEN_PRESPLIT", "103-303-074-000", "000");
    expect(r.ok).toBe(true);
    expect(r.id).toBeGreaterThan(0);
  }, 30_000);

  it("accepts 9-digit hyphenated TIN without branch (Odoo PH regex baseline)", async () => {
    const r = await tryCreate("9DIG_HYPHEN", "103-303-074");
    expect(r.ok).toBe(true);
    expect(r.id).toBeGreaterThan(0);
  }, 30_000);
});
