import test from "node:test";
import assert from "node:assert/strict";
import {
  isPaymentIncidence,
  isPreEligibleMembership,
  isSignatureIncidence,
  signatureIssueLabel,
} from "../src/dashboard-domain.js";

const enabledCodes = new Set(["cdi1", "cdi2", "cdi3"]);
const periodo = { from: "2026-08-01", to: "2026-08-31", enabledCodes };

test("reconoce las formas de un contrato sin firmar", () => {
  const estados = [
    "En espera de firma", "Pendiente de firma", "pendiente firma", "Firma pendiente",
    "Sin firmar", "No firmado", "No firmada", "Falta la firma",
    "pending_signature", "awaiting signature", "signature_required", "unsigned", "not signed",
  ];
  for (const status of estados) {
    assert.equal(isSignatureIncidence({ status }), true, `${status} debería ser incidencia de firma`);
  }
});

test("un contrato en regla no es una incidencia de firma", () => {
  for (const status of ["Activo", "Firmado", "Validada", "En curso", "Pendiente de pago"]) {
    assert.equal(isSignatureIncidence({ status }), false, `${status} no debería ser incidencia de firma`);
  }
});

test("mira también los campos alternativos", () => {
  assert.equal(isSignatureIncidence({ contractState: "Sin firmar" }), true);
  assert.equal(isSignatureIncidence({ signatureStatus: "pending_signature" }), true);
});

test("devuelve el estado original para poder mostrarlo", () => {
  assert.equal(signatureIssueLabel({ status: "En espera de firma" }), "En espera de firma");
  assert.equal(signatureIssueLabel({ status: "Firmado" }), null);
});

test("un alta sin firmar SIGUE contando como alta", () => {
  const alta = {
    validFrom: "2026-08-05",
    status: "En espera de firma",
    initialInfo: { productCode: "CDI2", offerName: "Abono 12 meses" },
  };
  assert.equal(isPreEligibleMembership(alta, periodo), true, "la persona ya es socia: cuenta como alta");
  assert.equal(isSignatureIncidence(alta), true, "y queda anotada para hacerle seguimiento");
});

test("la incidencia de firma no rescata lo que ya estaba excluido", () => {
  const sesion = {
    validFrom: "2026-08-05",
    status: "Sin firmar",
    name: "Sesión",
    initialInfo: { productCode: "SESION", offerName: "Coaching TIE" },
  };
  assert.equal(isPreEligibleMembership(sesion, periodo), false, "una sesión sigue sin ser un alta");
});

test("pago y firma son incidencias distintas y no se confunden", () => {
  const firma = { status: "En espera de firma" };
  const pago = { status: "Recibo devuelto" };
  assert.equal(isSignatureIncidence(firma) && !isPaymentIncidence(firma), true);
  assert.equal(isPaymentIncidence(pago) && !isSignatureIncidence(pago), true);
});

test("un alta puede arrastrar las dos incidencias a la vez", () => {
  const ambas = { status: "Sin firmar", financialState: "Impagado" };
  assert.equal(isSignatureIncidence(ambas), true);
  assert.equal(isPaymentIncidence(ambas), true);
});
