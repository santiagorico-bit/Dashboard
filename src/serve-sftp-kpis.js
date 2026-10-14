import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createPostgresStore } from "./sftp-postgres-store.js";

const store = createPostgresStore();

const clubNames = new Map([
  ["barcelona", "Barcelona Universitat"], ["madrid", "Madrid Delicias"],
  ["malaga-armengual", "Málaga Armengual"], ["malaga-soho", "Málaga Soho"],
  ["les-arts", "Valencia Les Arts"], ["nuevo-centro", "Valencia Nuevo Centro"], ["ruzafa", "Valencia Ruzafa"],
]);
const expectedClubCodes = new Set(clubNames.keys());
const sourceClubCodes = new Map([
  ["barcelona", "BAR"], ["madrid", "OMD"], ["malaga-armengual", "MGA"],
  ["malaga-soho", "MSO"], ["les-arts", "VLA"], ["nuevo-centro", "ONC"], ["ruzafa", "VAL"],
]);
const privateFeedToken = process.env.KPI_PRIVATE_TOKEN ?? "";
const privateAuthorized = (request) => {
  if (!privateFeedToken) return false;
  const supplied = String(request.headers["x-private-token"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(privateFeedToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const assertCompleteClubRows = (rows, label) => {
  const received = new Set(rows.map((row) => row.club).filter(Boolean));
  const missing = [...expectedClubCodes].filter((club) => !received.has(club));
  if (missing.length) throw new Error(`${label} incompleto; faltan: ${missing.join(", ")}`);
};
const mappedClub = `CASE club_code WHEN 'BAR' THEN 'barcelona' WHEN 'OMD' THEN 'madrid' WHEN 'MGA' THEN 'malaga-armengual'
  WHEN 'MSO' THEN 'malaga-soho' WHEN 'VLA' THEN 'les-arts' WHEN 'ONC' THEN 'nuevo-centro' WHEN 'VAL' THEN 'ruzafa' END`;
const membershipProductCode = `lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode',''))`;
const canonicalMembershipTariff = `CASE ${membershipProductCode}
  WHEN 'cdi1' THEN 'ON AIR Essential'
  WHEN 'cdi2' THEN 'ON AIR Original'
  WHEN 'cdi3' THEN 'ON AIR Ultra'
  WHEN 'cdd1' THEN 'Abono 1 Semana'
  WHEN 'cdd2' THEN 'Abono 1 Mes'
  WHEN 'cdd3' THEN 'Abono 2 Meses'
  WHEN 'cdd4' THEN 'Abono 3 Meses'
  WHEN 'cdd5' THEN 'Abono 6 Meses'
  WHEN 'cdd6' THEN 'Abono 12 Meses'
  ELSE trim(coalesce(nullif(payload->>'product.name',''),nullif(payload->>'initialInfo.productName',''),nullif(payload->>'name',''),nullif(payload->>'offerName',''),nullif(payload->>'product.code',''),nullif(payload->>'productCode',''),nullif(payload->>'initialInfo.productCode',''),'Sin cuota clasificada'))
END`;
const taxExclusiveLinePrice = `coalesce(nullif(nullif(payload->>'priceTE','')::numeric,0),
  round(nullif(payload->>'priceTI','')::numeric /
    (1 + coalesce(nullif(payload->>'taxRate','')::numeric,0) / 10000)),0)`;
const taxInclusiveLinePrice = `coalesce(nullif(payload->>'priceTI','')::numeric,
  round(nullif(payload->>'priceTE','')::numeric *
    (1 + coalesce(nullif(payload->>'taxRate','')::numeric,0) / 10000)),0)`;
const paidInvoiceCondition = `lower(coalesce(payload->>'invoice.financialState',payload->>'financialState',''))='paid'
  AND lower(coalesce(payload->>'invoice.paymentsStatus',payload->>'paymentsStatus','paid'))='paid'`;
const invoiceDate = `coalesce(payload->>'invoice.generatedAt',payload->>'invoice.createdAt',payload->>'generatedAt',payload->>'createdAt','')`;
const invoiceState = `lower(coalesce(payload->>'invoice.state',payload->>'state','completed'))='completed'`;
const productCode = `lower(coalesce(payload->>'product.code',payload->>'code',payload->>'article.code',''))`;
const productName = `lower(coalesce(payload->>'product.name',payload->>'name',payload->>'article.name',''))`;

const madridDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(date);
const number = (value) => Number(value ?? 0);

const churnHistory = {
  madrid: [["2026-04",4.92,78,1585],["2026-05",4.97,113,2273],["2026-06",7.55,200,2649],["2026-07",7.79,224,2874],["2026-08",7.82,230,2940],["2026-09",7.39,235,3179]],
  "les-arts": [["2025-11",7.35,161,2189],["2025-12",9.5,218,2295],["2026-01",10.8,250,2315],["2026-02",10.23,259,2532],["2026-03",9.77,256,2619],["2026-04",9.76,257,2634],["2026-05",9.9,268,2707],["2026-06",13.04,351,2692],["2026-07",9.69,254,2620],["2026-08",10.3,266,2583],["2026-09",8.55,221,2586]],
  "nuevo-centro": [["2025-11",11.65,357,3065],["2025-12",12.24,366,2991],["2026-01",11,316,2874],["2026-02",11.27,337,2989],["2026-03",10.88,329,3023],["2026-04",11.97,353,2949],["2026-05",9.66,279,2889],["2026-06",12.98,369,2842],["2026-07",11.86,318,2682],["2026-08",9.96,252,2531],["2026-09",9.12,228,2501]],
  ruzafa: [["2025-11",10.69,372,3480],["2025-12",11.3,389,3441],["2026-01",10.78,356,3302],["2026-02",9.69,337,3478],["2026-03",10.13,362,3575],["2026-04",11.5,406,3530],["2026-05",11.59,410,3537],["2026-06",14.27,497,3484],["2026-07",12.99,441,3394],["2026-08",11.07,357,3225],["2026-09",10.4,336,3232]],
};
const historicChurn = (club) => (churnHistory[club] ?? []).map(([month,rate,cancellations,openingMembers]) => ({ month,rate,cancellations,openingMembers }));
const completeTariffCutover = (tariffs, target) => {
  const current = tariffs.reduce((sum, item) => sum + number(item.memberships), 0);
  const missing = Math.max(0, target - current);
  if (!missing || !current) return tariffs;
  const shares = tariffs.map((item, index) => {
    const exact = missing * number(item.memberships) / current;
    return { index, whole: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = missing - shares.reduce((sum, item) => sum + item.whole, 0);
  for (const item of [...shares].sort((a,b) => b.remainder - a.remainder)) {
    if (!left) break;
    item.whole += 1; left -= 1;
  }
  return tariffs.map((item, index) => ({ ...item, memberships: number(item.memberships) + shares[index].whole }));
};

// The SFTP feed started during October. Its INIT export contains the current
// membership state, not every sale that happened earlier in the month. Keep
// the last complete Resamania close as the cut-over baseline and apply only
// subsequent SFTP changes. From November onwards SFTP covers the full month.
const cutoverBaselines = {
  "2026-10": {
    // Authoritative Fitness KPI close captured after the end of October 12.
    membershipFrom: "2026-10-14",
    activeFrom: "2026-10-14",
    clubs: {
      madrid: { memberships: 194, members: 3718, membershipsYesterday: 12, accesses: 15030, businessThrough: "2026-10-13", billing: 67857, cancellations: 164, formulaChanges: 7,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 95 }, { tariff: "ON AIR Original", memberships: 43 }, { tariff: "ON AIR Original Web", memberships: 22 }, { tariff: "ON AIR Ultra", memberships: 11 }, { tariff: "Abono 1 Mes", memberships: 5 }, { tariff: "ON AIR Essential Web", memberships: 16 }, { tariff: "ON AIR Ultra Web", memberships: 2 }] },
      "les-arts": { memberships: 254, members: 3274, membershipsYesterday: 14, accesses: 12027, businessThrough: "2026-10-13", billing: 53652, cancellations: 141, formulaChanges: 6,
        tariffs: [{ tariff: "ON AIR Original", memberships: 66 }, { tariff: "ON AIR Essential", memberships: 97 }, { tariff: "ON AIR Original Web", memberships: 22 }, { tariff: "ON AIR Ultra", memberships: 14 }, { tariff: "Abono 1 Mes", memberships: 12 }, { tariff: "ON AIR Essential Web", memberships: 33 }, { tariff: "Abono 6 Meses", memberships: 1 }, { tariff: "ON AIR Ultra Web", memberships: 6 }, { tariff: "Abono 3 Meses", memberships: 1 }, { tariff: "Abono 2 Meses", memberships: 2 }] },
      "nuevo-centro": { memberships: 140, members: 2772, membershipsYesterday: 8, accesses: 7724, businessThrough: "2026-10-13", billing: 35915, cancellations: 163, formulaChanges: 6,
        // Resamania did not send an October INIT for invoice detail. Preserve
        // the validated Oct 1-6 commercial history, then add every paid SFTP
        // invoice received from the cut-over onwards.
        merchOpening: 236.71, dayPassOpening: 13,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 73 }, { tariff: "ON AIR Ultra", memberships: 3 }, { tariff: "ON AIR Essential Web", memberships: 20 }, { tariff: "ON AIR Original Web", memberships: 9 }, { tariff: "ON AIR Original", memberships: 28 }, { tariff: "Abono 1 Mes", memberships: 4 }, { tariff: "Abono 3 Meses", memberships: 1 }, { tariff: "ON AIR Ultra Web", memberships: 2 }] },
      ruzafa: { memberships: 168, members: 3625, membershipsYesterday: 18, accesses: 10295, businessThrough: "2026-10-13", billing: 57363, cancellations: 173, formulaChanges: 6,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 79 }, { tariff: "ON AIR Original", memberships: 36 }, { tariff: "Abono 1 Mes", memberships: 15 }, { tariff: "ON AIR Original Web", memberships: 15 }, { tariff: "ON AIR Essential Web", memberships: 18 }, { tariff: "Abono 3 Meses", memberships: 1 }, { tariff: "ON AIR Ultra", memberships: 2 }, { tariff: "ON AIR Ultra Web", memberships: 2 }] },
      "malaga-armengual": { memberships: 183, members: 3010, membershipsYesterday: 15, accesses: 9326, businessThrough: "2026-10-13", billing: 42971, cancellations: 109,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 52 }, { tariff: "ON AIR Original", memberships: 78 }, { tariff: "ON AIR Essential Web", memberships: 19 }, { tariff: "ON AIR Ultra Web", memberships: 7 }, { tariff: "Abono 1 Mes", memberships: 8 }, { tariff: "ON AIR Original Web", memberships: 12 }, { tariff: "ON AIR Ultra", memberships: 7 }] },
    },
  },
};

