/**
 * URL guard — the SSRF defense shared by the network-facing tools.
 *
 * `http_fetch` (14.4) and `browser_goto` (14.3) both take a URL from an untrusted
 * model. Without a guard the agent could be steered into internal services:
 * `http://localhost:…`, private ranges (`10/8`, `192.168/16`, …), or the cloud
 * metadata endpoint (`169.254.169.254`) that hands out credentials. {@link assertSafeHttpUrl}
 * refuses all of those (and any non-http(s) scheme) BEFORE a request is made,
 * unless the caller explicitly opts in with `allowPrivate`.
 *
 * Scope / honest limitation: this blocks literal private hosts. It does NOT resolve
 * DNS, so a public hostname that resolves to a private IP (DNS rebinding) is not
 * caught here — full protection needs resolve-then-pin at connect time, a later
 * hardening. This closes the common, high-impact cases (metadata, localhost,
 * literal private IPs) which is the point of this step.
 */

/** Thrown when a URL is refused by the guard. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface UrlGuardOptions {
  /** Opt out of the private-host block (default: blocked). */
  allowPrivate?: boolean;
}

/**
 * Parse and validate a URL for outbound requests.
 * @throws {UnsafeUrlError} for a malformed URL, a non-http(s) scheme, or (unless
 *   `allowPrivate`) a private / loopback / link-local host.
 */
export function assertSafeHttpUrl(raw: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http(s) URLs are allowed, got ${JSON.stringify(url.protocol)}.`);
  }
  if (!options.allowPrivate && isPrivateHostname(url.hostname)) {
    throw new UnsafeUrlError(
      `Refusing to reach a private/loopback host: ${JSON.stringify(url.hostname)} ` +
        `(SSRF guard). Pass allowPrivate to override.`,
    );
  }
  return url;
}

/** True for localhost, a private/loopback/link-local IPv4, or a private IPv6. */
export function isPrivateHostname(hostname: string): boolean {
  // URL hostnames keep IPv6 in brackets; strip them.
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPrivateIPv4(host);
  }
  if (host.includes(":")) {
    return isPrivateIPv6(host);
  }
  return false;
}

/** Private / loopback / link-local / CGNAT / unspecified IPv4 ranges. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (this host)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 255 && b === 255) return true; // broadcast-ish
  return false;
}

/** Loopback / unspecified / ULA (fc00::/7) / link-local (fe80::/10) IPv6, incl. mapped IPv4. */
function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true;
  // IPv4-mapped / -compatible (::ffff:10.0.0.1) → judge the embedded IPv4.
  const mapped = /(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  const head = addr.replace(/^\[/, "").split(":")[0] ?? "";
  if (head.startsWith("fc") || head.startsWith("fd")) return true; // fc00::/7 ULA
  if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  return false;
}
