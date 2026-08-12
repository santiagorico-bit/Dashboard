/**
 * Apertura de sesión contra Resamania para consultas puntuales.
 *
 * Repite el camino que ya usa el colector: abre el perfil persistente, entra en
 * el centro y captura las cabeceras de una petición real de la aplicación. Es la
 * única forma de hablar con la API, porque Resamania no emite claves.
 */

import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ResamaniaApiClient } from "./resamania-api-client.js";
import { assertAppLoaded, verifySession } from "./resamania-session.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const APP_BASE = "https://app.resamania.com/onairespana";
export const API_BASE = "https://api.resamania.com/onairespana";

/** Los siete centros, con la etiqueta exacta del selector de la aplicación. */
export const CLUBS = {
  barcelona: { name: "Barcelona Universitat", id: "3046", label: "On Air Barcelona Universitat" },
  madrid: { name: "Madrid Delicias", id: "3044", label: "On Air Madrid Delicias" },
  "malaga-armengual": { name: "Málaga Armengual", id: "3045", label: "On Air Malaga Armengual" },
  "malaga-soho": { name: "Málaga Soho", id: "3270", label: "On Air Málaga Soho" },
  "les-arts": { name: "Valencia Les Arts", id: "3041", label: "On Air Valencia Les Arts" },
  "nuevo-centro": { name: "Valencia Nuevo Centro", id: "3042", label: "On Air Valencia Nuevo Centro" },
  ruzafa: { name: "Valencia Ruzafa", id: "3043", label: "On Air Valencia Ruzafa" },
};

export const CLUB_SLUGS = Object.keys(CLUBS);

/** Acepta el slug, el nombre del centro o un trozo reconocible de cualquiera. */
export function resolveClub(input) {
  const needle = String(input ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es").trim();
  if (!needle) return null;
  if (CLUBS[needle]) return { slug: needle, ...CLUBS[needle] };

  const matches = CLUB_SLUGS.filter((slug) => {
    const haystack = `${slug} ${CLUBS[slug].name}`
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es");
    return haystack.includes(needle);
  });
  // Con más de una coincidencia no se adivina: el llamante debe concretar.
  return matches.length === 1 ? { slug: matches[0], ...CLUBS[matches[0]] } : null;
}

/**
 * Abre el centro y devuelve un cliente listo para consultar.
 * Quien lo llame debe invocar `close()` al terminar.
 */
export async function openClubSession(slug, { headless = true, profileDir, logger = console } = {}) {
  const club = resolveClub(slug);
  if (!club) throw new Error(`Centro desconocido: ${slug}. Opciones: ${CLUB_SLUGS.join(", ")}`);

  const perfil = profileDir ?? process.env.BROWSER_PROFILE_DIR ?? `${rootDir}/.browser-profile-group`;
  const context = await chromium.launchPersistentContext(perfil, { channel: "chrome", headless });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(APP_BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
    await assertAppLoaded(page, { club: club.name });

    const target = page.getByRole("button", { name: club.label, exact: true });
    if (!(await target.isVisible().catch(() => false))) {
      const clubButton = page.getByRole("button", { name: "Club", exact: true });
      if (await clubButton.isVisible().catch(() => false)) await clubButton.click();
    }
    try {
      await target.waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      // La redirección al login llega después de domcontentloaded: aquí ya ha
      // navegado y se distingue una sesión caducada de un selector lento.
      await assertAppLoaded(page, { club: club.name });
      throw error;
    }
    await target.click();
    await page.waitForTimeout(1500);
    await page.goto("about:blank");

    let sniffed = null;
    page.on("response", (response) => {
      if (response.url().startsWith(`${API_BASE}/contacts?`) && response.status() === 200) sniffed = response;
    });
    await page.goto(
      `${APP_BASE}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F${club.id}`,
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    for (let intento = 0; intento < 30 && !sniffed; intento += 1) await page.waitForTimeout(500);
    if (!sniffed) {
      await assertAppLoaded(page, { club: club.name });
      throw new Error("No se cargó la sesión de datos del club");
    }

    const rawHeaders = await sniffed.request().allHeaders();
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).filter(([header]) => !header.startsWith(":")),
    );
    const clubId = `/onairespana/clubs/${club.id}`;

    const api = await new ResamaniaApiClient({
      request: context.request,
      baseUrl: API_BASE,
      headers,
      clubId,
      cacheFile: `${rootDir}/artifacts/cache/subscriptions-${club.id}.json`,
      concurrency: 6,
      retries: 4,
    }).init();

    await verifySession(context.request, { baseUrl: API_BASE, headers, club: club.name });

    return {
      club,
      clubId,
      api,
      close: async () => {
        await api.flushCache().catch(() => {});
        await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 4000))]);
      },
    };
  } catch (error) {
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 4000))]).catch(() => {});
    logger.error?.(`No se pudo abrir la sesión de ${club.name}: ${error.message}`);
    throw error;
  }
}
