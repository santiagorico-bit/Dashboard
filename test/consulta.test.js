import test from "node:test";
import assert from "node:assert/strict";
import { formatear, parseArgs } from "../src/consulta.js";
import { altas, bajas, facturacion, incidencias, resumen } from "../src/consulta-queries.js";
import { resolveClub } from "../src/resamania-browser.js";

const HOY = { hoy: "2026-08-10" };

/** Cliente de API falso: devuelve páginas fijas por endpoint. */
function fakeApi(porEndpoint, { subscriptions = {} } = {}) {
  return {
    llamadas: [],
    async getJson(path, { endpoint, params } = {}) {
      this.llamadas.push({ path, endpoint, params });
      const respuestas = porEndpoint[endpoint];
      if (!respuestas) return { "hydra:member": [] };
      const pagina = params?.page ?? 1;
      return respuestas[pagina - 1] ?? { "hydra:member": [] };
    },
    async getSubscription(uri) {
      return subscriptions[uri] ?? null;
    },
  };
}

const pagina = (items, hayMas = false) => ({
  "hydra:member": items,
  "hydra:view": hayMas ? { "hydra:next": "/siguiente" } : {},
});

test("acepta el slug, el nombre y un fragmento del centro", () => {
  assert.equal(resolveClub("ruzafa").slug, "ruzafa");
  assert.equal(resolveClub("Valencia Ruzafa").slug, "ruzafa");
  assert.equal(resolveClub("Málaga Soho").slug, "malaga-soho");
  assert.equal(resolveClub("MADRID").slug, "madrid");
});

test("no adivina cuando el fragmento es ambiguo", () => {
  assert.equal(resolveClub("valencia"), null, "tres centros son de Valencia");
  assert.equal(resolveClub("malaga"), null, "dos centros son de Málaga");
  assert.equal(resolveClub(""), null);
});

test("por defecto consulta el mes en curso", () => {
  const plan = parseArgs(["ruzafa", "altas"], HOY);
  assert.equal(plan.opciones.from, "2026-08-01");
  assert.equal(plan.opciones.to, "2026-08-10");
});

test("--hoy acota el rango a un solo día", () => {
  const plan = parseArgs(["madrid", "bajas", "--hoy"], HOY);
  assert.equal(plan.opciones.from, "2026-08-10");
  assert.equal(plan.opciones.to, "2026-08-10");
});

test("--desde y --hasta mandan sobre el resto", () => {
  const plan = parseArgs(["madrid", "altas", "--desde", "2026-07-01", "--hasta", "2026-07-31"], HOY);
  assert.equal(plan.opciones.from, "2026-07-01");
  assert.equal(plan.opciones.to, "2026-07-31");
});

test("rechaza una fecha mal escrita en vez de consultar cualquier cosa", () => {
  const plan = parseArgs(["madrid", "altas", "--desde", "01/07/2026"], HOY);
  assert.match(plan.error, /AAAA-MM-DD/);
});

test("rechaza un rango invertido", () => {
  const plan = parseArgs(["madrid", "altas", "--desde", "2026-08-10", "--hasta", "2026-08-01"], HOY);
  assert.match(plan.error, /invertido/);
});

test("avisa de un centro o una consulta que no existen", () => {
  assert.match(parseArgs(["marte", "altas"], HOY).error, /Centro no reconocido/);
  assert.match(parseArgs(["madrid", "beneficios"], HOY).error, /Consulta no reconocida/);
  assert.match(parseArgs([], HOY).error, /Uso:/);
});

test("--json y --ver no se confunden con valores", () => {
  const plan = parseArgs(["ruzafa", "resumen", "--json", "--ver"], HOY);
  assert.equal(plan.json, true);
  assert.equal(plan.verNavegador, true);
  assert.equal(plan.opciones.from, "2026-08-01");
});

test("el término de búsqueda de contacto llega entero", () => {
  const plan = parseArgs(["ruzafa", "contacto", "maria", "garcia"], HOY);
  assert.equal(plan.opciones.termino, "maria garcia");
});

