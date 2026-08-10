import test from "node:test";
import assert from "node:assert/strict";
import {
  isEligibleActiveMember,
  isPaymentIncidence,
  paymentIssueLabel,
} from "../src/dashboard-domain.js";

const enabledCodes = new Set(["cdi1", "cdi2", "cdi3"]);
const periodo = { from: "2026-08-01", to: "2026-08-10", enabledCodes };

test("reconoce las formas habituales de un cobro pendiente", () => {
  const estados = [
    "Pendiente de pago", "pendiente pago", "Pago pendiente",
    "Impagado", "Impagada", "Impago",
    "Recibo devuelto", "Devuelta",
    "Cobro rechazado", "Rechazada",
    "unpaid", "pending_payment", "payment_failed", "overdue",
  ];
  for (const status of estados) {
    assert.equal(isPaymentIncidence({ status }), true, `${status} debería ser incidencia de pago`);
  }
});

test("un abono al corriente no es una incidencia", () => {
  for (const status of ["Activo", "Activa", "Pagada", "Validado", "En curso", "Pendiente de firma"]) {
    assert.equal(isPaymentIncidence({ status }), false, `${status} no debería ser incidencia de pago`);
  }
});

test("mira también los campos alternativos de estado", () => {
  assert.equal(isPaymentIncidence({ financialState: "Impagado" }), true);
  assert.equal(isPaymentIncidence({ paymentStatus: "unpaid" }), true);
  assert.equal(isPaymentIncidence({ state: "Recibo devuelto" }), true);
});

test("devuelve el estado original para poder mostrarlo", () => {
  assert.equal(paymentIssueLabel({ status: "Recibo devuelto" }), "Recibo devuelto");
  assert.equal(paymentIssueLabel({ status: "Activa" }), null);
});

test("un abono pendiente de pago SIGUE contando como socio activo", () => {
  const abono = {
    validFrom: "2026-07-01",
    validThrough: "2027-07-01",
    status: "Pendiente de pago",
    initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" },
  };
  assert.equal(isEligibleActiveMember(abono, periodo), true, "entra al club: cuenta como activo");
  assert.equal(isPaymentIncidence(abono), true, "y además queda anotado como incidencia");
});

test("la incidencia de pago no rescata lo que ya estaba excluido", () => {
  const vip = {
    validFrom: "2026-07-01",
    status: "Impagado",
    initialInfo: { productCode: "CDI2", offerName: "Abono VIP staff" },
  };
  assert.equal(isEligibleActiveMember(vip, periodo), false, "un VIP sigue fuera del recuento");
});

test("no confunde un abono sin estado con una incidencia", () => {
  assert.equal(isPaymentIncidence({}), false);
  assert.equal(isPaymentIncidence({ status: null }), false);
  assert.equal(isPaymentIncidence(null), false);
});
