/**
 * Exporta el dashboard a un único fichero HTML que se abre con doble clic.
 *
 * Sin servidor, sin npm, sin nada corriendo: los estilos, el código y los datos
 * van dentro del propio fichero. Sirve para consultar el cierre desde cualquier
 * equipo o para guardarlo como registro del día.
 *
 * Reutiliza la interfaz real —el mismo index.html y el mismo app.js— en lugar de
 * duplicar el render, de modo que la exportación no se desvía de lo que se ve en
 * http://localhost:3000.
 *
 *   node src/export-dashboard-html.js [destino.html]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardData } from "../dashboard/server.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(rootDir, "dashboard", "public");
const destino = process.argv[2] ?? join(rootDir, "artifacts", "dashboard.html");

/** Evita que un `</script>` dentro de los datos cierre la etiqueta antes de tiempo. */
function jsonSeguro(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const data = await buildDashboardData();

let html = await readFile(join(publicDir, "index.html"), "utf8");

// Los estilos pasan a <style>: un fichero suelto no puede pedir /styles.css.
const hojas = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"\s*\/?>/g)];
for (const [etiqueta, fichero] of hojas) {
  const css = await readFile(join(publicDir, fichero), "utf8");
  html = html.replace(etiqueta, `<style>\n${css}\n</style>`);
}

const app = await readFile(join(publicDir, "app.js"), "utf8");
const generadoEn = new Date();

/**
 * app.js pide los datos a /api/dashboard. Aquí no hay servidor, así que se
 * sustituye fetch por los datos ya calculados. El resto del render es idéntico.
 */
const puente = `
window.__DATOS__ = ${jsonSeguro(data)};
window.fetch = async () => ({ ok: true, json: async () => window.__DATOS__ });
// Ni el botón ni el refresco automático tienen nada que recargar en un fichero.
window.setInterval = () => 0;
addEventListener("DOMContentLoaded", () => {
  const boton = document.querySelector("#refresh");
  if (boton) {
    boton.disabled = true;
    boton.textContent = "Captura fija";
    boton.title = "Este fichero es una copia. Para datos nuevos, vuelve a exportarlo.";
  }
});
`;

const aviso = `
<div class="export-stamp">
  <strong>Copia exportada</strong>
  <span>Generada el ${generadoEn.toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}.
  Los números son los de ese momento y no se actualizan solos.</span>
</div>
<style>
.export-stamp{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;background:#eef2f1;border:1px solid #d6dedc;border-radius:12px;padding:11px 15px;margin-bottom:18px}
.export-stamp strong{font-size:13px;color:#2c3d3a}
.export-stamp span{font-size:12px;color:#5f6d6a}
</style>`;

html = html
  .replace(/<script type="module" src="\/app\.js[^"]*"><\/script>/,
    `<script type="module">${puente}\n${app}</script>`)
  .replace("<main>", `<main>\n${aviso}`);

await mkdir(dirname(destino), { recursive: true });
await writeFile(destino, html, "utf8");

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`Dashboard exportado a ${destino} (${kb} KB)`);
console.log("Se abre con doble clic. No necesita servidor ni conexión.");
console.log("Contiene datos de socios: trátalo como el resto de artifacts/.");
