/**
 * Detección de sesión caducada contra Resamania.
 *
 * El colector reutiliza las cabeceras de una XHR real capturada en el navegador
 * (`collect-dashboard.js`). Cuando el perfil persistente pierde la sesión, la
 * API deja de responder datos y devuelve el login de OAuth. Ese caso no puede
 * confundirse con un error de negocio: obliga a reautenticar, no a reintentar.
 */

/** Rutas y hosts que delatan que nos han devuelto el login en vez de datos. */
const LOGIN_URL_PATTERN = /(\/login|\/oauth|\/authorize|\/connect\/|sso)/i;

export class SessionExpiredError extends Error {
  constructor(message, { status = null, url = null, club = null } = {}) {
    super(message);
    this.name = "SessionExpiredError";
    this.status = status;
    this.url = url;
    this.club = club;
    this.authFailed = true;
  }
}

/**
 * Clasifica una respuesta de la API desde el punto de vista de la sesión.
 * Devuelve "session" cuando lo recibido es un login disfrazado de respuesta.
 */
export function classifyResponse({ status, headers = {}, url = "" } = {}) {
  if (status === 401 || status === 403) return "session";
  if (status >= 300 && status < 400) {
    const location = headers.location ?? headers.Location ?? "";
    return LOGIN_URL_PATTERN.test(location) ? "session" : "other";
  }
  // Un 200 con HTML es el formulario de login: el caso que hoy se cuela.
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  if (status >= 200 && status < 300 && /text\/html/i.test(contentType)) return "session";
  return "other";
}

/** Mensaje único y accionable: siempre dice qué comando resuelve el bloqueo. */
export function sessionExpiredMessage({ club, status } = {}) {
  const where = club ? ` al recoger ${club}` : "";
  const code = status ? ` (HTTP ${status})` : "";
  return (
    `La sesión de Resamania ha caducado${where}${code}. ` +
    "La API está devolviendo el login en lugar de datos. " +
    "Ejecuta `npm run setup:group` para reautenticar el perfil del navegador."
  );
}

/**
 * Comprueba que la página cargada es la aplicación y no el login.
 * Se llama antes de esperar 15 s por el selector de club, que es lo que hoy
 * convierte una sesión caducada en un timeout opaco.
 */
export async function assertAppLoaded(page, { club } = {}) {
  const url = page.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    throw new SessionExpiredError(sessionExpiredMessage({ club }), { url, club });
  }
}

/**
 * Sonda barata contra un endpoint ya confirmado. Verifica que las cabeceras
 * capturadas abren datos reales antes de lanzar la recogida completa.
 */
export async function verifySession(request, { baseUrl, headers, club } = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}/referentials/sources?itemsPerPage=1`;
  let response;
  try {
    response = await request.get(url, { headers, timeout: 20000 });
  } catch (cause) {
    // Un fallo de red no es una sesión caducada: se deja subir tal cual.
    throw cause;
  }

  const status = response.status();
  const responseHeaders = typeof response.allHeaders === "function"
    ? await response.allHeaders()
    : response.headers();

  if (classifyResponse({ status, headers: responseHeaders, url }) === "session") {
    throw new SessionExpiredError(sessionExpiredMessage({ club, status }), { status, url, club });
  }
  return true;
}
