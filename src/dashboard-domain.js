export const normalizeText = (value) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("es")
  .trim();

export function resourceUri(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value["@id"] ?? value.id ?? null;
}

export function normalizeState(value) {
  const state = normalizeText(value);
  // Los estados llegan con el género del sustantivo: una factura es "Anulada"
  // y una suscripción "Anulado". Reconocer sólo el masculino dejaba pasar las
  // facturas anuladas como válidas, inflando la facturación.
  if (/^(cancel|cancell?ed|cancelad[oa]s?|anulad[oa]s?|void(ed)?)$/.test(state)) return "canceled";
  if (/^(valid|validated|validad[oa]s?|valid[oa]s?|pagad[oa]s?|paid)$/.test(state)) return "validated";
  if (/^(active|activ[oa]s?|accepted|aceptad[oa]s?)$/.test(state)) return "active";
  return state || null;
}

export const contactOf = (item) => resourceUri(item?.contactId ?? item?.contact);
export const productCode = (item) => normalizeText(item?.initialInfo?.productCode);
export const offerLabel = (item) => normalizeText([
  item?.initialInfo?.offerName,
  item?.offer?.name,
  item?.name,
].filter(Boolean).join(" "));
export const isSession = (item) => {
  const name = normalizeText(item?.name ?? item?.initialInfo?.productName);
  return name === "sesion" || productCode(item) === "sesion";
};
export const isTieSession = (item) => isSession(item) &&
  /(^|\W)ties?(\W|$)/i.test(offerLabel(item));
export const isDayPassSession = (item) => {
  if (!isSession(item) || isTieSession(item)) return false;
  const label = offerLabel(item);
  return label.includes("sesion de prueba") || label.includes("pase de dia") ||
    /(^|\W)day\s*pass(\W|$)/i.test(label);
};
export const isCdd = (item) => productCode(item).startsWith("cdd");
export const isVip = (item) => /(^|\W)vip(\W|$)/i.test(offerLabel(item));
export const isWebOffer = (item) => /(^|\W)web(\W|$)/i.test(offerLabel(item));
export const isFormulaChange = (item) => offerLabel(item).includes("cambio de formula");
export const isShortPass = (item) => {
  const label = offerLabel(item);
  const name = normalizeText(item?.name ?? item?.initialInfo?.productName);
  const code = productCode(item);
  return code === "cdd1" ||
    label.includes("1 semana") ||
    name.includes("1 semana") ||
    label.includes("pase de dia") ||
    label.includes("sesion de prueba") ||
    /(^|\W)day\s*pass(\W|$)/i.test(label);
};

/**
 * Estados que delatan un problema de cobro.
 *
 * Un abono pendiente de pago sigue siendo un socio activo —entra al club—, así
 * que no se excluye de ningún recuento: sólo se anota como incidencia.
 *
 * La lista está abierta a propósito. Los estados exactos que devuelve Resamania
 * se ven con `npm run audit:clasificacion`; si aparece uno que falta, se añade
 * aquí y queda cubierto en toda la aplicación.
 */
export const PAYMENT_ISSUE_PATTERNS = [
  /pendiente\s*(de\s*)?pago/,
  /pago\s*pendiente/,
  /impag/,      // impagado, impagada, impago
  /devuelt/,    // recibo devuelto
  /rechazad/,   // cobro rechazado
  /moros/,
  /unpaid/,
  /pending[\s_-]*payment/,
  /payment[\s_-]*(pending|failed|error|issue|due)/,
  /overdue/,
  /outstanding/,
];

/** Devuelve el estado original que ha disparado la incidencia, o null. */
export function paymentIssueLabel(item) {
  for (const raw of [item?.status, item?.state, item?.financialState, item?.paymentStatus]) {
    const value = normalizeText(raw);
    if (!value) continue;
    if (PAYMENT_ISSUE_PATTERNS.some((pattern) => pattern.test(value))) return String(raw);
  }
  return null;
}

