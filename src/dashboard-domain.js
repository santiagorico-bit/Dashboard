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
  if (/^(cancel|canceled|cancelled|cancelado|anulado|void|voided)$/.test(state)) return "canceled";
  if (/^(valid|validated|valido|pagado|paid)$/.test(state)) return "validated";
  if (/^(active|activo|accepted|aceptado)$/.test(state)) return "active";
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