const billingCutoverBaselines = {
  "2026-10": {
    barcelona: { through: "2026-10-12", billing: 19805.06 },
    "malaga-armengual": { through: "2026-10-12", billing: 42971 },
  },
};

async function importLegacyHistory() {
  const endpoint = process.env.LEGACY_KPI_FEED_URL;
  if (!endpoint) return;
  try {
    const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}history=1`, { signal: AbortSignal.timeout(120_000), cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const clubs = (await response.json()).clubs ?? [];
    for (const row of clubs) {
      if (!clubNames.has(row.club_code) || !row.metrics) continue;
      await store.pool.query(`INSERT INTO club_kpi_snapshots(club_code,club_name,snapshot_date,collected_at,source,metrics)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [row.club_code, row.club_name ?? clubNames.get(row.club_code), row.snapshot_date, row.collected_at, row.source ?? "legacy-supabase", row.metrics]);
    }
    if (clubs.length) console.log(`Imported ${clubs.length} legacy KPI snapshots`);
  } catch (error) {
    console.error(`Legacy KPI import pending: ${error.message}`);
  }
}

async function aggregate() {
  const today = madridDate();
  const month = today.slice(0, 7);
  const yesterday = madridDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000));
  const { rows } = await store.pool.query(`
    WITH mapped AS NOT MATERIALIZED (
      SELECT ${mappedClub} club, entity, external_uid, contact_uid, payload, source_updated_at, source_deleted_at, ingested_at
      FROM resamania_sftp_records
      WHERE club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
    ), clubs AS (SELECT DISTINCT club FROM mapped WHERE club IS NOT NULL),
    memberships AS (
      SELECT club,
        count(DISTINCT external_uid) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $1 || '%') memberships_month,
        count(DISTINCT external_uid) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $2 || '%') memberships_today,
        count(DISTINCT external_uid) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $3 || '%') memberships_yesterday,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='abonnements'
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
        AND coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $1 || '%'
      GROUP BY club
    ), active_memberships AS (
      SELECT club, count(DISTINCT coalesce(contact_uid,external_uid)) active_members
      FROM mapped
      WHERE entity='abonnements' AND source_deleted_at IS NULL
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
        AND lower(coalesce(payload->>'state',payload->>'status',payload->>'membership.state','active')) !~ '(cancel|canceled|cancelled|resili|termin|ended|expired|inact)'
        AND coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'startAt',payload->>'startDate',payload->>'effectiveFrom',payload->>'createdAt','') <= $2
        AND (coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') = ''
          OR coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') >= $2)
      GROUP BY club
    ), post_cutover AS (
      SELECT club,
        count(DISTINCT external_uid) FILTER (
          WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') >= $4
            AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) <= $2
        ) starts,
        count(DISTINCT external_uid) FILTER (
          WHERE coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') >= $4
            AND coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') <= $2
        ) ends,
        count(DISTINCT external_uid) FILTER (
          WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') >= $5
            AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) <= $2
        ) active_starts,
        count(DISTINCT external_uid) FILTER (
          WHERE coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') >= $5
            AND coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') <= $2
        ) active_ends
      FROM mapped
      WHERE entity='abonnements'
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
      GROUP BY club
    ), cancellations AS (
      SELECT club, count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid')) FILTER (WHERE payload->>'cancellationDate' LIKE $1 || '%' AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_month,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid')) FILTER (WHERE payload->>'cancellationDate' LIKE $2 || '%' AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_today,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='resiliations' AND source_deleted_at IS NULL GROUP BY club
    ), invoices AS (
      SELECT club,
        coalesce(sum((${taxExclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed' AND ${paidInvoiceCondition}),0) billing_net,
        coalesce(sum((nullif(payload->>'priceTI','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed' AND ${paidInvoiceCondition}),0) billing_gross,
        coalesce(sum((${taxExclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $2 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed' AND ${paidInvoiceCondition}),0) billing_today,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND ${paidInvoiceCondition}) buyers,
        coalesce(sum((${taxInclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code',''))='merch'),0) merch,
        coalesce(sum((nullif(payload->>'priceTE','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code',''))~'(diet|supp|protein|nutrition)'),0) supplements,
        count(*) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code','')) IN ('sesion','session')) day_passes,
        coalesce(sum((nullif(payload->>'priceTE','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code',''))='fianza'),0) deposits,
        max(payload->>'invoice.generatedAt') collected_through, max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='factures' AND source_deleted_at IS NULL GROUP BY club
    ), funnel AS (
      SELECT club, count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'stateAfter',''))='prospect') visits,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'stateAfter',''))='client') conversions,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='contacts' AND source_deleted_at IS NULL GROUP BY club
    ), accesses AS (
      SELECT club, count(DISTINCT concat(contact_uid,':',left(payload->>'createdAt',10))) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'entryAuthorized','false'))='true' AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)' AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)') accesses_month,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'entryAuthorized','false'))='true' AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)' AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)') unique_visitors_month,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='passages' AND source_deleted_at IS NULL GROUP BY club
    )
    SELECT c.club, m.*, ac.active_members, pc.starts post_cutover_starts,pc.ends post_cutover_ends,pc.active_starts active_cutover_starts,pc.active_ends active_cutover_ends,x.cancellations_month,x.cancellations_today,i.billing_net,i.billing_gross,i.billing_today,i.buyers,i.merch,i.supplements,i.day_passes,i.deposits,i.collected_through,
      f.visits,f.conversions,a.accesses_month,a.unique_visitors_month,
      greatest(m.ingested_at,x.ingested_at,i.ingested_at,f.ingested_at,a.ingested_at) collected_at
    FROM clubs c LEFT JOIN memberships m USING(club) LEFT JOIN active_memberships ac USING(club) LEFT JOIN post_cutover pc USING(club) LEFT JOIN cancellations x USING(club) LEFT JOIN invoices i USING(club) LEFT JOIN funnel f USING(club) LEFT JOIN accesses a USING(club)
  `, [month, today, yesterday, cutoverBaselines[month]?.membershipFrom ?? `${month}-01`, cutoverBaselines[month]?.activeFrom ?? `${month}-01`]);

  return rows.map((row) => {
    const baseline = cutoverBaselines[month]?.clubs[row.club];
    const memberships = baseline
      ? baseline.memberships + number(row.post_cutover_starts)
      : number(row.memberships_month);
    const cancellations = number(row.cancellations_month);
    const visits = number(row.visits);
    const conversions = number(row.conversions) || memberships;
    const activeMembers = baseline
      ? baseline.members + number(row.active_cutover_starts) - number(row.active_cutover_ends)
      : number(row.active_members);
    const accesses = number(row.accesses_month);
    const uniqueVisitors = number(row.unique_visitors_month);
    const gross = number(row.billing_gross);
    const buyers = number(row.buyers);
    return {
      club_code: row.club, club_name: clubNames.get(row.club), snapshot_date: today,
      collected_at: row.collected_at ?? new Date().toISOString(), source: "resamania-sftp-render",
      metrics: {
        today: { memberships: number(row.memberships_today), cancellations: number(row.cancellations_today), revenue: number(row.billing_today), billing: number(row.billing_today) },
        yesterday: { memberships: number(row.memberships_yesterday) },
        monthToDate: { memberships, members: activeMembers, cancellations, activeNet: memberships - cancellations, billing: number(row.billing_net), merch: number(row.merch), supplements: number(row.supplements), ties: 0, dayPasses: number(row.day_passes), memberCountBasis: baseline ? "fitness-kpi-close-plus-sftp-incremental" : "resamania-sftp", memberBaseline: baseline?.members, memberBaselineThrough: baseline?.businessThrough ?? null, membershipBaselineThrough: baseline?.businessThrough ?? null, memberIntradayAdditions: baseline ? number(row.active_cutover_starts) - number(row.active_cutover_ends) : 0, membershipTariffs: [], churnHistory: [] },
        incidences: { accessesMonth: accesses, uniqueVisitorsMonth: uniqueVisitors },
        salesFunnel: { visits, conversions, conversionRate: visits ? conversions / visits * 100 : 0, spontaneousSales: 0 },
        membershipSources: [],
        commercial: { ticket: { billing: number(row.billing_net), billingTaxIncluded: gross, billingTaxExcluded: number(row.billing_net), taxBasis: "SFTP Resamania", collectedThrough: row.collected_through, buyers, average: buyers ? gross / buyers : 0, averageExcludingDeposit: buyers ? (gross - number(row.deposits)) / buyers : 0, deposit: { charged: number(row.deposits), returned: 0, netTaxExcluded: number(row.deposits), returnRate: 0 } }, salesFunnel: { visits, conversions, conversionRate: visits ? conversions / visits * 100 : 0, spontaneousSales: 0 }, membershipSources: [] },
        retention: { active: { generatedAt: row.collected_at, asOf: today, period: { from: `${month}-01`, to: today, mode: "current-month-hourly-sftp" }, criterion: "Socios activos y accesos recibidos por SFTP de Resamania", total: activeMembers, headlineMetric: { label: "Frecuencia media del mes", value: activeMembers ? accesses / activeMembers : 0 }, segments: [{ key: "active-base-current-month", label: "Base activa · mes en curso", members: activeMembers, averageAccesses: activeMembers ? accesses / activeMembers : 0, engagedMembers: uniqueVisitors, engagedPercentage: activeMembers ? uniqueVisitors / activeMembers * 100 : 0, zeroAccessMembers: Math.max(0, activeMembers - uniqueVisitors) }] } },
      },
    };
  });
}