export const isPaymentIncidence = (item) => paymentIssueLabel(item) !== null;

/**
 * Estados de un alta que aún no está formalizada.
 *
 * El alta cuenta desde el primer día —la persona ya es socia—, pero sin firma
 * puede quedar invalidada más adelante, así que necesita seguimiento. Igual que
 * con los cobros: se anota, no se descuenta.
 */
export const SIGNATURE_ISSUE_PATTERNS = [
  /(en\s*espera|pendiente)\s*(de\s*)?firma/,
  /firma\s*pendiente/,
  /sin\s*firmar/,
  /no\s*firmad[oa]/,
  /falta\s*(la\s*)?firma/,
  /(pending|awaiting)[\s_-]*signature/,
  /signature[\s_-]*(pending|missing|required)/,
  /unsigned/,
  /not[\s_-]*signed/,
];

/** Devuelve el estado original que ha disparado la incidencia, o null. */
export function signatureIssueLabel(item) {
  for (const raw of [item?.status, item?.state, item?.contractState, item?.signatureStatus]) {
    const value = normalizeText(raw);
    if (!value) continue;
    if (SIGNATURE_ISSUE_PATTERNS.some((pattern) => pattern.test(value))) return String(raw);
  }
  return null;
}

export const isSignatureIncidence = (item) => signatureIssueLabel(item) !== null;

export function isPreEligibleMembership(item, { from, to, enabledCodes }) {
  const validFrom = item?.validFrom?.slice(0, 10);
  return Boolean(validFrom && validFrom >= from && validFrom <= to) &&
    !isSession(item) && !isShortPass(item) && !isVip(item) && !isFormulaChange(item) &&
    (isCdd(item) || enabledCodes.has(productCode(item)));
}

export function isEligibleActiveMember(item, { from, to, enabledCodes }) {
  const validFrom = item?.validFrom?.slice(0, 10);
  const validThrough = item?.validThrough?.slice(0, 10);
  return Boolean(validFrom && validFrom < from && (!validThrough || validThrough >= to)) &&
    !isSession(item) && !isShortPass(item) && !isVip(item) && !isFormulaChange(item) && enabledCodes.has(productCode(item));
}

export function hasPriorFormulaChange(item, history) {
  const validFrom = item?.validFrom?.slice(0, 10);
  if (!validFrom) return false;
  return history.some((prior) =>
    prior?.["@id"] !== item?.["@id"] &&
    prior?.validFrom?.slice(0, 10) < validFrom &&
    isFormulaChange(prior)
  );
}

export function isEligibleCancellation(item, subscription, { from, to, enabledCodes, motiveName }) {
  const effective = item?.cancellationDate?.slice(0, 10);
  return Boolean(subscription && effective && effective >= from && effective <= to) &&
    normalizeState(item?.status) !== "canceled" &&
    !isVip(subscription) && !isShortPass(subscription) &&
    (isCdd(subscription) || enabledCodes.has(productCode(subscription))) &&
    !normalizeText(motiveName).includes("cambio de formula") &&
    !isFormulaChange(subscription);
}

export function isValidInvoice(item, { from }) {
  const state = normalizeState(item?.status ?? item?.state ?? item?.financialState);
  return item?.createdAt?.slice(0, 10) >= from &&
    !item?.canceledAt && !item?.deletedAt && state !== "canceled";
}

export function isShortNoticeFullPeriodCancellation(item, maxDays = 14) {
  if (item?.refundPolicy !== "period_start" || normalizeState(item?.status) === "canceled") return false;
  const requested = item?.receptionDate?.slice(0, 10) ?? item?.createdAt?.slice(0, 10);
  const effective = item?.cancellationDate?.slice(0, 10);
  if (!requested || !effective) return false;
  const days = (Date.parse(`${effective}T12:00:00Z`) - Date.parse(`${requested}T12:00:00Z`)) / 86400000;
  return days >= 0 && days < maxDays;
}
