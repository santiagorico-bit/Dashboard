import test from "node:test";
import assert from "node:assert/strict";
import { entityFromFilename, mapRecord, safePayload } from "../src/sftp-shadow-domain.js";

test("recognises supported Resamania export families", () => {
  assert.equal(entityFromFilename("20261002_abonnements_OMD.csv"), "abonnements");
  assert.equal(entityFromFilename("passages_init.csv"), "passages");
  assert.equal(entityFromFilename("personal_contacts.csv"), "contacts");
  assert.equal(entityFromFilename("incidents.csv"), null);
});

test("maps stable identifiers and canonical club/contact fields", () => {
  const row = mapRecord("passages", { uid: "pass-1", contactUid: "contact-1", clubCode: "OMD", crossedAt: "2026-10-02T08:30:00Z", updatedAt: "2026-10-02T08:31:00Z" });
  assert.equal(row.externalUid, "pass-1");
  assert.equal(row.clubCode, "OMD");
  assert.equal(row.contactUid, "contact-1");
});

test("drops PII before transmission", () => {
  const payload = safePayload({ uid: "1", email: "secret@example.com", phone: "600000000", clubName: "Madrid Delicias", productName: "Essential" });
  assert.deepEqual(payload, { uid: "1", clubName: "Madrid Delicias", productName: "Essential" });
});