async function persistCurrentSnapshot() {
  const clubs = await aggregate();
  assertCompleteClubRows(clubs, "Cierre SFTP");
  for (const row of clubs) {
    const metrics = row.metrics?.monthToDate ?? {};
    for (const field of ["memberships", "members", "cancellations", "billing"]) {
      if (!Number.isFinite(Number(metrics[field])) || Number(metrics[field]) < 0) {
        throw new Error(`Cierre SFTP inválido para ${row.club_code}: ${field}`);
      }
    }
  }
  const refreshedAt = new Date().toISOString();
  for (const row of clubs) await store.pool.query(`INSERT INTO club_kpi_snapshots(club_code,club_name,snapshot_date,collected_at,source,metrics)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [row.club_code, row.club_name, row.snapshot_date, refreshedAt, row.source, {
      ...row.metrics,
      sourceDataThrough: row.collected_at,
    }]);
}

let snapshotRefreshRunning = false;
let lastCompletedSync = null;
async function refreshAfterCompletedSync() {
  if (snapshotRefreshRunning) return;
  snapshotRefreshRunning = true;
  try {
    const { rows } = await store.pool.query(`SELECT completed_at
      FROM resamania_sync_runs WHERE status='completed' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`);
    const completedAt = rows[0]?.completed_at?.toISOString?.() ?? rows[0]?.completed_at ?? null;
    if (!completedAt || completedAt === lastCompletedSync) return;
    await persistCurrentSnapshot();
    lastCompletedSync = completedAt;
    console.log(`KPI snapshots refreshed after completed SFTP sync ${completedAt}`);
  } catch (error) {
    console.error(`KPI snapshot refresh pending: ${error.message}`);
  } finally {
    snapshotRefreshRunning = false;
  }
}

async function latestSnapshots() {
  const { rows } = await store.pool.query(`SELECT DISTINCT ON (club_code)
    club_code,club_name,snapshot_date::text,collected_at,source,metrics
    FROM club_kpi_snapshots
    ORDER BY club_code,snapshot_date DESC,collected_at DESC`);
  return rows;
}

const snapshotFallback = () => Object.entries(cutoverBaselines[madridDate().slice(0, 7)]?.clubs ?? {}).map(([club_code, baseline]) => ({
  club_code,
  club_name: clubNames.get(club_code),
  snapshot_date: baseline.businessThrough,
  collected_at: new Date().toISOString(),
  source: "fitness-kpi-close-fallback",
  metrics: {
    monthToDate: { memberships: baseline.memberships, members: baseline.members, billing: baseline.billing, membershipTariffs: baseline.tariffs },
    incidences: { accessesMonth: baseline.accesses },
    commercial: { ticket: { billing: baseline.billing, billingTaxExcluded: baseline.billing } },
  },
}));

async function latestSnapshotsFast() {
  try {
    return await Promise.race([
      latestSnapshots(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot query timeout")), 1500)),
    ]);
  } catch (error) {
    console.error(`Snapshot query pending: ${error.message}`);
    return snapshotFallback();
  }
}

let liveMembershipCache = null;
let liveMembershipRefresh = null;
let liveBusinessCache = null;
let liveBusinessRefresh = null;
let liveAccessCache = null;
let liveAccessRefresh = null;
let lastCompletedSyncAt = null;
let syncCacheRefresh = null;
let googleReviewsCache = new Map();

const googleReviewPages = new Map([
  ["barcelona", "https://www.onairfitness.es/clubes/barcelona-universitat/"],
  ["madrid", "https://www.onairfitness.es/clubes/madrid-delicias/"],
  ["malaga-armengual", "https://www.onairfitness.es/clubes/malaga-armengual/"],
  ["malaga-soho", "https://www.onairfitness.es/clubes/malaga-soho/"],
  ["les-arts", "https://www.onairfitness.es/clubes/valencia-les-arts/"],
  ["nuevo-centro", "https://www.onairfitness.es/clubes/valencia-nuevocentro/"],
  ["ruzafa", "https://www.onairfitness.es/clubes/valencia-ruzafa/"],
]);

async function refreshGoogleReviews() {
  const collectedAt = new Date().toISOString();
  const entries = await Promise.all([...googleReviewPages].map(async ([club, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "ON AIR KPI monitor/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const rating = Number(html.match(/class="rating"[^>]*>\s*<p>\s*([0-5](?:[.,]\d)?)/i)?.[1]?.replace(",", "."));
      const reviewCount = Number(html.match(/Calificaci[oó]n basada en\s*([\d.]+)\s*reseñas de Google/i)?.[1]?.replaceAll(".", ""));
      if (!Number.isFinite(rating) || !Number.isFinite(reviewCount)) return [club, null];
      return [club, { rating, reviewCount, collectedAt, source: "google_places" }];
    } catch (error) {
      console.error(`Google reviews pending for ${club}: ${error.message}`);
      return [club, googleReviewsCache.get(club) ?? null];
    }
  }));
  googleReviewsCache = new Map(entries);
}

async function loadLiveMembershipRows(force = false) {
  if (!force && liveMembershipCache && Date.now() - liveMembershipCache.at < 5 * 60_000) return liveMembershipCache.rows;
  if (liveMembershipRefresh) return liveMembershipRefresh;
  liveMembershipRefresh = (async () => {
  const today = madridDate();
  const month = today.slice(0, 7);
  const yesterday = madridDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000));
  const baselineConfig = cutoverBaselines[month];
  const membershipFrom = baselineConfig?.membershipFrom ?? `${month}-01`;
    const { rows } = await store.pool.query(`WITH mapped AS NOT MATERIALIZED (
      SELECT ${mappedClub} club,entity,external_uid,contact_uid,payload,source_deleted_at
      FROM resamania_sftp_records
      WHERE club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND entity='abonnements'
    ), membership_candidates AS (
      SELECT m.*,
        left(coalesce(m.payload->>'startedAt',m.payload->>'validFrom',m.payload->>'createdAt',''),10)::date started_date,
        ${membershipProductCode} product_code
      FROM mapped m
      WHERE m.entity='abonnements'
        AND m.source_deleted_at IS NULL
        AND ${membershipProductCode} <> 'cdd1'
        AND lower(coalesce(m.payload->>'product.code',m.payload->>'productCode',m.payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
    ), formula_changes AS (
      SELECT DISTINCT current.external_uid
      FROM membership_candidates current
      JOIN mapped previous
        ON previous.entity='abonnements'
       AND previous.club=current.club
       AND previous.contact_uid=current.contact_uid
       AND previous.external_uid<>current.external_uid
       AND previous.source_deleted_at IS NULL
      WHERE current.started_date >= $4::date
        AND nullif(left(coalesce(previous.payload->>'startedAt',previous.payload->>'validFrom',previous.payload->>'createdAt',''),10),'')::date < current.started_date
        AND coalesce(
          nullif(left(coalesce(previous.payload->>'terminatedAt',previous.payload->>'validThrough',previous.payload->>'endedAt',''),10),'')::date,
          '9999-12-31'::date
        ) >= current.started_date - 2
    ), memberships AS (
      SELECT current.*
      FROM membership_candidates current
      LEFT JOIN formula_changes previous USING(external_uid)
      WHERE previous.external_uid IS NULL
    ) SELECT club,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),7)=$1) raw_month,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE started_date=$2::date) today,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE started_date=$3::date) yesterday,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE started_date >= $4::date AND started_date <= $2::date) membership_starts,
    0::int baseline_free_weekly
    FROM memberships m GROUP BY club`, [month, today, yesterday, membershipFrom]);
    assertCompleteClubRows(rows, "Altas SFTP");
    liveMembershipCache = { at: Date.now(), rows };
    return rows;
  })().finally(() => { liveMembershipRefresh = null; });
  return liveMembershipRefresh;
}

async function withLiveMemberships(snapshots) {
  const today = madridDate();
  const month = today.slice(0, 7);
  const baselineConfig = cutoverBaselines[month];
  // The SFTP rollup scans the full export and can take several seconds on a
  // cold cache. Never block the KPI response on it; refresh it in the
  // background and use the last complete hourly result until it is ready.
  if (!liveMembershipCache || Date.now() - liveMembershipCache.at >= 5 * 60_000) {
    void loadLiveMembershipRows().catch((error) => console.error(`Live membership refresh pending: ${error.message}`));
  }
  const rows = liveMembershipCache?.rows ?? [];
  const live = new Map(rows.map((row) => [row.club, row]));
  return snapshots.map((snapshot) => {
    const row = live.get(snapshot.club_code);
    const baseline = baselineConfig?.clubs[snapshot.club_code];
    const isBaselineYesterday = Boolean(baseline?.businessThrough && baseline.businessThrough === madridDate(new Date(Date.now() - 86_400_000)));
    if (!row && !baseline) return snapshot;
    if (!row && baseline) return { ...snapshot, metrics: {
      ...snapshot.metrics,
      yesterday: { ...snapshot.metrics?.yesterday, memberships: baseline.membershipsYesterday },
      monthToDate: { ...snapshot.metrics?.monthToDate, memberships: baseline.memberships, members: baseline.members, membershipTariffs: baseline.tariffs, membershipBaselineThrough: baseline.businessThrough, memberBaselineThrough: baseline.businessThrough, membershipCountRule: "Fitness KPI close through prior day + SFTP valid starts after close; formula changes and one-week passes excluded" },
      incidences: { ...snapshot.metrics?.incidences, accessesMonth: baseline.accesses },
      commercial: { ...snapshot.metrics?.commercial, ticket: { ...snapshot.metrics?.commercial?.ticket, billing: baseline.billing, billingTaxExcluded: baseline.billing } },
    } };
    const memberships = baseline
      ? baseline.memberships + number(row.membership_starts)
      : number(row.raw_month);
    return { ...snapshot, collected_at: new Date().toISOString(), metrics: {
      ...snapshot.metrics,
      today: { ...snapshot.metrics?.today, memberships: number(row.today) },
      yesterday: { ...snapshot.metrics?.yesterday, memberships: isBaselineYesterday ? number(baseline.membershipsYesterday) : number(row.yesterday) },
      monthToDate: { ...snapshot.metrics?.monthToDate, memberships,
        sftpMembershipStarts: number(row.membership_starts),
        sftpExcludedFreeWeekly: number(row.baseline_free_weekly),
        membershipCountRule: "Fitness KPI close through prior day + SFTP valid starts after close; formula changes and one-week passes excluded",
        memberCountBasis: baseline ? "fitness-kpi-close-plus-sftp-incremental" : "resamania-sftp",
        membershipBaselineThrough: baseline?.businessThrough ?? null },
    } };
  });
}

async function loadLiveBusinessRows(force = false) {
  if (!force && liveBusinessCache && Date.now() - liveBusinessCache.at < 5 * 60_000) return liveBusinessCache.rows;
  if (liveBusinessRefresh) return liveBusinessRefresh;
  liveBusinessRefresh = (async () => {
    const today = madridDate();
    const month = today.slice(0, 7);
    const { rows } = await store.pool.query(`WITH mapped AS NOT MATERIALIZED (
      SELECT ${mappedClub} club,entity,external_uid,contact_uid,payload
      FROM resamania_sftp_records
      WHERE club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND entity IN ('factures','paiements','resiliations','abonnements')
    ), original_starts AS MATERIALIZED (
      SELECT club,contact_uid,external_uid,
        nullif(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),'')::date started_at
      FROM mapped
      WHERE entity='abonnements' AND contact_uid IS NOT NULL
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode',''))='cdi2'
        AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),7)=$1
        AND (club NOT IN ('madrid','les-arts','nuevo-centro','ruzafa')
          OR left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) > '2026-10-12')
    ), formula_change_totals AS (
      SELECT original.club,count(DISTINCT original.external_uid) formula_changes
      FROM original_starts original
      INNER JOIN mapped previous ON previous.club=original.club
        AND previous.contact_uid=original.contact_uid
        AND previous.entity='abonnements' AND previous.external_uid<>original.external_uid
        AND lower(coalesce(previous.payload->>'product.code',previous.payload->>'productCode',previous.payload->>'initialInfo.productCode',''))<>'cdi2'
        AND nullif(coalesce(previous.payload->>'startedAt',previous.payload->>'validFrom',previous.payload->>'createdAt',''),'')::date < original.started_at
        AND nullif(coalesce(previous.payload->>'terminatedAt',previous.payload->>'cancelledAt',previous.payload->>'validThrough',''),'')::date
          BETWEEN original.started_at - 7 AND original.started_at + 7
      GROUP BY original.club
    ), weekly_invoice_net AS (
      SELECT club,contact_uid,left(${invoiceDate},10)::date invoice_date,
        sum(coalesce(nullif(payload->>'priceTI','')::numeric,0)
          * coalesce(nullif(payload->>'quantity','')::numeric,1)) weekly_net
      FROM mapped
      WHERE entity='factures' AND ${invoiceDate} LIKE $1 || '%'
        AND ${invoiceState} AND ${paidInvoiceCondition} AND ${productCode}='cdd1'
      GROUP BY club,contact_uid,left(${invoiceDate},10)::date
    ), day_pass_invoice_lines AS (
      SELECT club,
        coalesce(nullif(payload->>'invoice.uid',''),nullif(payload->>'invoice.reference',''),
          nullif(payload->>'invoice.number',''),
          concat(coalesce(payload->>'invoice.generatedAt',''),':',coalesce(contact_uid,''))) invoice_key,
        bool_or(${productCode} IN ('sesion','session')
          AND ${productName}!~'(coaching|tie)'
          AND coalesce(nullif(payload->>'priceTI','')::numeric,0) > 0) has_day_pass,
        bool_or(
          ${productName}~'(descuento|discount|remise|geste|gesto|commercial)'
          OR ${productCode}~'(descuento|discount|remise|geste|gesto|commercial)'
          OR coalesce(nullif(payload->>'priceTI','')::numeric,0) < 0
        ) has_commercial_gesture,
        coalesce(sum(coalesce(nullif(payload->>'priceTI','')::numeric,0)
          * coalesce(nullif(payload->>'quantity','')::numeric,1))
          FILTER (WHERE ${productCode} IN ('sesion','session')),0) session_net
      FROM mapped
      WHERE entity='factures' AND ${invoiceDate} LIKE $1 || '%' AND ${invoiceState}
        AND ${paidInvoiceCondition}
      GROUP BY club,invoice_key
    ), day_pass_totals AS (
      SELECT club,count(*)::int day_passes
      FROM day_pass_invoice_lines
      WHERE has_day_pass AND NOT has_commercial_gesture AND session_net > 0
      GROUP BY club
    ), totals AS (
      SELECT club,
        coalesce(sum(coalesce(nullif(payload->>'amount','')::numeric,0) / 121)
          FILTER (WHERE entity='paiements' AND payload->>'createdAt' LIKE $1 || '%'
            AND coalesce(payload->>'canceledAt','')=''
            AND lower(coalesce(payload->>'incidentState','none')) IN ('none','closed')),0) billing_collected,
        coalesce(sum(coalesce(nullif(payload->>'amount','')::numeric,0) / 121)
          FILTER (WHERE entity='paiements' AND payload->>'createdAt' LIKE $1 || '%'
            AND left(payload->>'createdAt',10) > CASE WHEN club IN ('barcelona','malaga-armengual','madrid','les-arts','nuevo-centro','ruzafa') THEN '2026-10-12' ELSE '2026-10-05' END
            AND coalesce(payload->>'canceledAt','')=''
            AND lower(coalesce(payload->>'incidentState','none')) IN ('none','closed')),0) billing_collected_increment,
        coalesce(sum(coalesce(nullif(payload->>'amount','')::numeric,0) / 121)
          FILTER (WHERE entity='paiements' AND left(payload->>'createdAt',10)=$2
            AND coalesce(payload->>'canceledAt','')=''
            AND lower(coalesce(payload->>'incidentState','none')) IN ('none','closed')),0) billing_collected_today,
        coalesce(sum((${taxExclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND payload->>'invoice.generatedAt' LIKE $1 || '%'
            AND left(payload->>'invoice.generatedAt',10) > CASE WHEN club IN ('barcelona','malaga-armengual','madrid','les-arts','nuevo-centro','ruzafa') THEN '2026-10-12' ELSE '2026-10-05' END
            AND lower(coalesce(payload->>'invoice.state','completed'))='completed' AND ${paidInvoiceCondition}),0) billing_increment,
        coalesce(sum((${taxExclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND left(payload->>'invoice.generatedAt',10)=$2 AND lower(coalesce(payload->>'invoice.state','completed'))='completed' AND ${paidInvoiceCondition}),0) billing_today,
        coalesce(sum((${taxInclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND ${invoiceDate} LIKE $1 || '%' AND ${invoiceState}
            AND ${paidInvoiceCondition} AND ${productCode}='merch'),0) merch,
        coalesce(sum((${taxExclusiveLinePrice} * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND ${invoiceDate} LIKE $1 || '%' AND ${invoiceState} AND ${paidInvoiceCondition}
            AND (${productCode} IN ('prot','supp','nutrition') OR ${productName}~'(protein|prote[ií]na|creatina|pre.?workout|pre.?entreno|bcaa|col[aá]geno|magnesio|vitamina|barrita|shot|whey|peanut|rice flour)')),0) supplements,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid',external_uid))
          FILTER (WHERE entity='resiliations' AND payload->>'cancellationDate' LIKE $1 || '%'
            AND left(payload->>'cancellationDate',10) > CASE WHEN club IN ('malaga-armengual','madrid','les-arts','nuevo-centro','ruzafa') THEN '2026-10-12' ELSE '2026-10-05' END
            AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_increment,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid',external_uid))
          FILTER (WHERE entity='resiliations' AND left(payload->>'cancellationDate',10)=$2 AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_today
      FROM mapped GROUP BY club
    ), tariff_contacts AS (
      SELECT DISTINCT ON (club,external_uid)
        club,external_uid membership_key,${canonicalMembershipTariff} tariff
      FROM mapped WHERE entity='abonnements' AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),7)=$1
        AND (club NOT IN ('malaga-armengual','madrid','les-arts','nuevo-centro','ruzafa')
          OR left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) > '2026-10-12')
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
        AND NOT (lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode',''))='cdd1'
          AND EXISTS (SELECT 1 FROM weekly_invoice_net w
            WHERE w.club=mapped.club AND w.contact_uid=mapped.contact_uid
              AND w.invoice_date BETWEEN left(coalesce(mapped.payload->>'startedAt',mapped.payload->>'validFrom',mapped.payload->>'createdAt',''),10)::date - 2
                AND left(coalesce(mapped.payload->>'startedAt',mapped.payload->>'validFrom',mapped.payload->>'createdAt',''),10)::date + 2
              AND w.weekly_net <= 0))
      ORDER BY club,external_uid,coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') DESC
    ), tariff_rows AS (
      SELECT club,tariff,count(*)::int memberships
      FROM tariff_contacts GROUP BY club,tariff
    ), tariffs AS (
      SELECT club,jsonb_agg(jsonb_build_object('tariff',tariff,'memberships',memberships) ORDER BY memberships DESC) membership_tariffs
      FROM tariff_rows GROUP BY club
    ) SELECT t.*,coalesce(dp.day_passes,0) day_passes,coalesce(fc.formula_changes,0) formula_changes,f.membership_tariffs
      FROM totals t LEFT JOIN day_pass_totals dp USING(club)
      LEFT JOIN formula_change_totals fc USING(club) LEFT JOIN tariffs f USING(club)`, [month, today]);
    assertCompleteClubRows(rows, "Negocio SFTP");
    liveBusinessCache = { at: Date.now(), rows };
    return rows;
  })().catch((error) => {
    console.error(`Live business rollup pending: ${error.message}`);
    return liveBusinessCache?.rows ?? [];
  }).finally(() => { liveBusinessRefresh = null; });
  return liveBusinessRefresh;
}

async function loadLiveAccessRows(force = false) {
  if (!force && liveAccessCache && Date.now() - liveAccessCache.at < 55 * 60_000) return liveAccessCache.rows;
  if (liveAccessRefresh) return liveAccessRefresh;
  liveAccessRefresh = (async () => {
    const month = madridDate().slice(0, 7);
    const { rows } = await store.pool.query(`WITH access_totals AS (
      SELECT ${mappedClub} club,count(DISTINCT external_uid)::int accesses_month,
        count(DISTINCT external_uid) FILTER (WHERE left(payload->>'createdAt',10) > '2026-10-12')::int accesses_increment,
        count(DISTINCT contact_uid)::int unique_visitors_month
      FROM resamania_sftp_records
      WHERE entity='passages' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND payload->>'createdAt' LIKE $1 || '%'
        AND lower(coalesce(payload->>'entryAuthorized','false'))='true'
        AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)'
        AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)'
      GROUP BY 1
    ), cancellation_contacts AS (
      SELECT club_code,contact_uid
      FROM resamania_sftp_records
      WHERE entity='resiliations' AND source_deleted_at IS NULL
        AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND payload->>'cancellationDate' LIKE $1 || '%'
        AND lower(coalesce(payload->>'state','accepted'))='accepted'
      GROUP BY 1,2
    ), cancellation_accesses AS (
      SELECT ${mappedClub.replaceAll("club_code", "c.club_code")} club,avg(p.accesses) average_cancellation_accesses
      FROM cancellation_contacts c CROSS JOIN LATERAL (
        SELECT count(DISTINCT external_uid)::numeric accesses FROM resamania_sftp_records p
        WHERE p.entity='passages' AND p.club_code=c.club_code AND p.contact_uid=c.contact_uid
          AND p.payload->>'createdAt' LIKE $1 || '%'
          AND lower(coalesce(p.payload->>'entryAuthorized','false'))='true'
          AND lower(coalesce(p.payload->>'entryReason',''))!~'(exit|sortie)'
          AND lower(coalesce(p.payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)'
      ) p GROUP BY 1
    ) SELECT a.*,c.average_cancellation_accesses FROM access_totals a LEFT JOIN cancellation_accesses c USING(club)`, [month]);
    assertCompleteClubRows(rows, "Accesos SFTP");
    liveAccessCache = { at: Date.now(), rows };
    return rows;
  })().catch((error) => {
    console.error(`Live access rollup pending: ${error.message}`);
    return liveAccessCache?.rows ?? [];
  }).finally(() => { liveAccessRefresh = null; });
  return liveAccessRefresh;
}

async function refreshCachesAfterSftpSync() {
  if (syncCacheRefresh) return syncCacheRefresh;
  syncCacheRefresh = (async () => {
    const { rows } = await store.pool.query(`SELECT completed_at::text completed_at
      FROM resamania_sync_runs
      WHERE status IN ('completed','partial') AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`);
    const completedAt = rows[0]?.completed_at ?? null;
    if (!completedAt || completedAt === lastCompletedSyncAt) return;
    await Promise.all([
      loadLiveMembershipRows(true),
      loadLiveBusinessRows(true),
      loadLiveAccessRows(true),
    ]);
    lastCompletedSyncAt = completedAt;
    console.log(`KPI caches refreshed after SFTP sync ${completedAt}`);
  })().catch((error) => {
    console.error(`SFTP cache refresh pending: ${error.message}`);
  }).finally(() => { syncCacheRefresh = null; });
  return syncCacheRefresh;
}

async function withLiveBusiness(snapshots) {
  const month = madridDate().slice(0, 7);
  if (!liveBusinessCache || Date.now() - liveBusinessCache.at >= 5 * 60_000) {
    void loadLiveBusinessRows().catch((error) => console.error(`Live business refresh pending: ${error.message}`));
  }
  if (!liveAccessCache || Date.now() - liveAccessCache.at >= 5 * 60_000) {
    void loadLiveAccessRows().catch((error) => console.error(`Live access refresh pending: ${error.message}`));
  }
  const live = new Map((liveBusinessCache?.rows ?? []).map((row) => [row.club, row]));
  const liveAccess = new Map((liveAccessCache?.rows ?? []).map((row) => [row.club, row]));
  return snapshots.map((snapshot) => {
    const row = live.get(snapshot.club_code);
    // Never replace a valid, persisted snapshot with a partial rollup. A
    // completed seven-club batch is required before live business values win.
    const baseline = cutoverBaselines[month]?.clubs[snapshot.club_code];
    if (!row && !baseline) return snapshot;
    if (!row && baseline) return { ...snapshot, metrics: {
      ...snapshot.metrics,
      monthToDate: { ...snapshot.metrics?.monthToDate, billing: baseline.billing, billingBasis: "fitness-kpi-close-fallback", billingBaselineThrough: baseline.businessThrough },
      commercial: { ...snapshot.metrics?.commercial, ticket: { ...snapshot.metrics?.commercial?.ticket, billing: baseline.billing, billingTaxExcluded: baseline.billing, taxBasis: "Fitness KPI validated close" } },
    } };
    const billingBaseline = baseline?.businessThrough
      ? { through: baseline.businessThrough, billing: baseline.billing }
      : billingCutoverBaselines[month]?.[snapshot.club_code];
    const memberships = number(snapshot.metrics?.monthToDate?.memberships);
    const tariffCounts = new Map();
    for (const item of [...(baseline?.tariffs ?? []), ...(Array.isArray(row.membership_tariffs) ? row.membership_tariffs : [])]) {
      const tariff = String(item.tariff || "Sin cuota clasificada");
      tariffCounts.set(tariff, (tariffCounts.get(tariff) ?? 0) + number(item.memberships));
    }
    const tariffs = completeTariffCutover(
      [...tariffCounts].map(([tariff, memberships]) => ({ tariff, memberships })).sort((a,b) => b.memberships - a.memberships), memberships);
    const classified = tariffs.reduce((sum, item) => sum + number(item.memberships), 0);
    if (classified < memberships) tariffs.push({ tariff: "Sin cuota clasificada", memberships: memberships - classified });
    if (!baseline?.businessThrough) {
      const billing = Math.round((billingBaseline
        ? number(billingBaseline.billing) + number(row.billing_collected_increment)
        : number(row.billing_collected)) * 100) / 100;
      return { ...snapshot, snapshot_date: madridDate(), collected_at: new Date().toISOString(), metrics: { ...snapshot.metrics,
      monthToDate: { ...snapshot.metrics?.monthToDate, billing, merch: number(row.merch), supplements: number(row.supplements),
        dayPasses: number(row.day_passes), formulaChanges: number(row.formula_changes), membershipTariffs: tariffs,
        merchBasis: "facturas-cobradas-sftp-con-iva",
        dayPassBasis: "facturas-cobradas-sftp-sin-gesto-comercial",
        billingBasis: billingBaseline ? "cierre-validado-mas-cobros-sftp" : "cobros-efectivos-sftp-sin-iva",
        billingBaselineThrough: billingBaseline?.through ?? null,
        tariffClassificationBasis: "resamania-sftp-normalizado" },
      today: { ...snapshot.metrics?.today, revenue: number(row.billing_collected_today), billing: number(row.billing_collected_today) },
      commercial: { ...snapshot.metrics?.commercial,
        ticket: { ...snapshot.metrics?.commercial?.ticket, billing, billingTaxExcluded: billing,
          taxBasis: "Cobros efectivos SFTP sin IVA; anulados e incidencias abiertas excluidos", collectedThrough: madridDate() } },
      googleReviews: googleReviewsCache.get(snapshot.club_code) ?? snapshot.metrics?.googleReviews ?? null,
    } };
    }
    const cancellations = baseline.cancellations + number(row.cancellations_increment);
    const billing = Math.round((number(baseline.billing) + number(row.billing_collected_increment)) * 100) / 100;
    const activeMembers = number(baseline.members)
      + (memberships - number(baseline.memberships))
      - (cancellations - number(baseline.cancellations));
    const accessRow = liveAccess.get(snapshot.club_code);
    const accesses = accessRow
      ? number(baseline.accesses) + number(accessRow.accesses_increment)
      : number(snapshot.metrics?.incidences?.accessesMonth);
    const uniqueVisitors = accessRow ? number(accessRow.unique_visitors_month) : number(snapshot.metrics?.incidences?.uniqueVisitorsMonth);
    const cancellationAverageAccesses = accessRow ? number(accessRow.average_cancellation_accesses) : null;
    const cancellationSeries = [...historicChurn(snapshot.club_code), {
      month, cancellations, openingMembers: baseline.members,
      rate: baseline.members ? cancellations / baseline.members * 100 : 0, averageAccesses: cancellationAverageAccesses,
    }];
    return { ...snapshot, snapshot_date: madridDate(), collected_at: new Date().toISOString(), metrics: { ...snapshot.metrics,
      today: { ...snapshot.metrics?.today, cancellations: number(row.cancellations_today), revenue: number(row.billing_collected_today), billing: number(row.billing_collected_today) },
      monthToDate: { ...snapshot.metrics?.monthToDate, members: activeMembers, cancellations, activeNet: memberships - cancellations, billing,
        billingBasis: "cierre-validado-mas-cobros-sftp", billingBaselineThrough: baseline.businessThrough,
        merch: Math.round((number(baseline.merchOpening) + number(row.merch)) * 100) / 100,
        supplements: number(row.supplements),
        dayPasses: number(baseline.dayPassOpening) + number(row.day_passes),
        merchBasis: baseline.merchOpening == null ? "facturas-cobradas-sftp-con-iva" : "historico-resamania-mas-facturas-cobradas-sftp-con-iva",
        dayPassBasis: baseline.dayPassOpening == null ? "facturas-cobradas-sftp-sin-gesto-comercial" : "historico-resamania-mas-facturas-cobradas-sftp-sin-gesto-comercial",
        formulaChanges: number(baseline.formulaChanges) + number(row.formula_changes),
        formulaChangeBasis: baseline.formulaChanges == null ? "resamania-sftp" : "cierre-resamania-mas-incrementales-sftp",
        membershipTariffs: tariffs, tariffClassificationBasis: "cierre-resamania-reconciliado-con-incrementales-sftp", churnHistory: historicChurn(snapshot.club_code) },
      incidences: { ...snapshot.metrics?.incidences, pendingCancellationsThisMonth: cancellations, accessesMonth: accesses, uniqueVisitorsMonth: uniqueVisitors },
      commercial: { ...snapshot.metrics?.commercial,
        ticket: { ...snapshot.metrics?.commercial?.ticket, billing, billingTaxExcluded: billing,
          taxBasis: "Cobros efectivos SFTP sin IVA; anulados e incidencias abiertas excluidos", collectedThrough: madridDate() } },
      retention: {
        active: { generatedAt: new Date().toISOString(), asOf: madridDate(), period: { from: `${month}-01`, to: madridDate(), mode: "current-month-hourly-sftp" }, criterion: "Socios activos y accesos autorizados recibidos por SFTP de Resamania", total: activeMembers, headlineMetric: { label: "Frecuencia media del mes", value: activeMembers ? accesses / activeMembers : 0 }, segments: [{ key: "active-base-current-month", label: "Base activa · mes en curso", members: activeMembers, averageAccesses: activeMembers ? accesses / activeMembers : 0, engagedMembers: uniqueVisitors, engagedPercentage: activeMembers ? uniqueVisitors / activeMembers * 100 : 0, zeroAccessMembers: Math.max(0, activeMembers - uniqueVisitors) }] },
        cancellations: { generatedAt: new Date().toISOString(), asOf: madridDate(), period: { mode: "monthly_history", from: cancellationSeries[0]?.month ?? month, to: month }, criterion: "Bajas efectivas mensuales recibidas por Resamania; histórico validado y mes actual incremental SFTP", total: cancellationSeries.reduce((sum,item) => sum + number(item.cancellations), 0), headlineMetric: { label: `Churn ${month}`, value: baseline.members ? cancellations / baseline.members * 100 : 0, suffix: "%" }, segments: cancellationSeries.map((item) => ({ key: item.month, label: item.month, cancellations: item.cancellations, percentage: item.rate, averageAccesses: item.averageAccesses ?? null })) },
      },
      googleReviews: googleReviewsCache.get(snapshot.club_code) ?? snapshot.metrics?.googleReviews ?? null,
    } };
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  try {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      response.end(JSON.stringify({ ok: true, service: "onair-kpi-feed", at: new Date().toISOString() })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/private/signups") {
      response.setHeader("cache-control", "private, no-store");
      if (!privateAuthorized(request)) {
        response.statusCode = 401; response.end(JSON.stringify({ error: "Unauthorized" })); return;
      }
      const url = new URL(request.url, "http://localhost");
      const club = url.searchParams.get("club") ?? "";
      const month = url.searchParams.get("month") ?? madridDate().slice(0, 7);
      if (!expectedClubCodes.has(club) || !/^\d{4}-\d{2}$/.test(month)) {
        response.statusCode = 400; response.end(JSON.stringify({ error: "Invalid club or month" })); return;
      }
      const sourceClub = sourceClubCodes.get(club);
      const { rows } = await store.pool.query(`WITH memberships AS (
        SELECT DISTINCT ON (current.external_uid) current.external_uid,current.contact_uid,current.payload,
          coalesce(current.payload->>'startedAt',current.payload->>'validFrom',current.payload->>'createdAt','') started_at,
          ${canonicalMembershipTariff.replaceAll("payload", "current.payload")} tariff
        FROM resamania_sftp_records current
        WHERE current.entity='abonnements' AND current.club_code=$1
          AND current.source_deleted_at IS NULL
          AND coalesce(current.payload->>'startedAt',current.payload->>'validFrom',current.payload->>'createdAt','') LIKE $2 || '%'
          AND ${membershipProductCode.replaceAll("payload", "current.payload")} <> 'cdd1'
          AND ${membershipProductCode.replaceAll("payload", "current.payload")} !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
          AND NOT EXISTS (
            SELECT 1 FROM resamania_sftp_records previous
            WHERE previous.entity='abonnements'
              AND previous.club_code=current.club_code
              AND previous.contact_uid=current.contact_uid
              AND previous.external_uid<>current.external_uid
              AND previous.source_deleted_at IS NULL
              AND nullif(left(coalesce(previous.payload->>'startedAt',previous.payload->>'validFrom',previous.payload->>'createdAt',''),10),'')::date
                < nullif(left(coalesce(current.payload->>'startedAt',current.payload->>'validFrom',current.payload->>'createdAt',''),10),'')::date
              AND coalesce(
                nullif(left(coalesce(previous.payload->>'terminatedAt',previous.payload->>'validThrough',previous.payload->>'endedAt',''),10),'')::date,
                '9999-12-31'::date
              ) >= nullif(left(coalesce(current.payload->>'startedAt',current.payload->>'validFrom',current.payload->>'createdAt',''),10),'')::date - 2
          )
        ORDER BY current.external_uid,coalesce(current.source_updated_at,current.ingested_at) DESC
      ), free_weekly AS (
        SELECT DISTINCT contact_uid FROM resamania_sftp_records
        WHERE entity='factures' AND club_code=$1
          AND ${productCode}='cdd1' AND ${invoiceDate} LIKE $2 || '%'
          AND ${invoiceState} AND ${paidInvoiceCondition}
          AND coalesce(${taxExclusiveLinePrice},0) <= 0
      ), contacts AS (
        SELECT DISTINCT ON (external_uid) external_uid,payload
        FROM resamania_sftp_records WHERE entity='contacts' AND club_code=$1
        ORDER BY external_uid,coalesce(source_updated_at,ingested_at) DESC
      )
      SELECT m.external_uid id,m.contact_uid,m.started_at,m.tariff,
        coalesce(c.payload->>'firstName','') first_name,
        coalesce(c.payload->>'lastName','') last_name,
        coalesce(c.payload->>'email','') email
      FROM memberships m LEFT JOIN contacts c ON c.external_uid=m.contact_uid
      WHERE NOT (${membershipProductCode.replaceAll("payload", "m.payload")}='cdd1' AND EXISTS (
        SELECT 1 FROM free_weekly f WHERE f.contact_uid=m.contact_uid
      )) ORDER BY m.started_at DESC,m.external_uid`, [sourceClub, month]);
      response.end(JSON.stringify({ club, month, signups: rows.map((row) => ({
        id: row.id, contactUid: row.contact_uid, firstName: row.first_name, lastName: row.last_name,
        email: row.email, tariff: row.tariff, startedAt: row.started_at,
        resamaniaUrl: `https://app.resamania.com/onairespana/-/management/contacts/${encodeURIComponent(String(row.contact_uid).replace(/^.*\//, ""))}`,
      })) })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/membership-states") {
      const { rows } = await store.pool.query(`SELECT coalesce(payload->>'state',payload->>'status',payload->>'membership.state','(vacío)') state,count(*)::int
        FROM resamania_sftp_records
        WHERE entity='abonnements' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 30`);
      response.end(JSON.stringify({ states: rows })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/payment-fields") {
      const { rows: fields } = await store.pool.query(`SELECT field,count(*)::int rows,
          count(*) FILTER (WHERE value <> '')::int populated
        FROM resamania_sftp_records r
        CROSS JOIN LATERAL jsonb_each_text(r.payload) p(field,value)
        WHERE r.entity='paiements'
        GROUP BY field ORDER BY field`);
      const { rows: coverage } = await store.pool.query(`SELECT club_code,${mappedClub} club,count(*)::int rows,
          min(occurred_at) first_payment,max(occurred_at) last_payment
        FROM resamania_sftp_records
        WHERE entity='paiements' AND source_deleted_at IS NULL
        GROUP BY club_code,2 ORDER BY club_code`);
      const { rows: states } = await store.pool.query(`SELECT
          coalesce(payload->>'incidentState','(vacío)') incident_state,
          (coalesce(payload->>'canceledAt','') <> '') canceled,
          count(*)::int rows,
          sum(coalesce(nullif(payload->>'amount','')::numeric,0)) amount
        FROM resamania_sftp_records
        WHERE entity='paiements' AND source_deleted_at IS NULL
        GROUP BY 1,2 ORDER BY 1,2`);
      response.end(JSON.stringify({ fields, coverage, states })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/membership-fields") {
      const { rows } = await store.pool.query(`SELECT field, array_agg(DISTINCT value ORDER BY value) FILTER (WHERE value <> '') values
        FROM resamania_sftp_records r
        CROSS JOIN LATERAL jsonb_each_text(r.payload) p(field,value)
        WHERE r.entity='abonnements'
          AND lower(field) ~ '(state|status|etat|active|start|end|debut|fin|date|product|produit|formula|formule)'
        GROUP BY field ORDER BY field`);
      response.end(JSON.stringify({ fields: rows })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/membership-counts") {
      const month = madridDate().slice(0, 7);
      const { rows } = await store.pool.query(`SELECT club_code, ${mappedClub} club,
        count(*) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%') created_rows,
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%') created_contacts,
        count(*) FILTER (WHERE payload->>'startedAt' LIKE $1 || '%') started_rows,
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE payload->>'startedAt' LIKE $1 || '%') started_contacts
        FROM resamania_sftp_records
        WHERE entity='abonnements'
          AND lower(coalesce(payload->>'product.code','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
        GROUP BY 1,2 ORDER BY 1`, [month]);
      response.end(JSON.stringify({ month, clubs: rows })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/membership-daily") {
      const month = madridDate().slice(0, 7);
      const { rows } = await store.pool.query(`WITH eligible AS (
        SELECT ${mappedClub} club, coalesce(contact_uid,external_uid) membership,
          left(coalesce(payload->>'createdAt',''),10) created_date,
          left(coalesce(payload->>'startedAt',''),10) started_date,
          left(coalesce(payload->>'validFrom',''),10) valid_from_date
        FROM resamania_sftp_records
        WHERE entity='abonnements' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
          AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
      ), dates AS (
        SELECT club, created_date event_date, 'createdAt' field, count(DISTINCT membership)::int total FROM eligible WHERE created_date LIKE $1 || '%' GROUP BY 1,2
        UNION ALL SELECT club, started_date, 'startedAt', count(DISTINCT membership)::int FROM eligible WHERE started_date LIKE $1 || '%' GROUP BY 1,2
        UNION ALL SELECT club, valid_from_date, 'validFrom', count(DISTINCT membership)::int FROM eligible WHERE valid_from_date LIKE $1 || '%' GROUP BY 1,2
      ) SELECT * FROM dates ORDER BY club,field,event_date`, [month]);
      response.end(JSON.stringify({ month, clubs: rows })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/club-kpis") {
      // The process keeps its own short-lived database rollup cache. Do not let
      // browsers or intermediate CDNs retain an older KPI snapshot on top of it.
      response.setHeader("cache-control", "no-store, max-age=0");
      const current = await withLiveBusiness(await withLiveMemberships(await latestSnapshotsFast()));
      const historyRequested = new URL(request.url, "http://localhost").searchParams.get("history") === "1";
      if (!historyRequested) { response.end(JSON.stringify({ clubs: current })); return; }
      const { rows: history } = await store.pool.query(`SELECT club_code,club_name,snapshot_date::text,collected_at,source,metrics
        FROM club_kpi_snapshots ORDER BY snapshot_date DESC,collected_at DESC LIMIT 3000`);
      response.end(JSON.stringify({ clubs: [...current, ...history] })); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    console.error(error); response.statusCode = 500; response.end(JSON.stringify({ error: "KPI feed unavailable" }));
  }
});

const port = Number(process.env.PORT || 10000);
void refreshGoogleReviews();
setInterval(() => void refreshGoogleReviews(), 7 * 24 * 60 * 60_000).unref();
void refreshCachesAfterSftpSync();
setInterval(() => void refreshCachesAfterSftpSync(), 15_000).unref();
server.listen(port, "0.0.0.0", () => console.log(`KPI feed listening on ${port}`));
await importLegacyHistory();
setInterval(importLegacyHistory, 15 * 60_000).unref();
