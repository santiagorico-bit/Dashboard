import http from "node:http";
import { createPostgresStore } from "./sftp-postgres-store.js";

const store = createPostgresStore();

const clubNames = new Map([
  ["barcelona", "Barcelona Universitat"], ["madrid", "Madrid Delicias"],
  ["malaga-armengual", "Málaga Armengual"], ["malaga-soho", "Málaga Soho"],
  ["les-arts", "Valencia Les Arts"], ["nuevo-centro", "Valencia Nuevo Centro"], ["ruzafa", "Valencia Ruzafa"],
]);
const mappedClub = `CASE club_code WHEN 'BAR' THEN 'barcelona' WHEN 'OMD' THEN 'madrid' WHEN 'MGA' THEN 'malaga-armengual'
  WHEN 'MSO' THEN 'malaga-soho' WHEN 'VLA' THEN 'les-arts' WHEN 'ONC' THEN 'nuevo-centro' WHEN 'VAL' THEN 'ruzafa' END`;

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
    // Verified close shown in the production dashboard on October 8 at 23:26.
    membershipFrom: "2026-10-09",
    activeFrom: "2026-10-06",
    clubs: {
      madrid: { memberships: 176, members: 3764, businessThrough: "2026-10-07", billing: 70240.56, cancellations: 87,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 60 }, { tariff: "ON AIR Original", memberships: 30 }, { tariff: "ON AIR Original Web", memberships: 17 }, { tariff: "ON AIR Essential Web", memberships: 9 }, { tariff: "ON AIR Ultra", memberships: 7 }, { tariff: "Abono 1 Mes", memberships: 3 }, { tariff: "ON AIR Ultra Web", memberships: 1 }] },
      "les-arts": { memberships: 226, members: 3239, businessThrough: "2026-10-07", billing: 41517.38, cancellations: 54,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 59 }, { tariff: "ON AIR Original", memberships: 45 }, { tariff: "ON AIR Essential Web", memberships: 18 }, { tariff: "ON AIR Original Web", memberships: 11 }, { tariff: "Abono 1 Mes", memberships: 8 }, { tariff: "ON AIR Ultra Web", memberships: 4 }, { tariff: "ON AIR Ultra", memberships: 4 }, { tariff: "Abono 2 Meses", memberships: 1 }, { tariff: "Abono 3 Meses", memberships: 1 }] },
      "nuevo-centro": { memberships: 118, members: 2853, businessThrough: "2026-10-05", billing: 18167.68, cancellations: 51,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 26 }, { tariff: "ON AIR Original", memberships: 16 }, { tariff: "ON AIR Essential Web", memberships: 9 }, { tariff: "ON AIR Ultra", memberships: 3 }, { tariff: "Abono 1 Mes", memberships: 2 }, { tariff: "Abono 3 Meses", memberships: 1 }, { tariff: "ON AIR Original Web", memberships: 1 }] },
      ruzafa: { memberships: 139, members: 3700, businessThrough: "2026-10-05", billing: 28103.99, cancellations: 52,
        tariffs: [{ tariff: "ON AIR Essential", memberships: 33 }, { tariff: "ON AIR Original", memberships: 19 }, { tariff: "ON AIR Essential Web", memberships: 9 }, { tariff: "ON AIR Original Web", memberships: 7 }, { tariff: "Abono 1 Mes", memberships: 5 }, { tariff: "ON AIR Ultra Web", memberships: 4 }, { tariff: "ON AIR Ultra", memberships: 2 }] },
    },
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
        count(DISTINCT coalesce(contact_uid, external_uid)) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $1 || '%') memberships_month,
        count(DISTINCT coalesce(contact_uid, external_uid)) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $2 || '%') memberships_today,
        count(DISTINCT coalesce(contact_uid, external_uid)) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt') LIKE $3 || '%') memberships_yesterday,
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
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (
          WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') >= $4
            AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) <= $2
        ) starts,
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (
          WHERE coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') >= $4
            AND coalesce(payload->>'endedAt',payload->>'validUntil',payload->>'endAt',payload->>'endDate',payload->>'terminatedAt',payload->>'terminationDate','') <= $2
        ) ends,
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (
          WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') >= $5
            AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) <= $2
        ) active_starts,
        count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (
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
        coalesce(sum((nullif(payload->>'priceTE','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed'),0) billing_net,
        coalesce(sum((nullif(payload->>'priceTI','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed'),0) billing_gross,
        coalesce(sum((nullif(payload->>'priceTE','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $2 || '%' AND lower(coalesce(payload->>'invoice.state','completed'))='completed'),0) billing_today,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%') buyers,
        coalesce(sum((nullif(payload->>'priceTE','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100) FILTER (WHERE payload->>'invoice.generatedAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code',''))='merch'),0) merch,
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
        monthToDate: { memberships, members: activeMembers, cancellations, activeNet: memberships - cancellations, billing: number(row.billing_net), merch: number(row.merch), supplements: number(row.supplements), ties: 0, dayPasses: number(row.day_passes), memberCountBasis: baseline ? "resamania-close-plus-sftp-incremental" : "resamania-sftp", memberBaseline: baseline?.members, memberBaselineThrough: baseline ? "2026-10-05" : null, membershipBaselineThrough: baseline ? "2026-10-08" : null, memberIntradayAdditions: baseline ? number(row.active_cutover_starts) - number(row.active_cutover_ends) : 0, membershipTariffs: [], churnHistory: [] },
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

let liveMembershipCache = null;
let liveMembershipRefresh = null;
let liveBusinessCache = null;
let liveBusinessRefresh = null;
let liveAccessCache = null;
let liveAccessRefresh = null;

async function loadLiveMembershipRows() {
  if (liveMembershipCache && Date.now() - liveMembershipCache.at < 5 * 60_000) return liveMembershipCache.rows;
  if (liveMembershipRefresh) return liveMembershipRefresh;
  liveMembershipRefresh = (async () => {
  const today = madridDate();
  const month = today.slice(0, 7);
  const yesterday = madridDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000));
  const baselineConfig = cutoverBaselines[month];
  const membershipFrom = baselineConfig?.membershipFrom ?? `${month}-01`;
    const { rows } = await store.pool.query(`SELECT ${mappedClub} club,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),7)=$1) raw_month,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10)=$2) today,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10)=$3) yesterday,
    count(DISTINCT coalesce(contact_uid,external_uid)) FILTER (WHERE coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt','') >= $4 AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) <= $2) membership_starts
    FROM resamania_sftp_records
    WHERE entity='abonnements' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
      AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
      GROUP BY club`, [month, today, yesterday, membershipFrom]);
    liveMembershipCache = { at: Date.now(), rows };
    return rows;
  })().finally(() => { liveMembershipRefresh = null; });
  return liveMembershipRefresh;
}

async function withLiveMemberships(snapshots) {
  const today = madridDate();
  const month = today.slice(0, 7);
  const baselineConfig = cutoverBaselines[month];
  const rows = await loadLiveMembershipRows();
  const live = new Map(rows.map((row) => [row.club, row]));
  return snapshots.map((snapshot) => {
    const row = live.get(snapshot.club_code);
    if (!row) return snapshot;
    const baseline = baselineConfig?.clubs[snapshot.club_code];
    const memberships = baseline ? baseline.memberships + number(row.membership_starts) : number(row.raw_month);
    return { ...snapshot, collected_at: new Date().toISOString(), metrics: {
      ...snapshot.metrics,
      today: { ...snapshot.metrics?.today, memberships: number(row.today) },
      yesterday: { ...snapshot.metrics?.yesterday, memberships: number(row.yesterday) },
      monthToDate: { ...snapshot.metrics?.monthToDate, memberships,
        memberCountBasis: baseline ? "resamania-close-plus-sftp-incremental" : "resamania-sftp",
        membershipBaselineThrough: baseline ? "2026-10-08" : null },
    } };
  });
}

async function loadLiveBusinessRows() {
  if (liveBusinessCache && Date.now() - liveBusinessCache.at < 5 * 60_000) return liveBusinessCache.rows;
  if (liveBusinessRefresh) return liveBusinessRefresh;
  liveBusinessRefresh = (async () => {
    const today = madridDate();
    const month = today.slice(0, 7);
    const { rows } = await store.pool.query(`WITH mapped AS NOT MATERIALIZED (
      SELECT ${mappedClub} club,entity,external_uid,contact_uid,payload
      FROM resamania_sftp_records
      WHERE club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND entity IN ('factures','resiliations','abonnements')
    ), totals AS (
      SELECT club,
        coalesce(sum((nullif(payload->>'priceTI','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND payload->>'invoice.generatedAt' LIKE $1 || '%'
            AND left(payload->>'invoice.generatedAt',10) > CASE club WHEN 'madrid' THEN '2026-10-07' WHEN 'les-arts' THEN '2026-10-07' ELSE '2026-10-05' END
            AND lower(coalesce(payload->>'invoice.state','completed'))='completed'),0) billing_increment,
        coalesce(sum((nullif(payload->>'priceTI','')::numeric * coalesce(nullif(payload->>'quantity','')::numeric,1))/100)
          FILTER (WHERE entity='factures' AND left(payload->>'invoice.generatedAt',10)=$2 AND lower(coalesce(payload->>'invoice.state','completed'))='completed'),0) billing_today,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid',external_uid))
          FILTER (WHERE entity='resiliations' AND payload->>'cancellationDate' LIKE $1 || '%'
            AND left(payload->>'cancellationDate',10) > CASE club WHEN 'madrid' THEN '2026-10-07' WHEN 'les-arts' THEN '2026-10-07' ELSE '2026-10-05' END
            AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_increment,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid',external_uid))
          FILTER (WHERE entity='resiliations' AND left(payload->>'cancellationDate',10)=$2 AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_today
      FROM mapped GROUP BY club
    ), tariff_rows AS (
      SELECT club,coalesce(nullif(payload->>'product.name',''),nullif(payload->>'name',''),nullif(payload->>'offerName',''),nullif(payload->>'product.code',''),'Sin cuota clasificada') tariff,
        count(DISTINCT coalesce(contact_uid,external_uid))::int memberships
      FROM mapped WHERE entity='abonnements' AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),7)=$1
        AND left(coalesce(payload->>'startedAt',payload->>'validFrom',payload->>'createdAt',''),10) > CASE club WHEN 'madrid' THEN '2026-10-07' WHEN 'les-arts' THEN '2026-10-07' ELSE '2026-10-05' END
        AND lower(coalesce(payload->>'product.code',payload->>'productCode',payload->>'initialInfo.productCode','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)'
      GROUP BY club,2
    ), tariffs AS (
      SELECT club,jsonb_agg(jsonb_build_object('tariff',tariff,'memberships',memberships) ORDER BY memberships DESC) membership_tariffs
      FROM tariff_rows GROUP BY club
    ) SELECT t.*,f.membership_tariffs FROM totals t LEFT JOIN tariffs f USING(club)`, [month, today]);
    liveBusinessCache = { at: Date.now(), rows };
    return rows;
  })().catch((error) => {
    console.error(`Live business rollup pending: ${error.message}`);
    return liveBusinessCache?.rows ?? [];
  }).finally(() => { liveBusinessRefresh = null; });
  return liveBusinessRefresh;
}

async function loadLiveAccessRows() {
  if (liveAccessCache && Date.now() - liveAccessCache.at < 55 * 60_000) return liveAccessCache.rows;
  if (liveAccessRefresh) return liveAccessRefresh;
  liveAccessRefresh = (async () => {
    const month = madridDate().slice(0, 7);
    const { rows } = await store.pool.query(`SELECT ${mappedClub} club,
      count(DISTINCT external_uid)::int accesses_month,
      count(DISTINCT contact_uid)::int unique_visitors_month
      FROM resamania_sftp_records
      WHERE entity='passages' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        AND payload->>'createdAt' LIKE $1 || '%'
        AND lower(coalesce(payload->>'entryAuthorized','false'))='true'
        AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)'
        AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)'
      GROUP BY club`, [month]);
    liveAccessCache = { at: Date.now(), rows };
    return rows;
  })().catch((error) => {
    console.error(`Live access rollup pending: ${error.message}`);
    return liveAccessCache?.rows ?? [];
  }).finally(() => { liveAccessRefresh = null; });
  return liveAccessRefresh;
}

async function withLiveBusiness(snapshots) {
  const month = madridDate().slice(0, 7);
  void loadLiveBusinessRows();
  const live = new Map((liveBusinessCache?.rows ?? []).map((row) => [row.club, row]));
  void loadLiveAccessRows();
  const liveAccess = new Map((liveAccessCache?.rows ?? []).map((row) => [row.club, row]));
  return snapshots.map((snapshot) => {
    const row = live.get(snapshot.club_code) ?? {};
    const baseline = cutoverBaselines[month]?.clubs[snapshot.club_code];
    if (!baseline?.businessThrough) return snapshot;
    const memberships = number(snapshot.metrics?.monthToDate?.memberships);
    const tariffCounts = new Map();
    for (const item of [...(baseline.tariffs ?? []), ...(Array.isArray(row.membership_tariffs) ? row.membership_tariffs : [])]) {
      const tariff = String(item.tariff || "Sin cuota clasificada");
      tariffCounts.set(tariff, (tariffCounts.get(tariff) ?? 0) + number(item.memberships));
    }
    const tariffs = completeTariffCutover(
      [...tariffCounts].map(([tariff, memberships]) => ({ tariff, memberships })).sort((a,b) => b.memberships - a.memberships), memberships);
    const classified = tariffs.reduce((sum, item) => sum + number(item.memberships), 0);
    if (classified < memberships) tariffs.push({ tariff: "Sin cuota clasificada", memberships: memberships - classified });
    const cancellations = baseline.cancellations + number(row.cancellations_increment);
    const billing = baseline.billing + number(row.billing_increment);
    const activeMembers = number(snapshot.metrics?.monthToDate?.members);
    const accessRow = liveAccess.get(snapshot.club_code);
    const accesses = accessRow ? number(accessRow.accesses_month) : number(snapshot.metrics?.incidences?.accessesMonth);
    const uniqueVisitors = accessRow ? number(accessRow.unique_visitors_month) : number(snapshot.metrics?.incidences?.uniqueVisitorsMonth);
    return { ...snapshot, metrics: { ...snapshot.metrics,
      today: { ...snapshot.metrics?.today, cancellations: number(row.cancellations_today), revenue: number(row.billing_today), billing: number(row.billing_today) },
      monthToDate: { ...snapshot.metrics?.monthToDate, cancellations, activeNet: memberships - cancellations, billing, membershipTariffs: tariffs, tariffClassificationBasis: "cierre-resamania-reconciliado-con-incrementales-sftp", churnHistory: historicChurn(snapshot.club_code) },
      incidences: { ...snapshot.metrics?.incidences, pendingCancellationsThisMonth: cancellations, accessesMonth: accesses, uniqueVisitorsMonth: uniqueVisitors },
      commercial: { ...snapshot.metrics?.commercial,
        ticket: { ...snapshot.metrics?.commercial?.ticket, billing, billingTaxExcluded: billing,
          taxBasis: "Cierre Resamania + incrementales SFTP", collectedThrough: madridDate() } },
      retention: { active: { generatedAt: new Date().toISOString(), asOf: madridDate(), period: { from: `${month}-01`, to: madridDate(), mode: "current-month-hourly-sftp" }, criterion: "Socios activos y accesos autorizados recibidos por SFTP de Resamania", total: activeMembers, headlineMetric: { label: "Frecuencia media del mes", value: activeMembers ? accesses / activeMembers : 0 }, segments: [{ key: "active-base-current-month", label: "Base activa · mes en curso", members: activeMembers, averageAccesses: activeMembers ? accesses / activeMembers : 0, engagedMembers: uniqueVisitors, engagedPercentage: activeMembers ? uniqueVisitors / activeMembers * 100 : 0, zeroAccessMembers: Math.max(0, activeMembers - uniqueVisitors) }] } },
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
    if (request.method === "GET" && request.url?.split("?")[0] === "/diagnostics/membership-states") {
      const { rows } = await store.pool.query(`SELECT coalesce(payload->>'state',payload->>'status',payload->>'membership.state','(vacío)') state,count(*)::int
        FROM resamania_sftp_records
        WHERE entity='abonnements' AND club_code IN ('BAR','OMD','MGA','MSO','VLA','ONC','VAL')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 30`);
      response.end(JSON.stringify({ states: rows })); return;
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
      response.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      const current = await withLiveBusiness(await withLiveMemberships(await latestSnapshots()));
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
server.listen(port, "0.0.0.0", () => console.log(`KPI feed listening on ${port}`));
await importLegacyHistory();
setInterval(importLegacyHistory, 15 * 60_000).unref();
