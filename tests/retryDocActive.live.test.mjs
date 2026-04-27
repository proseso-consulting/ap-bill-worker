import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OdooClient } from "../src/odoo.js";

/**
 * Live integration test confirming the retry-delete cascade and the fix.
 *
 * On retry, the worker unlinks the old draft bill via account.move.unlink.
 * Odoo's Documents-app cascade flips the linked document's active=false,
 * moving it to trash. The worker must restore active=true so the doc stays
 * in the upload folder.
 *
 * This test creates a partner + linked draft bill + document, runs the
 * unlink, observes the cascade, then runs the fix and verifies the doc
 * is restored to active=true.
 *
 * Skipped unless RUN_LIVE_RETRY_TESTS=1.
 */

const LIVE = process.env.RUN_LIVE_RETRY_TESTS === "1";
const SECRETS_PATH = process.env.PROSESO_SECRETS_PATH
  || join(process.env.HOME || "/home/joseph", "Project/proseso-ventures/proseso_clients/data/clients.secrets.json");

const TEST_DB_URL = "https://proseso-accounting-test.odoo.com";
const TEST_DB_NAME = "proseso-accounting-test";
const TEST_DB_PROJECT_ID = "202";
const TEST_USER = "admin@proseso-consulting.com";

function loadOdoo() {
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  const apiKey = secrets?.api_keys?.[TEST_DB_PROJECT_ID];
  if (!apiKey) throw new Error(`Missing API key for project ${TEST_DB_PROJECT_ID}`);
  return new OdooClient({
    baseUrl: TEST_DB_URL,
    db: TEST_DB_NAME,
    login: TEST_USER,
    password: apiKey,
  });
}

describe.skipIf(!LIVE)("retry-delete cascade — live proseso-accounting-test", () => {
  const odoo = LIVE ? loadOdoo() : null;
  const cleanup = { partnerIds: [], billIds: [], docIds: [] };

  afterAll(async () => {
    if (!LIVE || !odoo) return;
    if (cleanup.docIds.length) await odoo.executeKw("documents.document", "unlink", [cleanup.docIds]).catch(() => {});
    if (cleanup.billIds.length) await odoo.executeKw("account.move", "unlink", [cleanup.billIds]).catch(() => {});
    if (cleanup.partnerIds.length) await odoo.executeKw("res.partner", "unlink", [cleanup.partnerIds]).catch(() => {});
  });

  it("unlink cascades active=false; restoring active=true keeps doc in upload folder", async () => {
    // Find the AP Folder
    const folders = await odoo.searchRead("documents.document", [["type", "=", "folder"], ["name", "ilike", "Account Payables"]], ["id", "name"], { limit: 5 });
    const apFolderId = folders?.[0]?.id;
    expect(apFolderId, "AP folder must exist on test DB").toBeTruthy();

    const ph = (await odoo.searchRead("res.country", [["code", "=", "PH"]], ["id"], { limit: 1 }))?.[0]?.id;

    const partnerId = await odoo.create("res.partner", {
      name: `_RETRYPROBE_${Date.now()}`,
      supplier_rank: 1,
      street: "N/A",
      city: "N/A",
      country_id: ph,
      is_company: true,
      vat: "103-303-074-000",
    });
    cleanup.partnerIds.push(Number(partnerId));

    const billId = await odoo.create("account.move", {
      move_type: "in_invoice",
      partner_id: Number(partnerId),
    });
    cleanup.billIds.push(Number(billId));

    const docId = await odoo.create("documents.document", {
      name: `_RETRYPROBE_DOC_${Date.now()}.pdf`,
      folder_id: apFolderId,
      res_model: "account.move",
      res_id: Number(billId),
    });
    cleanup.docIds.push(Number(docId));

    // Sanity: doc starts active and in AP folder
    let rows = await odoo.searchRead("documents.document", [["id", "=", docId]], ["id", "active", "folder_id"], { limit: 1 });
    expect(rows[0].active).toBe(true);

    // Unlink the bill (mirrors worker.js retry path)
    await odoo.executeKw("account.move", "unlink", [[Number(billId)]]);
    cleanup.billIds = cleanup.billIds.filter((b) => b !== Number(billId));

    // Confirm cascade flipped active to false (the bug)
    rows = await odoo.searchRead("documents.document", [["id", "=", docId], ["active", "in", [true, false]]], ["id", "active", "folder_id"], { limit: 1 });
    expect(rows[0].active, "Odoo cascades active=false on the doc when its account.move is unlinked").toBe(false);

    // Apply the fix: write active=true alongside clearing the link fields
    await odoo.write("documents.document", [Number(docId)], { res_model: false, res_id: false, active: true });

    rows = await odoo.searchRead("documents.document", [["id", "=", docId]], ["id", "active", "folder_id", "res_model", "res_id"], { limit: 1 });
    expect(rows[0].active).toBe(true);
    const folderId = Array.isArray(rows[0].folder_id) ? rows[0].folder_id[0] : rows[0].folder_id;
    expect(folderId).toBe(apFolderId);
    expect(rows[0].res_model).toBe(false);
    expect(Number(rows[0].res_id) || 0).toBe(0);
  }, 60_000);
});
