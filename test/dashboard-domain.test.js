import test from "node:test";
import assert from "node:assert/strict";
import {
  contactOf, hasPriorFormulaChange, isEligibleActiveMember, isEligibleCancellation, isPreEligibleMembership,
  isDayPassSession, isShortNoticeFullPeriodCancellation, isShortPass, isTieSession, isValidInvoice, isVip, isWebOffer, normalizeState,
} from "../src/dashboard-domain.js";

const enabledCodes = new Set(["cdi1", "cdi2", "cdi3"]);
const period = { from: "2026-08-01", to: "2026-08-31", enabledCodes };
const subscription = (overrides = {}) => ({
  "@id": "/onairespana/subscriptions/2", validFrom: "2026-08-05",
  name: "ON AIR Essential", initialInfo: { productCode: "cdi1", offerName: "ON AIR Essential" },
  contact: { "@id": "/onairespana/contacts/1" }, ...overrides,
});

test("altas: excluye sesiones y conserva una alta habilitada", () => {
  assert.equal(isPreEligibleMembership(subscription(), period), true);
  assert.equal(isPreEligibleMembership(subscription({ name: "SESIÓN", initialInfo: { productCode: "sesion" } }), period), false);
});

test("sesiones: distingue Coaching TIE, pase diario y sesión desconocida", () => {
  const session = (offerName) => subscription({
    name: "SESIÓN",
    initialInfo: { productCode: "sesion", productName: "Sesión", offerName },
  });
  assert.equal(isTieSession(session("Coaching TIE")), true);
  assert.equal(isDayPassSession(session("Coaching TIE")), false);
  assert.equal(isDayPassSession(session("Sesión de prueba")), true);
  assert.equal(isTieSession(session("Sesión de prueba")), false);
  assert.equal(isTieSession(session("Valoración deportiva")), false);
  assert.equal(isDayPassSession(session("Valoración deportiva")), false);
});

test("altas: CDD y Web entran, VIP se excluye", () => {
  assert.equal(isPreEligibleMembership(subscription({ initialInfo: { productCode: "cdd2", offerName: "Abono 1 mes" } }), period), true);
  assert.equal(isShortPass(subscription({ initialInfo: { productCode: "cdd1", offerName: "Abono 1 Semana" } })), true);
  assert.equal(isPreEligibleMembership(subscription({ initialInfo: { productCode: "cdd1", offerName: "Abono 1 Semana" } }), period), false);
  const web = subscription({ initialInfo: { productCode: "cdi2", offerName: "ON AIR Original Web" } });
  const vip = subscription({ initialInfo: { productCode: "cdi2", offerName: "Oferta VIP" } });
  assert.equal(isWebOffer(web), true);
  assert.equal(isVip(vip), true);
  assert.equal(isPreEligibleMembership(web, period), true);
  assert.equal(isPreEligibleMembership(vip, period), false);
});

test("socios activos: incluye ofertas web y excluye VIP", () => {
  const active = (offerName) => subscription({
    validFrom: "2026-07-15",
    validThrough: "2026-08-31",
    initialInfo: { productCode: "cdi1", offerName },
  });
  assert.equal(isEligibleActiveMember(active("ON AIR Essential Web"), period), true);
  assert.equal(isEligibleActiveMember(active("ON AIR Essential VIP"), period), false);
});

test("cambio de fórmula: detecta el abono anterior, no el actual", () => {
  const current = subscription();
  const prior = subscription({ "@id": "/onairespana/subscriptions/1", validFrom: "2026-07-01", initialInfo: { productCode: "cdi1", offerName: "Cambio de fórmula Clásica" } });
  assert.equal(hasPriorFormulaChange(current, [current, prior]), true);
  assert.equal(hasPriorFormulaChange(current, [current]), false);
});

test("bajas: usa fecha efectiva, incluye Web y excluye fórmula y VIP", () => {
  const cancellation = { cancellationDate: "2026-08-20", status: "accepted" };
  assert.equal(isEligibleCancellation(cancellation, subscription(), { ...period, motiveName: "Mudanza" }), true);
  assert.equal(isEligibleCancellation(cancellation, subscription(), { ...period, motiveName: "Cambio de fórmula" }), false);
  assert.equal(isEligibleCancellation(cancellation, subscription({ initialInfo: { productCode: "cdi1", offerName: "Oferta VIP" } }), { ...period, motiveName: "Mudanza" }), false);
  assert.equal(isEligibleCancellation(cancellation, subscription({ initialInfo: { productCode: "cdd1", offerName: "Abono 1 Semana" } }), { ...period, motiveName: "Mudanza" }), false);
  assert.equal(isEligibleCancellation(cancellation, subscription({ initialInfo: { productCode: "cdi1", offerName: "Oferta Web" } }), { ...period, motiveName: "Mudanza" }), true);
});

test("facturas: excluye canceladas y anuladas con estados normalizados", () => {
  assert.equal(isValidInvoice({ createdAt: "2026-08-05", status: "Emitida" }, { from: period.from }), true);
  assert.equal(isValidInvoice({ createdAt: "2026-08-05", status: "Anulado" }, { from: period.from }), false);
  assert.equal(isValidInvoice({ createdAt: "2026-08-05", financialState: "canceled" }, { from: period.from }), false);
  assert.equal(normalizeState("ANULADO"), "canceled");
});

test("contact acepta URI u objeto", () => {
  assert.equal(contactOf({ contact: "/onairespana/contacts/1" }), "/onairespana/contacts/1");
  assert.equal(contactOf({ contact: { "@id": "/onairespana/contacts/2" } }), "/onairespana/contacts/2");
});

test("período completo: solicitud y baja efectiva separadas por menos de 14 días", () => {
  assert.equal(isShortNoticeFullPeriodCancellation({ refundPolicy: "period_start", status: "accepted", receptionDate: "2026-08-01", cancellationDate: "2026-08-14" }), true);
  assert.equal(isShortNoticeFullPeriodCancellation({ refundPolicy: "period_start", status: "accepted", receptionDate: "2026-08-01", cancellationDate: "2026-08-15" }), false);
});
