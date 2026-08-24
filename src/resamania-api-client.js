import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resourceUri } from "./dashboard-domain.js";
import { classifyResponse, SessionExpiredError, sessionExpiredMessage } from "./resamania-session.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ResamaniaApiError extends Error {
  constructor(message, { status, endpoint, url } = {}) {
    super(message);
    this.name = "ResamaniaApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.url = url;
  }
}

export class ResamaniaApiClient {
  constructor({
    request, baseUrl, headers, clubId, cacheFile,
    concurrency = 6, retries = 4, baseDelayMs = 300,
  }) {
    this.request = request;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.headers = { ...headers, "x-user-club-id": clubId };
    this.clubId = clubId;
    this.cacheFile = cacheFile;
    this.concurrency = concurrency;
    this.retries = retries;
    this.baseDelayMs = baseDelayMs;
    this.active = 0;
    this.queue = [];
    this.cache = new Map();
    this.cacheDirty = false;
    this.metrics = { startedAt: new Date().toISOString(), requests: 0, retries: 0, errors: 0, durationMs: 0, endpoints: {} };
  }

  async init() {
    if (!this.cacheFile) return this;
    try {
      const payload = JSON.parse(await readFile(this.cacheFile, "utf8"));
      for (const [key, value] of Object.entries(payload.subscriptions ?? {})) this.cache.set(key, value);
    } catch {}
    return this;
  }

  endpointMetric(endpoint) {
    return this.metrics.endpoints[endpoint] ??= { requests: 0, retries: 0, errors: 0, durationMs: 0 };
  }

  buildUrl(path, params) {
    let normalized = path;
    if (/^https?:\/\//.test(path)) normalized = path;
    else {
      normalized = path.startsWith("/onairespana/") ? path.slice("/onairespana".length) : path;
      normalized = `${this.baseUrl}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
    }
    const url = new URL(normalized);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async limit(task) {
    if (this.active >= this.concurrency) await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    try { return await task(); }
    finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  async get(path, { params, endpoint = path, allowStatuses = [] } = {}) {
    return this.limit(async () => {
      const url = this.buildUrl(path, params);
      const metric = this.endpointMetric(endpoint);
      let lastError;
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        const started = Date.now();
        this.metrics.requests += 1;
        metric.requests += 1;
        try {
          const response = await this.request.get(url, { headers: this.headers, timeout: 45000 });
          const elapsed = Date.now() - started;
          this.metrics.durationMs += elapsed;
          metric.durationMs += elapsed;
          const status = response.status();
          const responseHeaders = typeof response.allHeaders === "function"
            ? await response.allHeaders()
            : response.headers();
          const sessionVerdict = classifyResponse({ status, headers: responseHeaders, url });
          // Un 200 con HTML es el formulario de login: jamás es un dato válido,
          // ni siquiera si el llamante tolera el código con allowStatuses.
          if (sessionVerdict === "session" && response.ok()) {
            this.metrics.errors += 1;
            metric.errors += 1;
            throw new SessionExpiredError(sessionExpiredMessage({ status }), { status, url });
          }
          if (response.ok()) return { status, data: await response.json(), headers: responseHeaders };
          if (allowStatuses.includes(status)) return { status, data: null, headers: responseHeaders };
          // Un 401 (o un 403 no tolerado) significa reautenticar, no reintentar.
          if (sessionVerdict === "session") {
            this.metrics.errors += 1;
            metric.errors += 1;
            throw new SessionExpiredError(sessionExpiredMessage({ status }), { status, url });
          }
          const retryable = status === 429 || status >= 500;
          lastError = new ResamaniaApiError(`${endpoint}: HTTP ${status}`, { status, endpoint, url });
          if (!retryable || attempt === this.retries) throw lastError;
          const retryAfter = Number(responseHeaders["retry-after"] ?? 0) * 1000;
          const delay = retryAfter || this.baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 100);
          this.metrics.retries += 1;
          metric.retries += 1;
          await sleep(delay);
        } catch (error) {
          // Reintentar una sesión caducada sólo multiplica la espera por 5.
          if (error instanceof SessionExpiredError) throw error;
          if (error instanceof ResamaniaApiError) {
            if (attempt === this.retries || (error.status !== 429 && error.status < 500)) {
              this.metrics.errors += 1; metric.errors += 1; throw error;
            }
            lastError = error;
            continue;
          }
          const elapsed = Date.now() - started;
          this.metrics.durationMs += elapsed;
          metric.durationMs += elapsed;
          lastError = error;
          if (attempt === this.retries) {
            this.metrics.errors += 1; metric.errors += 1; throw error;
          }
          this.metrics.retries += 1;
          metric.retries += 1;
          await sleep(this.baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 100));
        }
      }
      throw lastError;
    });
  }

  async getJson(path, options) {
    return (await this.get(path, options)).data;
  }

  async getSubscription(subscription, { contact } = {}) {
    const uri = resourceUri(subscription);
    if (!uri) return null;
    if (this.cache.has(uri)) return this.cache.get(uri);

    const direct = await this.get(uri, {
      endpoint: "subscriptions.detail",
      allowStatuses: [400, 403, 404, 405],
    });
    let result = direct.data;
    if (!result) {
      const contactUri = resourceUri(contact);
      if (!contactUri) return null;
      const payload = await this.getJson("/subscriptions", {
        endpoint: "subscriptions.byContact",
        params: { contact: contactUri, itemsPerPage: 100, page: 1 },
      });
      result = (payload?.["hydra:member"] ?? []).find((item) => item["@id"] === uri) ?? null;
    }
    if (result) {
      this.cache.set(uri, result);
      this.cacheDirty = true;
    }
    return result;
  }

  async flushCache() {
    if (!this.cacheFile || !this.cacheDirty) return;
    await mkdir(dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      subscriptions: Object.fromEntries(this.cache),
    }, null, 2));
    this.cacheDirty = false;
  }

  snapshotMetrics() {
    return { ...this.metrics, finishedAt: new Date().toISOString() };
  }
}
