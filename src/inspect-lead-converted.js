import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const context = await chromium.launchPersistentContext(`${rootDir}/.lead-profile`, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://lead.masalledesport.com/club/13125/lead", {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  const result = await page.evaluate(async () => {
    const statuses = ["OLD_CLIENT", "OLD_NETWORK_CLIENT", "TRIAL_HONORED"];
    return Object.fromEntries(await Promise.all(statuses.map(async (status) => {
      const params = new URLSearchParams({
        search: "", status, page: "1", resultPerPage: "5", placeId: "13125",
        orderBy: "creation_date", orderType: "desc", withActivityCount: "true",
      });
      const response = await fetch(`/api/lead/lead?${params}`, { credentials: "include" });
      const payload = await response.json().catch(() => null);
      return [status, { status: response.status, payload }];
    })));
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
}
