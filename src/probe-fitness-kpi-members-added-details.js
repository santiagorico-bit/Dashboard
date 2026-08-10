import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.fitness-kpi-profile`, { channel: "chrome", headless: true });
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://app.fitness-kpi.com/center/reports/daily?report-view=dashboard", { waitUntil: "domcontentloaded", timeout: 90000 });
  const output = await page.evaluate(async () => {
    const xsrf = document.cookie.split("; ").find((entry) => entry.startsWith("XSRF-TOKEN="));
    const headers = {
      "Content-Type": "application/json", Accept: "application/json",
      "X-XSRF-TOKEN": xsrf ? decodeURIComponent(xsrf.split("=").slice(1).join("=")) : "",
      "X-Requested-With": "XMLHttpRequest",
    };
    const variants = [
      { driver: "IndicatorEndMonth", withDetails: true },
      { driver: "detailsTable", withDetails: true },
      { driver: "memberlist", withDetails: true },
    ];
    const results = [];
    for (const variant of variants) {
      const response = await fetch("/api/kpis/data/members_added", {
        method: "POST", credentials: "include", headers,
        body: JSON.stringify({
          nodeId: "99f4fde8-8a3e-404c-9675-049f8e85da8e",
          from: "2026-08-01", to: "2026-08-05", showPercentage: false,
          zoom: "monthly", compareWithCenters: [], excludeNewCentersOnPeriod: false,
          comparePace: false, untilEndMonth: false, detailedPeriod: false,
          excludeCurrentMonth: false, showEchartLabel: false, isDeltaQuery: false,
          showDefaultEchartLabel: true, ...variant,
        }),
      });
      results.push({ variant, status: response.status, body: await response.text() });
    }
    return results;
  });
  await writeFile(`${rootDir}/artifacts/fitness-kpi-members-added-details.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output.map((row) => ({ variant: row.variant, status: row.status, preview: row.body.slice(0, 1000) })), null, 2));
} finally {
  await context.close();
}
