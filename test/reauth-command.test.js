import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sessionExpiredMessage } from "../src/resamania-session.js";
import { composeMessage } from "../src/session-alert.js";

/**
 * El mensaje de sesión caducada dice qué comando ejecutar. Si ese comando
 * reautentica un perfil distinto del que usa el colector, el aviso manda a
 * alguien a hacer algo que no arregla nada. Estos tests atan las dos puntas.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

/** Extrae "setup:group" de un texto que contiene `npm run setup:group`. */
function namedScript(text) {
  const match = text.match(/npm run ([\w:-]+)/);
  return match?.[1] ?? null;
}

test("el comando del mensaje existe en package.json", async () => {
  const { scripts } = JSON.parse(await read("../package.json"));
  const script = namedScript(sessionExpiredMessage({}));
  assert.ok(script, "el mensaje debe nombrar un comando");
  assert.ok(scripts[script], `package.json no define "${script}"`);
});

test("el comando del correo es el mismo que el del mensaje", () => {
  const desdeSesion = namedScript(sessionExpiredMessage({}));
  const desdeCorreo = namedScript(composeMessage("alert", ["Madrid"]).text);
  assert.equal(desdeCorreo, desdeSesion);
});

test("el comando reautentica el perfil que usa el colector", async () => {
  const { scripts } = JSON.parse(await read("../package.json"));
  const script = namedScript(sessionExpiredMessage({}));
  const file = scripts[script].replace(/^node\s+/, "");

  const setupSource = await readFile(`${root}${file}`, "utf8");
  const collectorSource = await read("../src/collect-dashboard.js");

  const profileOf = (source) => source.match(/\.browser-profile[\w-]*|\.club-profiles/)?.[0] ?? null;
  const setupProfile = profileOf(setupSource);
  const collectorProfile = profileOf(collectorSource);

  assert.ok(setupProfile, `${file} no abre ningún perfil reconocible`);
  assert.equal(
    setupProfile,
    collectorProfile,
    `${script} reautentica ${setupProfile} pero el colector usa ${collectorProfile}`,
  );
});

test("el aviso de la interfaz nombra el mismo comando", async () => {
  const app = await read("../dashboard/public/app.js");
  const script = namedScript(sessionExpiredMessage({}));
  assert.match(app, new RegExp(`npm run ${script.replace(":", ":")}`));
});
