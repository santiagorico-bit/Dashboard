import http from "node:http";
import { createPostgresStore } from "./sftp-postgres-store.js";

const store = createPostgresStore();
await store.initialize();

const clubNames = new Map([
  ["barcelona", "Barcelona Universitat"], ["madrid", "Madrid Delicias"],
  ["malaga-armengual", "Málaga Armengual"], ["malaga-soho", "Málaga Soho"],
  ["les-arts", "Valencia Les Arts"], ["nuevo-centro", "Valencia Nuevo Centro"], ["ruzafa", "Valencia Ruzafa"],
]);
const mappedClub = `CASE club_code WHEN 'BAR' THEN 'barcelona' WHEN 'OMD' THEN 'madrid' WHEN 'MGA' THEN 'malaga-armengual'
  WHEN 'MSO' THEN 'malaga-soho' WHEN 'VLA' THEN 'les-arts' WHEN 'ONC' THEN 'nuevo-centro' WHEN 'VAL' THEN 'ruzafa' END`;

const madridDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(date);
const number = (value) => Number(value ?? 0);

async function importLegacyHistory() {
  const endpoint = process.env.LEGACY_KPI_FEED_URL;
  if (!endpoint) return;
  try {
    const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}history=1`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
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
    WITH mapped AS (
      SELECT ${mappedClub} club, entity, contact_uid, payload, source_updated_at, ingested_at
      FROM resamania_sftp_records WHERE source_deleted_at IS NULL
    ), clubs AS (SELECT DISTINCT club FROM mapped WHERE club IS NOT NULL),
    memberships AS (
      SELECT club,
        count(*) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'product.code','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)') memberships_month,
        count(*) FILTER (WHERE payload->>'createdAt' LIKE $2 || '%' AND lower(coalesce(payload->>'product.code','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)') memberships_today,
        count(*) FILTER (WHERE payload->>'createdAt' LIKE $3 || '%' AND lower(coalesce(payload->>'product.code','')) !~ '(day|jour|dia|week|semaine|semana|sesion|session|vip|admin)') memberships_yesterday,
        count(DISTINCT contact_uid) FILTER (WHERE lower(coalesce(payload->>'state',payload->>'status','')) IN ('active','actif','running','current','en cours')) active_members,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='abonnements' GROUP BY club
    ), cancellations AS (
      SELECT club, count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid')) FILTER (WHERE payload->>'cancellationDate' LIKE $1 || '%' AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_month,
        count(DISTINCT coalesce(payload->>'membership.uid',payload->>'uid')) FILTER (WHERE payload->>'cancellationDate' LIKE $2 || '%' AND lower(coalesce(payload->>'state','accepted'))='accepted') cancellations_today,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='resiliations' GROUP BY club
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
      FROM mapped WHERE entity='factures' GROUP BY club
    ), funnel AS (
      SELECT club, count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'stateAfter',''))='prospect') visits,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'stateAfter',''))='client') conversions,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='contacts' GROUP BY club
    ), accesses AS (
      SELECT club, count(DISTINCT concat(contact_uid,':',left(payload->>'createdAt',10))) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'entryAuthorized','false'))='true' AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)' AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)') accesses_month,
        count(DISTINCT contact_uid) FILTER (WHERE payload->>'createdAt' LIKE $1 || '%' AND lower(coalesce(payload->>'entryAuthorized','false'))='true' AND lower(coalesce(payload->>'entryReason',''))!~'(exit|sortie)' AND lower(coalesce(payload->>'crossingPoint.name',''))!~'(salida|sortie|exit|visbody|sismo)') unique_visitors_month,
        max(coalesce(source_updated_at,ingested_at)) source_updated_at, max(ingested_at) ingested_at
      FROM mapped WHERE entity='passages' GROUP BY club
    )
    SELECT c.club, m.*, x.cancellations_month,x.cancellations_today,i.billing_net,i.billing_gross,i.billing_today,i.buyers,i.merch,i.supplements,i.day_passes,i.deposits,i.collected_through,
      f.visits,f.conversions,a.accesses_month,a.unique_visitors_month,
      greatest(m.ingested_at,x.ingested_at,i.ingested_at,f.ingested_at,a.ingested_at) collected_at
    FROM clubs c LEFT JOIN memberships m USING(club) LEFT JOIN cancellations x USING(club) LEFT JOIN invoices i USING(club) LEFT JOIN funnel f USING(club) LEFT JOIN accesses a USING(club)
  `, [month, today, yesterday]);

  return rows.map((row) => {
    const memberships = number(row.memberships_month);
    const cancellations = number(row.cancellations_month);
    const visits = number(row.visits);
    const conversions = number(row.conversions) || memberships;
    const activeMembers = number(row.active_members);
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
        monthToDate: { memberships, members: activeMembers, cancellations, activeNet: memberships - cancellations, billing: number(row.billing_net), merch: number(row.merch), supplements: number(row.supplements), ties: 0, dayPasses: number(row.day_passes), memberCountBasis: "resamania-sftp", membershipTariffs: [], churnHistory: [] },
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
  for (const row of clubs) await store.pool.query(`INSERT INTO club_kpi_snapshots(club_code,club_name,snapshot_date,collected_at,source,metrics)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [row.club_code, row.club_name, row.snapshot_date, row.collected_at, row.source, row.metrics]);
}

const server = http.createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  try {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      const { rows } = await store.pool.query("SELECT count(*)::int records, max(ingested_at) last_ingest FROM resamania_sftp_records");
      response.end(JSON.stringify({ ok: true, ...rows[0] })); return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/club-kpis") {
      response.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
      const current = await aggregate();
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
await persistCurrentSnapshot().catch((error) => console.error(`Initial KPI snapshot pending: ${error.message}`));
setInterval(importLegacyHistory, 15 * 60_000).unref();
setInterval(() => persistCurrentSnapshot().catch((error) => console.error(`KPI snapshot pending: ${error.message}`)), 30 * 60_000).unref();
