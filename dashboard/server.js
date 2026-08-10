import http from "node:http";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = fileURLToPath(new URL("./", import.meta.url));
const publicDir = join(dashboardDir, "public");
const agentDir = fileURLToPath(new URL("../", import.meta.url));
const artifactsDir = join(agentDir, "artifacts");
const port = Number(process.env.PORT ?? 3000);
// Por defecto sigue escuchando sólo en el equipo. El dashboard no pide
// contraseña, así que abrirlo a la red local es una decisión explícita.
const host = process.env.HOST ?? "127.0.0.1";
const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

const clubs = [
  ["barcelona", "Barcelona Universitat", "3046"],
  ["madrid", "Madrid Delicias", "3044"],
  ["malaga-armengual", "Málaga Armengual", "3045"],
  ["malaga-soho", "Málaga Soho", "3270"],
  ["les-arts", "Valencia Les Arts", "3041"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042"],
  ["ruzafa", "Valencia Ruzafa", "3043"],
].map(([slug, name, id]) => ({
  slug,
  name,
  id,
  ownership: ["madrid", "les-arts", "nuevo-centro", "ruzafa"].includes(slug)
    ? "owned"
    : "franchise",
}));

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .trim();
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function contactIdentityKeys(contact) {
  const keys = [];
  const email = normalizeText(contact?.email);
  const phone = normalizePhone(contact?.phone);
  const name = normalizeText([contact?.firstname, contact?.lastname].filter(Boolean).join(" "));
  if (email) keys.push(`email:${email}`);
  if (phone) keys.push(`phone:${phone}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function isSpontaneousSource(value) {
  return /recepci[oó]n del club|club reception|reception/.test(normalizeText(value));
}

function isVisitSource(value) {
  const normalized = normalizeText(value);
  return normalized.length > 0 && !isSpontaneousSource(normalized);
}

function localDay(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export async function buildDashboardData() {
  const now = new Date();
  const today = localDay(now);
  const nuevo = await readJson(join(artifactsDir, "cancellations-2026-08-02.json"));
  const liveSnapshot = await readJson(join(artifactsDir, "dashboard-live.json"));
  const fitnessKpiSnapshot = await readJson(join(artifactsDir, "fitness-kpi-live.json"));
  const leadSnapshot = await readJson(join(artifactsDir, "lead-live.json"));
  const watchSnapshot = await readJson(join(artifactsDir, "watch-data.json"));
  const objectiveConfig = await readJson(join(dashboardDir, "objectives.json"), {
    period: "monthly",
    clubs: {},
  });
  const ruzafaLog = await readJsonLines(
    join(artifactsDir, "ruzafa-cancellations-first-seen.jsonl"),
  );
  const ruzafaTrusted = ruzafaLog.filter(
    (row) => row.club === "On Air Valencia Ruzafa" && localDay(row.firstSeenAt) <= "2026-08-02",
  );

  const rows = clubs.map((club) => ({
    ...club,
    memberships: null,
    members: null,
    cancellations: null,
    revenue: null,
    billing: null,
    refunds: null,
    freshness: "unavailable",
    lastUpdate: null,
    sourcePeriod: null,
    monthToDate: null,
    incidences: null,
  }));

  const nuevoRow = rows.find((club) => club.slug === "nuevo-centro");
  if (nuevo?.matches) {
    nuevoRow.cancellations = nuevo.matches.length;
    nuevoRow.freshness = nuevo.targetDate === today ? "live" : "stale";
    nuevoRow.lastUpdate = nuevo.generatedAt;
    nuevoRow.sourcePeriod = nuevo.targetDate;
  }

  const ruzafaRow = rows.find((club) => club.slug === "ruzafa");
  if (ruzafaTrusted.length) {
    const last = ruzafaTrusted.at(-1);
    ruzafaRow.cancellations = ruzafaTrusted.filter(
      (row) => localDay(row.firstSeenAt) === "2026-08-02",
    ).length;
    ruzafaRow.freshness = "stale";
    ruzafaRow.lastUpdate = last.firstSeenAt;
    ruzafaRow.sourcePeriod = "2026-08-02";
  }

  for (const live of liveSnapshot?.results ?? []) {
    const row = rows.find((club) => club.slug === live.slug);
    if (!row || !live.ok) continue;
    const technicalDailyCount = live.monthToDate?.membershipClassification?.technicalDailyCount;
    const technicalMonthlyCount = live.monthToDate?.membershipClassification?.technicalMonthlyCount;
    row.memberships = Number.isFinite(technicalDailyCount) ? technicalDailyCount : live.memberships;
    row.cancellations = live.cancellations;
    row.revenue = live.revenue;
    row.billing = live.billing ?? null;
    row.refunds = live.refunds;
    // `stale` lo marca el colector cuando reutiliza una captura anterior porque
    // la pasada de hoy falló. Sin esto, un fallo de sesión dentro del mismo día
    // se presentaba como "Tiempo real" con los números de la pasada buena.
    row.freshness = live.stale || live.period !== today ? "stale" : "live";
    row.lastError = live.lastError ?? null;
    row.authFailed = live.lastAuthFailed === true;
    row.lastUpdate = live.collectedAt;
    row.sourcePeriod = live.period;
    row.monthToDate = live.monthToDate ? structuredClone(live.monthToDate) : null;
    if (row.monthToDate) {
      if (Number.isFinite(technicalMonthlyCount)) row.monthToDate.memberships = technicalMonthlyCount;
      if (Number.isFinite(technicalDailyCount)) row.monthToDate.dailyMemberships = technicalDailyCount;
      row.monthToDate.activeNet = (Number.isFinite(technicalMonthlyCount) ? technicalMonthlyCount : row.monthToDate.memberships ?? 0) -
        (row.monthToDate.cancellations ?? 0);
    }
    row.members = live.monthToDate?.members ?? null;
    row.incidences = live.monthToDate?.incidences ?? null;
    row.salesFunnel = live.monthToDate?.salesFunnel
      ? structuredClone(live.monthToDate.salesFunnel)
      : live.salesFunnel
        ? structuredClone(live.salesFunnel)
        : null;
    const spontaneousSales = Number.isFinite(row.salesFunnel?.spontaneousSales)
      ? row.salesFunnel.spontaneousSales
      : Array.isArray(row.monthToDate?.membershipSources)
        ? row.monthToDate.membershipSources
          .filter((source) => isSpontaneousSource(source?.source))
          .reduce((sum, source) => sum + Number(source?.memberships ?? 0), 0)
        : 0;
    row.salesFunnel = {
      ...(row.salesFunnel ?? {}),
      spontaneousSales,
      spontaneousSourceLabel: "Recepción del club",
    };
  }

  for (const lead of leadSnapshot?.results ?? []) {
    const row = rows.find((club) => club.slug === lead.slug);
    if (!row || !lead.ok) continue;
    const resamaniaSpontaneousSales = Number.isFinite(row.salesFunnel?.spontaneousSales)
      ? row.salesFunnel.spontaneousSales
      : 0;
    const allowedMembershipIds = new Set(
      (row.monthToDate?.membershipClassification?.membershipContactIds ?? [])
        .map((id) => String(id).split("/").at(-1))
        .filter(Boolean),
    );
    const membershipContacts = Array.isArray(row.monthToDate?.membershipClassification?.monthlyMembershipContacts)
      ? row.monthToDate.membershipClassification.monthlyMembershipContacts
      : [];
    const membershipKeys = new Set(
      membershipContacts.flatMap((contact) => contactIdentityKeys(contact)),
    );
    const attributedSalesSource = Array.isArray(lead.salesFunnel?.attributedSales)
      ? lead.salesFunnel.attributedSales
      : [];
    const attributedSales = attributedSalesSource.map((sale) => {
      const saleKeys = contactIdentityKeys(sale);
      const id = String(sale?.contactId ?? "").split("/").at(-1);
      const matchedByIdentity = saleKeys.some((key) => membershipKeys.has(key));
      const matchedById = allowedMembershipIds.has(id);
      const matched = matchedByIdentity || matchedById || (!membershipKeys.size && !allowedMembershipIds.size);
      return {
        ...sale,
        matched,
        matchKeys: saleKeys.filter((key) => membershipKeys.has(key)),
        matchedById,
      };
    }).filter((sale) => sale.matched);
    const leadVisitSales = attributedSalesSource.filter((sale) => sale.type === "visit");
    const leadAttributedVisitSalesRaw = leadVisitSales.length;
    const attributedVisitSalesRaw = attributedSales.filter((sale) => sale.type === "visit").length;
    const leadVisitSourceCounts = new Map();
    for (const sale of leadVisitSales) {
      const source = String(sale?.source ?? "Sin origen").trim() || "Sin origen";
      leadVisitSourceCounts.set(source, (leadVisitSourceCounts.get(source) ?? 0) + 1);
    }
    const leadVisitSourceBreakdown = [...leadVisitSourceCounts.entries()]
      .map(([source, visits]) => ({
        source,
        visits,
        percentage: leadAttributedVisitSalesRaw
          ? Math.round((visits / leadAttributedVisitSalesRaw) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.visits - a.visits || a.source.localeCompare(b.source, "es"));
    const attributedVisitSales = attributedVisitSalesRaw;
    const attributedVisitSalesMatched = attributedVisitSalesRaw;
    row.leadFunnel = {
      ...(lead.salesFunnel ?? {}),
      attributedSales,
      attributedVisitSales,
      attributedVisitSalesMatched,
      attributedVisitSalesRaw,
      leadAttributedVisitSalesRaw,
      leadVisitSourceBreakdown,
      attributedVisitSalesResamania: Number.isFinite(row.salesFunnel?.conversions)
        ? row.salesFunnel.conversions
        : null,
      attributedVisitSalesGap: Math.max(0, leadAttributedVisitSalesRaw - attributedVisitSalesRaw),
      attributedSalesSourceCount: attributedSalesSource.length,
      lastUpdate: leadSnapshot.generatedAt,
      sourcePeriod: leadSnapshot?.period?.to ?? row.sourcePeriod ?? null,
    };
    row.salesFunnel = {
      ...(row.salesFunnel ?? {}),
      spontaneousSales: resamaniaSpontaneousSales,
      spontaneousSourceLabel: row.salesFunnel?.spontaneousSourceLabel ?? "Recepción del club",
    };
  }

  if (fitnessKpiSnapshot?.period?.to === today) {
    for (const [slug, fitness] of Object.entries(fitnessKpiSnapshot.results ?? {})) {
      const row = rows.find((club) => club.slug === slug);
      if (!row || fitness?.members == null) continue;
      const resamaniaCalculatedCount = row.monthToDate?.members ?? null;
      const membershipsToday = row.memberships ?? 0;
      const cancellationsToday = row.cancellations ?? 0;
      const liveMembers = fitness.members + membershipsToday - cancellationsToday;
      row.members = liveMembers;
      row.monthToDate = {
        ...(row.monthToDate ?? {}),
        members: liveMembers,
        activeMemberClassification: {
          ...(row.monthToDate?.activeMemberClassification ?? {}),
          rule: "fitnesskpi-previous-close-plus-resamania-today-net",
          source: "FitnessKPI previous close + Resamania live qualified movements",
          fitnessKpiCount: fitness.members,
          checkpointThrough: fitnessKpiSnapshot.period.checkpointThrough ?? null,
          resamaniaMembershipsToday: membershipsToday,
          resamaniaCancellationsToday: cancellationsToday,
          liveNetChange: membershipsToday - cancellationsToday,
          resamaniaCalculatedCount,
        },
      };
    }
  }

  const percentage = (actual, target) =>
    actual === null || actual === undefined || !target
      ? null
      : Math.round((actual / target) * 1000) / 10;
  const objectives = Object.entries(objectiveConfig.clubs ?? {}).map(([slug, target]) => {
    const club = rows.find((row) => row.slug === slug);
    const actual = club?.monthToDate ?? null;
    return {
      slug,
      name: club?.name ?? slug,
      actual,
      target,
      percentage: {
        memberships: percentage(actual?.memberships, target.memberships),
        cancellations: percentage(actual?.cancellations, target.cancellations),
        activeNet: percentage(actual?.activeNet, target.activeNet),
        merch: percentage(actual?.merch, target.merch),
        supplements: percentage(actual?.supplements, target.supplements),
        ties: percentage(actual?.ties, target.ties),
        formulaChanges: percentage(actual?.formulaChanges, target.formulaChanges),
      },
    };
  });

  const groups = [
    ["owned", "Centros propios"],
    ["franchise", "Centros franquiciados"],
  ].map(([key, name]) => {
    const groupClubs = rows.filter((row) => row.ownership === key);
    return {
      key,
      name,
      clubs: groupClubs.length,
      connected: groupClubs.filter((row) => row.freshness === "live").length,
      memberships: groupClubs.reduce((sum, row) => sum + (row.memberships ?? 0), 0),
      members: groupClubs.reduce((sum, row) => sum + (row.members ?? 0), 0),
      cancellations: groupClubs.reduce((sum, row) => sum + (row.cancellations ?? 0), 0),
      revenue: groupClubs.reduce((sum, row) => sum + (row.revenue ?? 0), 0),
      billing: groupClubs.reduce((sum, row) => sum + (row.billing ?? 0), 0),
    };
  });

  const totals = rows.reduce(
    (acc, club) => {
      for (const key of ["memberships", "members", "cancellations", "revenue", "billing", "refunds"]) {
        if (club[key] !== null) acc[key] += club[key];
      }
      return acc;
    },
    { memberships: 0, members: 0, cancellations: 0, revenue: 0, billing: 0, refunds: 0 },
  );
  const incidenceTotals = rows.reduce(
    (totals, row) => {
      if (!row.incidences) return totals;
      totals.incompleteMemberships += row.incidences.incompleteMemberships ?? 0;
      totals.fullPeriodCancellations += row.incidences.fullPeriodCancellations ?? 0;
      totals.oneMonthCancellations += row.incidences.oneMonthCancellations ?? 0;
      totals.automaticReturnFeeOnly += row.incidences.automaticReturnFeeOnly ?? 0;
      totals.pendingCancellations += row.incidences.pendingCancellations ?? 0;
      totals.paymentIncidences += row.incidences.paymentIncidences ?? 0;
      totals.signatureIncidences += row.incidences.signatureIncidences ?? 0;
      return totals;
    },
    {
      incompleteMemberships: 0,
      fullPeriodCancellations: 0,
      oneMonthCancellations: 0,
      automaticReturnFeeOnly: 0,
      pendingCancellations: 0,
      paymentIncidences: 0,
      signatureIncidences: 0,
    },
  );

  return {
    generatedAt: now.toISOString(),
    today,
    mode: "read-only",
    refreshSeconds: 300,
    connectedClubs: rows.filter((club) => club.freshness === "live").length,
    totals,
    clubs: rows,
    objectives,
    groups,
    incidences: { totals: incidenceTotals, clubs: rows.map(({ slug, name, ownership, incidences }) => ({ slug, name, ownership, ...incidences })) },
    watchData: {
      generatedAt: watchSnapshot?.generatedAt ?? null,
      period: watchSnapshot?.period ?? null,
      criterion: watchSnapshot?.criterion ?? null,
      clubs: rows.map(({ slug, name, ownership }) => {
        const watch = watchSnapshot?.results?.find((result) => result.slug === slug);
        return { slug, name, ownership, count: watch?.ok ? watch.count : null, error: watch?.ok ? null : watch?.error ?? null };
      }),
    },
    trend: [],
    notices: [
      "Los datos visibles son históricos hasta conectar recolectores verificados por centro.",
      "Altas e ingresos permanecen sin valor para evitar mostrar cifras estimadas como reales.",
    ],
  };
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/dashboard") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    });
    response.end(JSON.stringify(await buildDashboardData()));
    return;
  }
  const rawPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const safePath = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mime[extname(filePath)] ?? "application/octet-stream",
      "cache-control": extname(filePath) === ".js" || extname(filePath) === ".html"
        ? "no-store, max-age=0"
        : "public, max-age=60",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

// Sólo escucha cuando se ejecuta directamente. Así el exportador puede
// importar buildDashboardData sin levantar un servidor de paso.
const ejecutadoDirectamente = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (ejecutadoDirectamente) server.listen(port, host, () => {
  console.log(`Dashboard disponible en http://localhost:${port}`);
  if (isLoopback) return;
  for (const address of localAddresses()) {
    console.log(`  y desde la red local en http://${address}:${port}`);
  }
  console.warn(
    "Aviso: el dashboard no pide contraseña y muestra datos de socios. " +
      "Cualquiera con acceso a esta red puede abrirlo.",
  );
});
