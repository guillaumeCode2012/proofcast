/**
 * ProofCast webhook — the inbound trigger for "fix it while you sleep".
 *
 * A small HTTP endpoint that receives Sentry / GitHub webhooks, VERIFIES the HMAC
 * signature (constant-time), normalizes the payload into a {@link WebhookEvent},
 * and hands it to a dispatcher. Security-critical bits, all enforced before the
 * event is acted on:
 *   - a request with a missing/invalid signature is rejected (401) — a forged
 *     event must never reach the agent loop;
 *   - the body is size-capped (413) so a huge payload can't exhaust memory;
 *   - the endpoint responds FAST (202 Accepted) and does the long work (the agent
 *     run + gated PR) out of band, so the sender never waits on it.
 *
 * The signature secret comes from the environment / config — never hard-coded.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

/** Which provider's signature scheme a request uses. */
export type SignatureScheme = "sentry" | "github";

/** A provider webhook normalized to what the daemon actually needs. */
export interface WebhookEvent {
  source: "sentry" | "github";
  /** Event kind, e.g. "error" or "issues.opened". */
  kind: string;
  /** Short human summary (the error title / issue title). */
  title: string;
  /** Extra context: culprit / stack / issue body. */
  detail: string;
  /** Link back to the issue/error, if any. */
  url?: string;
}

/** Default cap on a webhook body. */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_000_000;

/** The header each scheme carries its signature in. */
export function defaultSignatureHeader(scheme: SignatureScheme): string {
  return scheme === "github" ? "x-hub-signature-256" : "sentry-hook-signature";
}

/** Hex HMAC-SHA256 of `body` under `secret`. */
export function computeHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Constant-time verify of a webhook signature. GitHub sends `sha256=<hex>`, Sentry
 * sends the bare hex. Returns false for any missing/mismatched/wrong-length input —
 * it never throws.
 */
export function verifyWebhookSignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string,
  scheme: SignatureScheme,
): boolean {
  if (!secret || !signatureHeader) return false;
  const provided = (scheme === "github" ? signatureHeader.replace(/^sha256=/i, "") : signatureHeader).trim();
  const expected = computeHmac(body, secret);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Normalize a Sentry payload into a {@link WebhookEvent} (best-effort). */
export function parseSentryEvent(payload: unknown): WebhookEvent {
  const p = asRecord(payload);
  const data = asRecord(p.data);
  const node = asRecord(data.event ?? data.issue ?? {});
  return {
    source: "sentry",
    kind: str(p.action) || "error",
    title: str(node.title) || str(node.message) || "Sentry alert",
    detail: str(node.culprit) || str(node.transaction) || "",
    url: str(node.web_url) || str(node.issue_url) || str(node.permalink) || undefined,
  };
}

/** Normalize a GitHub payload into a {@link WebhookEvent} (best-effort). */
export function parseGitHubEvent(payload: unknown, eventName?: string): WebhookEvent {
  const p = asRecord(payload);
  const node = asRecord(p.issue ?? p.pull_request ?? {});
  const action = str(p.action);
  return {
    source: "github",
    kind: `${eventName || "event"}${action ? `.${action}` : ""}`,
    title: str(node.title) || "GitHub event",
    detail: str(node.body) || "",
    url: str(node.html_url) || undefined,
  };
}

export interface WebhookHandlerOptions {
  /** Shared secret used to verify the HMAC signature. */
  secret: string;
  /** Provider scheme (selects the parser + default signature header). */
  scheme: SignatureScheme;
  /** Header carrying the signature (defaults per scheme). */
  signatureHeader?: string;
  /**
   * Dispatcher for a verified event. Should return QUICKLY (schedule the real
   * work, don't await it) — the endpoint responds 202 as soon as this resolves.
   */
  onEvent: (event: WebhookEvent) => void | Promise<void>;
}

export interface WebhookRequestLike {
  method: string;
  body: string;
  /** Lower-cased header map (as Node delivers them). */
  headers: Record<string, string | undefined>;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

/**
 * Core webhook logic: verify → parse → dispatch, returning the HTTP response to
 * send. Pure and transport-free, so it is fully testable without a socket.
 */
export async function handleWebhook(
  req: WebhookRequestLike,
  options: WebhookHandlerOptions,
): Promise<WebhookResponse> {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  const headerName = (options.signatureHeader ?? defaultSignatureHeader(options.scheme)).toLowerCase();
  const signature = req.headers[headerName];
  if (!verifyWebhookSignature(req.body, signature, options.secret, options.scheme)) {
    return jsonResponse(401, { error: "invalid signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.body);
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const event =
    options.scheme === "github"
      ? parseGitHubEvent(payload, req.headers["x-github-event"])
      : parseSentryEvent(payload);

  try {
    await options.onEvent(event);
  } catch {
    return jsonResponse(500, { error: "dispatch failed" });
  }
  return jsonResponse(202, { accepted: true, kind: event.kind });
}

export interface StartWebhookServerOptions extends WebhookHandlerOptions {
  /** Host port (0 = ephemeral). */
  port?: number;
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /** Only accept this path (default "/"). */
  path?: string;
  /** Max accepted body size (default {@link DEFAULT_WEBHOOK_MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
}

export interface WebhookServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Start the webhook HTTP server. Resolves once it is listening. */
export async function startWebhookServer(options: StartWebhookServerOptions): Promise<WebhookServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/";
  const maxBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;

  const server = createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      void handleWebhook(
        { method: req.method ?? "GET", body: Buffer.concat(chunks).toString("utf8"), headers: req.headers as Record<string, string | undefined> },
        options,
      )
        .then((response) => {
          res.writeHead(response.status, { "Content-Type": "application/json" });
          res.end(response.body);
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        });
    });
  });

  const port = await listen(server, options.port ?? 0, host);
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const onError = (err: Error): void => rejectPort(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolvePort(address.port);
      } else {
        rejectPort(new Error("could not determine the webhook server port"));
      }
    });
  });
}

function jsonResponse(status: number, body: unknown): WebhookResponse {
  return { status, body: JSON.stringify(body) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
