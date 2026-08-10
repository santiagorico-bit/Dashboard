import test from "node:test";
import assert from "node:assert/strict";
import { ResamaniaApiClient } from "../src/resamania-api-client.js";
import {
  assertAppLoaded,
  classifyResponse,
  SessionExpiredError,
  sessionExpiredMessage,
  verifySession,
} from "../src/resamania-session.js";

function response(status, data = {}, headers = {}) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => data,
    allHeaders: async () => headers,
  };
}

const HTML = { "content-type": "text/html; charset=utf-8" };
const JSON_CT = { "content-type": "application/json" };

test("clasifica como sesión el 401 y el 403", () => {
  assert.equal(classifyResponse({ status: 401 }), "session");
  assert.equal(classifyResponse({ status: 403 }), "session");
});

test("un 200 con HTML es el login, no un dato", () => {
  assert.equal(classifyResponse({ status: 200, headers: HTML }), "session");
  assert.equal(classifyResponse({ status: 200, headers: JSON_CT }), "other");
});

test("distingue la redirección a OAuth de una redirección cualquiera", () => {
  assert.equal(
    classifyResponse({ status: 302, headers: { location: "https://api.resamania.com/oauth/authorize" } }),
    "session",
  );
  assert.equal(classifyResponse({ status: 302, headers: { location: "/onairespana/contacts/9" } }), "other");
});

test("los errores de negocio no se confunden con sesión caducada", () => {
  assert.equal(classifyResponse({ status: 404, headers: JSON_CT }), "other");
  assert.equal(classifyResponse({ status: 429, headers: JSON_CT }), "other");
  assert.equal(classifyResponse({ status: 503, headers: JSON_CT }), "other");
});

test("el mensaje dice qué comando resuelve el bloqueo", () => {
  const message = sessionExpiredMessage({ club: "Valencia Ruzafa", status: 401 });
  assert.match(message, /npm run setup:club/);
  assert.match(message, /Valencia Ruzafa/);
  assert.match(message, /HTTP 401/);
});

test("assertAppLoaded corta si la página es el login", async () => {
  await assert.rejects(
    () => assertAppLoaded({ url: () => "https://api.resamania.com/oauth/authorize?client_id=x" }, { club: "Madrid" }),
    (error) => {
      assert.ok(error instanceof SessionExpiredError);
      assert.equal(error.authFailed, true);
      return true;
    },
  );
});

test("assertAppLoaded deja pasar la aplicación cargada", async () => {
  await assert.doesNotReject(() =>
    assertAppLoaded({ url: () => "https://app.resamania.com/onairespana/-/management" }, { club: "Madrid" }),
  );
});

test("verifySession acepta cabeceras que abren datos", async () => {
  const request = { get: async () => response(200, { "hydra:member": [] }, JSON_CT) };
  assert.equal(await verifySession(request, { baseUrl: "https://api.test/onairespana", headers: {} }), true);
});

test("verifySession rechaza cabeceras caducadas", async () => {
  const request = { get: async () => response(401, {}, JSON_CT) };
  await assert.rejects(
    () => verifySession(request, { baseUrl: "https://api.test/onairespana", headers: {}, club: "Ruzafa" }),
    (error) => {
      assert.ok(error instanceof SessionExpiredError);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test("verifySession deja subir un fallo de red sin llamarlo sesión caducada", async () => {
  const request = { get: async () => { throw new Error("ECONNRESET"); } };
  await assert.rejects(
    () => verifySession(request, { baseUrl: "https://api.test/onairespana", headers: {} }),
    (error) => {
      assert.ok(!(error instanceof SessionExpiredError));
      return true;
    },
  );
});

test("el cliente no reintenta un 401: lo convierte en SessionExpiredError", async () => {
  let calls = 0;
  const request = { get: async () => { calls += 1; return response(401, {}, JSON_CT); } };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 4, baseDelayMs: 1,
  }).init();

  await assert.rejects(() => client.getJson("/contacts", { endpoint: "contacts.list" }), SessionExpiredError);
  assert.equal(calls, 1, "un 401 no debe reintentarse cuatro veces");
});

test("el cliente rechaza un 200 con HTML en lugar de intentar parsearlo", async () => {
  const request = { get: async () => response(200, {}, HTML) };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 2, baseDelayMs: 1,
  }).init();

  await assert.rejects(() => client.getJson("/subscriptions", { endpoint: "subscriptions.list" }), SessionExpiredError);
});

test("allowStatuses sigue tolerando el 403 de subscriptions.detail", async () => {
  const request = { get: async () => response(403, {}, JSON_CT) };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 1, baseDelayMs: 1,
  }).init();

  const result = await client.get("/onairespana/subscriptions/7", {
    endpoint: "subscriptions.detail", allowStatuses: [400, 403, 404, 405],
  });
  assert.equal(result.status, 403);
  assert.equal(result.data, null);
});

test("un 200 con HTML no se tolera ni con allowStatuses", async () => {
  const request = { get: async () => response(200, {}, HTML) };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 1, baseDelayMs: 1,
  }).init();

  await assert.rejects(
    () => client.get("/onairespana/subscriptions/7", {
      endpoint: "subscriptions.detail", allowStatuses: [400, 403, 404, 405],
    }),
    SessionExpiredError,
  );
});

test("los 5xx se siguen reintentando", async () => {
  const statuses = [503, 502, 200];
  const request = { get: async () => response(statuses.shift(), { ok: true }, JSON_CT) };
  const client = await new ResamaniaApiClient({
    request, baseUrl: "https://api.test/onairespana", headers: {}, clubId: "/clubs/1",
    retries: 3, baseDelayMs: 1,
  }).init();

  assert.deepEqual(await client.getJson("/contacts", { endpoint: "contacts.list" }), { ok: true });
  assert.equal(client.snapshotMetrics().retries, 2);
});
