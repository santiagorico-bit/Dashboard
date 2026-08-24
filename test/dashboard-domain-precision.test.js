import test from "node:test";
import assert from "node:assert/strict";
import { isValidInvoice, normalizeState, tallyStates } from "../src/dashboard-domain.js";

test("reconoce los estados en femenino, no sólo en masculino", () => {
  for (const value of ["Cancelado", "Cancelada", "Anulado", "Anulada", "Anuladas", "canceladas"]) {
    assert.equal(normalizeState(value), "canceled", `${value} debería normalizar a canceled`);
  }
  for (const value of ["Pagado", "Pagada", "Validado", "Validada", "Valida"]) {
    assert.equal(normalizeState(value), "validated", `${value} debería normalizar a validated`);
  }
  for (const value of ["Activo", "Activa", "Aceptado", "Aceptada"]) {
    assert.equal(normalizeState(value), "active", `${value} debería normalizar a active`);
  }
});

test("sigue reconociendo los estados en inglés", () => {
  assert.equal(normalizeState("canceled"), "canceled");
  assert.equal(normalizeState("cancelled"), "canceled");
  assert.equal(normalizeState("voided"), "canceled");
  assert.equal(normalizeState("paid"), "validated");
  assert.equal(normalizeState("accepted"), "active");
});

test("un estado desconocido se conserva tal cual en vez de inventarse", () => {
  assert.equal(normalizeState("pendiente"), "pendiente");
  assert.equal(normalizeState("en curso"), "en curso");
  assert.equal(normalizeState(""), null);
  assert.equal(normalizeState(null), null);
});

test("una factura anulada en femenino no cuenta como facturación", () => {
  const base = { createdAt: "2026-08-10T09:00:00Z", totalTI: 5000 };
  assert.equal(isValidInvoice({ ...base, status: "Anulada" }, { from: "2026-08-01" }), false);
  assert.equal(isValidInvoice({ ...base, status: "Cancelada" }, { from: "2026-08-01" }), false);
  assert.equal(isValidInvoice({ ...base, status: "Pagada" }, { from: "2026-08-01" }), true);
});

test("la factura anulada se descarta venga el estado en el campo que venga", () => {
  const base = { createdAt: "2026-08-10T09:00:00Z", totalTI: 5000 };
  assert.equal(isValidInvoice({ ...base, state: "Anulada" }, { from: "2026-08-01" }), false);
  assert.equal(isValidInvoice({ ...base, financialState: "Cancelada" }, { from: "2026-08-01" }), false);
});

test("el censo de estados cuenta etiquetas sin guardar datos de nadie", () => {
  const facturas = [
    { status: "Pagada", contact: "/contacts/1", totalTI: 5000 },
    { status: "Pagada", contact: "/contacts/2" },
    { status: "Anulada", contact: "/contacts/3" },
    { financialState: "Rectificativa" },
    { status: null },
    {},
  ];
  const censo = tallyStates(facturas);
  assert.deepEqual(censo, { Pagada: 2, Anulada: 1, Rectificativa: 1 });
  assert.ok(!JSON.stringify(censo).includes("/contacts/"), "el censo no debe arrastrar contactos");
});

test("el censo tolera una colección vacía", () => {
  assert.deepEqual(tallyStates([]), {});
  assert.deepEqual(tallyStates(), {});
});
