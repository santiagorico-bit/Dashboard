import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const clubs = [
  ["barcelona", "Barcelona Universitat", "3046"],
  ["madrid", "Madrid Delicias", "3044"],
  ["malaga-armengual", "Málaga Armengual", "3045"],
  ["malaga-soho", "Málaga Soho", "3270"],
  ["les-arts", "Valencia Les Arts", "3041"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042"],
  ["ruzafa", "Valencia Ruzafa", "3043"],
];

await mkdir(artifactsDir, { recursive: true });
async function validate([slug, name, id]) {
  let context;
  try {
    context = await chromium.launchPersistentContext(`${rootDir}/.club-profiles/${slug}`, {
      channel: "chrome",
      headless: true,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("about:blank");
    const contacts = [];
    page.on("response", (response) => {
      if (response.url().includes("/contacts?") && response.status() === 200) {
        contacts.push(response.url());
      }
    });
    await page.goto(
      `https://app.resamania.com/onairespana/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F${id}`,
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    await page.waitForTimeout(12000);
    const body = await page.locator("body").innerText();
    const expectedUrl = contacts.some((url) => url.includes(`clubs%2F${id}`));
    const selectedName = body.toLocaleLowerCase("es").includes(name.toLocaleLowerCase("es"));
    return { slug, name, id, ok: expectedUrl && selectedName, expectedUrl, selectedName };
  } catch (error) {
    return { slug, name, id, ok: false, error: error.message };
  } finally {
    if (context) {
      await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
  }
}

const results = await Promise.all(clubs.map(validate));
await writeFile(
  `${artifactsDir}/club-profiles-validation.json`,
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  "utf8",
);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((result) => result.ok) ? 0 : 1);
