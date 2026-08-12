/**
 * Consultas puntuales sobre un centro.
 *
 * Reutilizan las reglas de `dashboard-domain.js`, que son las mismas que aplica
 * el colector. Si aquí se reimplantara qué es un alta, en dos meses habría dos
 * cifras distintas y ninguna forma de saber cuál vale.
 *
 * El cliente de la API entra por parámetro para poder probarlas sin navegador.
 */

import {
  contactOf, hasPriorFormulaChange, isEligibleActiveMember, isEligibleCancellation,
  isPaymentIncidence, isPreEligibleMembership, isSignatureIncidence, isValidInvoice,
  normalizeText, paymentIssueLabel, signatureIssueLabel,
} from "./dashboard-domain.js";

/** Códigos habilitados en FitnessKPI, igual que en el colector. */
export const ENABLED_CODES = new Set(["cdi1", "cdi2", "cdi3"]);

const MAX_PAGES = 20;

/** Recorre un listado paginado de la API hasta agotarlo o alcanzar el tope. */
async function collectPages(api, path, { endpoint, params, maxPages = MAX_PAGES }) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await api.getJson(path, {
      endpoint,
      params: { ...params, itemsPerPage: 100, page },
    });
    items.push(...(payload?.["hydra:member"] ?? []));
    if (!payload?.["hydra:view"]?.["hydra:next"]) break;
  }
  return items;
}

/** Suscripciones del centro que arrancan dentro del rango. */
async function membershipsInRange(api, { clubId, from, to }) {
  const history = await collectPages(api, "/subscriptions", {
    endpoint: "subscriptions.list",
    params: { "contact.clubId": clubId, "order[validFrom]": "desc" },
  });

  const byContact = new Map();
  for (const item of history) {
    const contact = contactOf(item);
    if (!contact) continue;
    if (!byContact.has(contact)) byContact.set(contact, []);
    byContact.get(contact).push(item);
  }

  const inRange = history.filter((item) => {
    const validFrom = item.validFrom?.slice(0, 10);
    return Boolean(validFrom && validFrom >= from && validFrom <= to);
  });

  const preEligible = inRange.filter((item) =>
    isPreEligibleMembership(item, { from, to, enabledCodes: ENABLED_CODES }));

  // Un abono precedido de un cambio de fórmula no es un alta nueva.
  const eligible = preEligible.filter((item) =>
    !hasPriorFormulaChange(item, byContact.get(contactOf(item)) ?? []));

  return { history, eligible };
}

export async function altas(api, { clubId, from, to }) {
  const { eligible } = await membershipsInRange(api, { clubId, from, to });
  const contacts = new Set(eligible.map(contactOf).filter(Boolean));
  return {
    consulta: "altas",
    periodo: { desde: from, hasta: to },
    total: eligible.length,
    personas: contacts.size,
  };
}

export async function activos(api, { clubId, from, to }) {
  const items = await collectPages(api, "/subscriptions", {
    endpoint: "subscriptions.active",
    params: { "contact.clubId": clubId, "validFrom[before]": from, "order[validFrom]": "desc" },
  });
  const eligible = items.filter((item) =>
    isEligibleActiveMember(item, { from, to, enabledCodes: ENABLED_CODES }));
  return {
    consulta: "activos",
    periodo: { desde: from, hasta: to },
    total: new Set(eligible.map(contactOf).filter(Boolean)).size,
  };
}

export async function bajas(api, { clubId, from, to }) {
  const items = await collectPages(api, "/cancellations", {
    endpoint: "cancellations.list",
    params: { clubId, "order[createdAt]": "desc" },
    maxPages: 100,
  });

  const motives = await api.getJson("/referentials/cancellation_motives", {
    endpoint: "referentials.cancellationMotives",
  }).catch(() => null);
  const motiveNames = new Map(
    (motives?.["hydra:member"] ?? []).map((motive) => [
      motive["@id"], motive.name ?? motive.label ?? motive.wording ?? "",
    ]),
  );

  const eligible = [];
  for (const item of items) {
    const effective = item.cancellationDate?.slice(0, 10);
    if (!effective || effective < from || effective > to) continue;
    const subscription = await api.getSubscription(item.subscription, {
      contact: item.contact ?? item.contactId,
    });
    const motiveName = motiveNames.get(item.motive ?? item.cancellationMotive) ?? "";
    if (isEligibleCancellation(item, subscription, { from, to, enabledCodes: ENABLED_CODES, motiveName })) {
      eligible.push(item);
    }
  }

  return {
    consulta: "bajas",
    periodo: { desde: from, hasta: to },
    total: eligible.length,
  };
}

