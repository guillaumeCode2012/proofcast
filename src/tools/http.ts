/**
 * HTTP tool — read-only web access without launching a browser.
 *
 * `http_fetch` GETs (or POSTs) a URL and returns the status, final URL, content
 * type and a byte-capped body — the "look something up on the web" capability for
 * pages that don't need a real browser (APIs, raw pages, JSON endpoints). When the
 * response is JSON and small enough to be complete, it is also parsed for the agent.
 *
 * Contract, as everywhere in the tool layer:
 *   - A non-2xx status is a normal RESULT (`ok:true`, status reported) — the agent
 *     inspects it and decides, exactly like a non-zero exit code from `shell_run`.
 *   - `ok:false` is reserved for the fetch itself failing: bad input, a non-http(s)
 *     URL, a network error, or the timeout firing.
 *   - Only `http:`/`https:` URLs are allowed — `file:`, `ftp:` etc. are refused
 *     before any request is made.
 */

import { fail, ok, type Tool } from "./registry.js";
import { assertSafeHttpUrl, UnsafeUrlError } from "./url-guard.js";

/** Default wall-clock cap on one fetch (connect + body), ms. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Default byte cap on the returned body. */
export const DEFAULT_MAX_BODY_BYTES = 100_000;

/** The minimal response surface the tool needs (satisfied by a real fetch Response). */
export interface HttpResponseLike {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Request shape handed to the (injectable) fetcher. */
export interface HttpFetchInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/** Injectable transport, so tests never touch the network. */
export type HttpFetcher = (url: string, init: HttpFetchInit) => Promise<HttpResponseLike>;

/** Default transport: the global fetch (Node >= 18), following redirects. */
const defaultFetcher: HttpFetcher = async (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: "follow",
  });

export interface HttpToolOptions {
  /** Override the transport (default: global fetch). */
  fetcher?: HttpFetcher;
  /** Wall-clock cap per request (default {@link DEFAULT_HTTP_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Byte cap on the returned body (default {@link DEFAULT_MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
  /** Allow requests to private/loopback hosts (default: blocked — SSRF guard). */
  allowPrivate?: boolean;
}

/** The read-only web tool: `http_fetch`. */
export function createHttpTool(options: HttpToolOptions = {}): Tool {
  const fetcher = options.fetcher ?? defaultFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return {
    name: "http_fetch",
    description:
      "Fetch an http(s) URL (GET by default, or POST with a body) and return the status, " +
      "final URL, content type and a byte-capped body (JSON parsed when complete). " +
      "A non-2xx status is reported as a result, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (default GET)." },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional request headers.",
        },
        body: { type: "string", description: "Request body (POST only)." },
      },
      required: ["url"],
    },
    async run(input) {
      const url = readStringProp(input, "url");
      if (url === undefined) return fail('http_fetch requires a non-empty "url" string.');
      try {
        // Scheme + SSRF check (private/loopback/metadata) BEFORE any request.
        assertSafeHttpUrl(url, { allowPrivate: options.allowPrivate });
      } catch (err) {
        if (err instanceof UnsafeUrlError) return fail(err.message);
        throw err;
      }

      const rawMethod = readStringProp(input, "method");
      const method = rawMethod === undefined ? "GET" : rawMethod.toUpperCase();
      if (method !== "GET" && method !== "POST") {
        return fail(`http_fetch supports only GET and POST, got: ${JSON.stringify(rawMethod)}.`);
      }

      const headers = readHeadersProp(input);
      if (headers instanceof Error) return fail(headers.message);

      const body = readBodyProp(input);
      if (body instanceof Error) return fail(body.message);
      if (body !== undefined && method !== "POST") {
        return fail('http_fetch: "body" is only allowed with method POST.');
      }

      // Timeout: abort the request (and any in-flight body read) past the budget.
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      try {
        const response = await fetcher(url, { method, headers, body, signal: controller.signal });
        const raw = await response.text();
        const contentType = response.headers.get("content-type") ?? null;
        const truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
        const capped = truncated ? Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8") : raw;

        return ok({
          status: response.status,
          url: response.url || url,
          contentType,
          body: capped,
          truncated,
          // Parsed JSON only when the payload is COMPLETE (a truncated JSON would
          // parse to garbage or fail anyway) and the server says it is JSON.
          json: !truncated && isJsonContentType(contentType) ? tryParseJson(raw) : undefined,
        });
      } catch (err) {
        if (timedOut) {
          return fail(`http_fetch timed out after ${timeoutMs} ms for ${url}.`);
        }
        return fail(`http_fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** True when a content-type denotes JSON (application/json, …+json). */
function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /(?:application\/json|\+json)\b/i.test(contentType);
}

/** Best-effort JSON parse; `undefined` when the body is not valid JSON. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Read a required non-empty string property from untrusted model input. */
function readStringProp(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate the optional `headers` map (string → string). Error on a bad shape. */
function readHeadersProp(input: unknown): Record<string, string> | undefined | Error {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).headers;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error('http_fetch: "headers" must be an object of string values.');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      return new Error(`http_fetch: header ${JSON.stringify(k)} must be a string.`);
    }
    out[k] = v;
  }
  return out;
}

/** Validate the optional `body` (a string; empty string is a valid POST body). */
function readBodyProp(input: unknown): string | undefined | Error {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).body;
  if (value === undefined) return undefined;
  if (typeof value !== "string") return new Error('http_fetch: "body" must be a string.');
  return value;
}
