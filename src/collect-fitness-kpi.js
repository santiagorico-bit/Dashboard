import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
});
const today = formatter.format(new Date());
const monthStart = `${today.slice(0, 8)}01`;
const yesterdayDate = new Date(`${today}T12:00:00+02:00`);
yesterdayDate.setDate(yesterdayDate.getDate() - 1);
const checkpointThrough = formatter.format(yesterdayDate);
const centers = {
  madrid: "b1400ddf-0243-438a-8f49-46f7d6be3527",
  "malaga-armengual": "bfd13bac-07c1-4afe-9691-575a10faa6a2",
  "les-arts": "6668f604-4ba2-488e-a101-378f6f1e6fab",
  "nuevo-centro": "9c950c0b-414c-4cef-a75f-acfe385ee9d4",
  ruzafa: "99f4fde8-8a3e-404c-9675-049f8e85da8e",
};

const context = await chromium.launchPersistentContext(`${rootDir}/.fitness-kpi-profile`, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=dashboard", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  if (page.url().includes("/login")) throw new Error("Sesión de FitnessKPI caducada");
  const results = {};
  for (const [slug, nodeId] of Object.entries(centers)) {
    results[slug] = await page.evaluate(async ({ nodeId, monthStart, today, checkpointThrough }) => {
      const xsrfCookie = document.cookie.split("; ").find((entry) => entry.startsWith("XSRF-TOKEN="));
      const xsrfToken = xsrfCookie ? decodeURIComponent(xsrfCookie.split("=").slice(1).join("=")) : "";
      const postKpi = async (metric, body) => {
        const response = await fetch(`/api/kpis/data/${metric}`, {
          method: "POST", credentials: "include",
          headers: {
            "Content-Type": "application/json", Accept: "application/json",
            "X-XSRF-TOKEN": xsrfToken, "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`FitnessKPI ${metric} HTTP ${response.status}`);
        return response.json();
      };
      const requestMemberships = async (from, to) => postKpi("members_added", {
            nodeId, from, to, driver: "memberlist", withDetails: true,
            showPercentage: false, zoom: "monthly", compareWithCenters: [],
            excludeNewCentersOnPeriod: false, comparePace: false, untilEndMonth: false,
            detailedPeriod: false, excludeCurrentMonth: false, showEchartLabel: false,
            isDeltaQuery: false, showDefaultEchartLabel: true,
      });
      const requestMembers = async (from, to) => postKpi("members", {
        nodeId, from, to, driver: "IndicatorMonthYear", withDetails: false,
        showPercentage: false, zoom: "monthly", compareWithCenters: [],
        excludeNewCentersOnPeriod: false, comparePace: true, untilEndMonth: false,
        detailedPeriod: false, excludeCurrentMonth: false, showEchartLabel: false,
        isDeltaQuery: false, showDefaultEchartLabel: true,
      });
      const [month, members] = await Promise.all([
        requestMemberships(monthStart, today), requestMembers(monthStart, checkpointThrough),
      ]);
      return { month, members, today };
    }, { nodeId, monthStart, today, checkpointThrough });
  }
  const output = {
    generatedAt: new Date().toISOString(),
    period: { from: monthStart, to: today, checkpointThrough },
    source: "FitnessKPI members + members_added",
    results: Object.fromEntries(Object.entries(results).map(([slug, payload]) => [slug, {
      memberships: payload.month?.items?.length ?? null,
      members: payload.members?.data?.actual?.value ?? null,
      membershipsToday: (payload.month?.items ?? []).filter((item) => item.start_date === payload.today).length,
      memberIds: [...new Set((payload.month?.items ?? []).map((item) => String(item.member_id)).filter(Boolean))],
      memberIdsToday: [...new Set((payload.month?.items ?? []).filter((item) => item.start_date === payload.today).map((item) => String(item.member_id)).filter(Boolean))],
      metadata: { cursor: payload.month?.cursor ?? null },
    }])),
  };
  await mkdir(`${rootDir}/artifacts`, { recursive: true });
  await writeFile(`${rootDir}/artifacts/fitness-kpi-live.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