export async function facturacion(api, { clubId, from, to }) {
  const items = await collectPages(api, "/invoices", {
    endpoint: "invoices.list",
    params: { clubId, "order[createdAt]": "desc" },
    maxPages: 50,
  });

  const valid = items.filter((item) => {
    if (!isValidInvoice(item, { from })) return false;
    const day = item.createdAt?.slice(0, 10);
    return Boolean(day && day <= to);
  });

  const totalCents = valid.reduce((sum, item) => sum + Number(item.totalTI ?? 0), 0);
  return {
    consulta: "facturacion",
    periodo: { desde: from, hasta: to },
    facturas: valid.length,
    total: Math.round(totalCents) / 100,
    descartadas: items.length - valid.length,
  };
}

export async function incidencias(api, { clubId, from, to }) {
  const activas = await collectPages(api, "/subscriptions", {
    endpoint: "subscriptions.active",
    params: { "contact.clubId": clubId, "validFrom[before]": from, "order[validFrom]": "desc" },
  });
  const elegiblesActivas = activas.filter((item) =>
    isEligibleActiveMember(item, { from, to, enabledCodes: ENABLED_CODES }));

  const { eligible: altasDelPeriodo } = await membershipsInRange(api, { clubId, from, to });

  const desglose = (items, etiquetar) => {
    const personas = new Set();
    const estados = {};
    for (const item of items) {
      const label = etiquetar(item);
      if (!label) continue;
      const contact = contactOf(item);
      if (contact) personas.add(contact);
      estados[label] = (estados[label] ?? 0) + 1;
    }
    return { personas: personas.size, estados };
  };

  const pago = desglose(elegiblesActivas, paymentIssueLabel);
  const firma = desglose(altasDelPeriodo, signatureIssueLabel);

  return {
    consulta: "incidencias",
    periodo: { desde: from, hasta: to },
    pago: { total: pago.personas, estados: pago.estados },
    contratosNoFormalizados: { total: firma.personas, estados: firma.estados },
  };
}

export async function contacto(api, { clubId, termino }) {
  const needle = normalizeText(termino);
  const items = await collectPages(api, "/contacts", {
    endpoint: "contacts.list",
    params: { clubId, search: termino },
    maxPages: 3,
  });

  const coincide = items.filter((item) => {
    const campos = [item.firstname, item.lastname, item.email, item.phone]
      .filter(Boolean).map(normalizeText).join(" ");
    return campos.includes(needle);
  });

  return {
    consulta: "contacto",
    termino,
    total: coincide.length,
    // Devuelve lo justo para identificar a la persona en Resamania.
    resultados: coincide.slice(0, 20).map((item) => ({
      id: item["@id"] ?? item.id ?? null,
      nombre: [item.firstname, item.lastname].filter(Boolean).join(" ") || null,
      email: item.email ?? null,
    })),
  };
}

export async function resumen(api, opciones) {
  const [a, b, c, i] = await Promise.all([
    altas(api, opciones),
    bajas(api, opciones),
    activos(api, opciones),
    incidencias(api, opciones),
  ]);
  return {
    consulta: "resumen",
    periodo: a.periodo,
    altas: a.total,
    bajas: b.total,
    activos: c.total,
    incidenciasDePago: i.pago.total,
    contratosNoFormalizados: i.contratosNoFormalizados.total,
  };
}

export const CONSULTAS = {
  altas, bajas, activos, facturacion, incidencias, contacto, resumen,
};

export const NOMBRES_CONSULTA = Object.keys(CONSULTAS);