test("altas aplica las mismas exclusiones que el dashboard", async () => {
  const abono = (id, contact, offerName, code = "CDI2", validFrom = "2026-08-05") => ({
    "@id": id, contact, validFrom, initialInfo: { productCode: code, offerName },
  });
  const api = fakeApi({
    "subscriptions.list": [pagina([
      abono("/s/1", "/c/1", "Abono 12 meses"),
      abono("/s/2", "/c/2", "Abono VIP staff"),
      abono("/s/3", "/c/3", "Cambio de fórmula"),
      { "@id": "/s/4", contact: "/c/4", validFrom: "2026-08-06", name: "Sesión",
        initialInfo: { productCode: "SESION", offerName: "Pase de día" } },
      abono("/s/5", "/c/5", "Abono 12 meses", "CDI2", "2026-07-20"),
    ])],
  });

  const resultado = await altas(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  // Sólo /s/1: VIP fuera, cambio de fórmula fuera, sesión fuera, y /s/5 es de julio.
  assert.equal(resultado.total, 1);
  assert.equal(resultado.personas, 1);
});

test("altas descuenta el abono precedido de un cambio de fórmula", async () => {
  const api = fakeApi({
    "subscriptions.list": [pagina([
      { "@id": "/s/nuevo", contact: "/c/1", validFrom: "2026-08-05",
        initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } },
      { "@id": "/s/previo", contact: "/c/1", validFrom: "2026-08-02",
        initialInfo: { productCode: "CDI2", offerName: "Cambio de fórmula" } },
    ])],
  });

  const resultado = await altas(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  assert.equal(resultado.total, 0, "no es un alta nueva: viene de un cambio de fórmula");
});

test("bajas usa la fecha efectiva y excluye lo que no cuenta", async () => {
  const api = fakeApi({
    "cancellations.list": [pagina([
      { subscription: "/s/1", contact: "/c/1", cancellationDate: "2026-08-04", status: "Activa" },
      { subscription: "/s/2", contact: "/c/2", cancellationDate: "2026-07-20", status: "Activa" },
      { subscription: "/s/3", contact: "/c/3", cancellationDate: "2026-08-06", status: "Anulada" },
    ])],
  }, {
    subscriptions: {
      "/s/1": { initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } },
      "/s/2": { initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } },
      "/s/3": { initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } },
    },
  });

  const resultado = await bajas(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  // Fuera la de julio y fuera la anulada.
  assert.equal(resultado.total, 1);
});

test("facturación descarta las anuladas, también en femenino", async () => {
  const api = fakeApi({
    "invoices.list": [pagina([
      { createdAt: "2026-08-03T10:00:00Z", status: "Pagada", totalTI: 5000 },
      { createdAt: "2026-08-04T10:00:00Z", status: "Anulada", totalTI: 9900 },
      { createdAt: "2026-08-05T10:00:00Z", status: "Pagada", totalTI: 2550 },
      { createdAt: "2026-07-30T10:00:00Z", status: "Pagada", totalTI: 8000 },
    ])],
  });

  const resultado = await facturacion(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  assert.equal(resultado.facturas, 2);
  assert.equal(resultado.total, 75.5);
  assert.equal(resultado.descartadas, 2);
});

test("incidencias separa pago de contratos sin formalizar", async () => {
  const activo = (id, contact, status) => ({
    "@id": id, contact, validFrom: "2026-06-01", status,
    initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" },
  });
  const alta = (id, contact, status) => ({
    "@id": id, contact, validFrom: "2026-08-04", status,
    initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" },
  });

  const api = fakeApi({
    "subscriptions.active": [pagina([
      activo("/a/1", "/c/1", "Recibo devuelto"),
      activo("/a/2", "/c/2", "Impagado"),
      activo("/a/3", "/c/3", "Activa"),
    ])],
    "subscriptions.list": [pagina([
      alta("/n/1", "/c/9", "Contrato no formalizado"),
      alta("/n/2", "/c/8", "Activa"),
    ])],
  });

  const resultado = await incidencias(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  assert.equal(resultado.pago.total, 2);
  assert.deepEqual(resultado.pago.estados, { "Recibo devuelto": 1, Impagado: 1 });
  assert.equal(resultado.contratosNoFormalizados.total, 1);
  assert.deepEqual(resultado.contratosNoFormalizados.estados, { "Contrato no formalizado": 1 });
});

test("resumen reúne las cifras en una sola consulta", async () => {
  const api = fakeApi({});
  const resultado = await resumen(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  assert.deepEqual(
    Object.keys(resultado),
    ["consulta", "periodo", "altas", "bajas", "activos", "incidenciasDePago", "contratosNoFormalizados"],
  );
});

test("la salida legible nombra el centro y el periodo", () => {
  const texto = formatear(
    { consulta: "altas", periodo: { desde: "2026-08-01", hasta: "2026-08-10" }, total: 84, personas: 82 },
    { name: "Valencia Ruzafa" },
  );
  assert.match(texto, /Valencia Ruzafa/);
  assert.match(texto, /2026-08-01/);
  assert.match(texto, /84/);
});

test("la paginación se detiene cuando no hay siguiente página", async () => {
  const api = fakeApi({
    "subscriptions.list": [
      pagina([{ "@id": "/s/1", contact: "/c/1", validFrom: "2026-08-02",
        initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } }], true),
      pagina([{ "@id": "/s/2", contact: "/c/2", validFrom: "2026-08-03",
        initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" } }], false),
    ],
  });

  const resultado = await altas(api, { clubId: "/clubs/1", from: "2026-08-01", to: "2026-08-10" });
  assert.equal(resultado.total, 2);
  assert.equal(api.llamadas.filter((l) => l.endpoint === "subscriptions.list").length, 2);
});
