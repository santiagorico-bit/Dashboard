import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResamaniaApiClient } from "../src/resamania-api-client.js";

function response(status, data = {}, headers = {}) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => data,
    allHeaders: async () => headers,
  };
}

test("reintenta 429/5xx y registra métricas", async () => {
  const statuses = [429, 503, 200];
  const request = { get: async () => response(statuses.shift(), { ok: true }) };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 3, baseDelayMs: 1,
  }).init();
  assert.deepEqual(await client.getJson("/contacts", { endpoint: "contacts.list" }), { ok: true });
  assert.equal(client.snapshotMetrics().requests, 3);
  assert.equal(client.snapshotMetrics().retries, 2);
  assert.equal(client.snapshotMetrics().endpoints["contacts.list"].errors, 0);
});

test("limita concurrencia", async () => {
  let active = 0;
  let maximum = 0;
  const request = { get: async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return response(200, {});
  } };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1", concurrency: 2,
  }).init();
  await Promise.all(Array.from({ length: 8 }, () => client.getJson("/contacts")));
  assert.equal(maximum, 2);
});

test("consulta primero la URI de suscripción y persiste la caché", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resamania-cache-"));
  const cacheFile = join(directory, "subscriptions.json");
  const calls = [];
  const item = { "@id": "/onairespana/subscriptions/7", contact: "/onairespana/contacts/2" };
  const request = { get: async (url) => { calls.push(url); return response(200, item); } };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1", cacheFile,
  }).init();
  assert.deepEqual(await client.getSubscription(item["@id"], { contact: item.contact }), item);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/subscriptions\/7$/);
  await client.flushCache();
  const stored = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.deepEqual(stored.subscriptions[item["@id"]], item);
  await client.getSubscription(item["@id"], { contact: item.contact });
  assert.equal(calls.length, 1);
});

test("si la URI directa no existe usa contact como string u objeto", async () => {
  const calls = [];
  const item = { "@id": "/onairespana/subscriptions/8" };
  const request = { get: async (url) => {
    calls.push(url);
    if (!url.includes("?")) return response(404);
    return response(200, { "hydra:member": [item] });
  } };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
  }).init();
  assert.deepEqual(await client.getSubscription(item["@id"], { contact: { "@id": "/onairespana/contacts/9" } }), item);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /contact=%2Fonairespana%2Fcontacts%2F9/);
});
