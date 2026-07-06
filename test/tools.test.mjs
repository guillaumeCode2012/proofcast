import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ToolRegistry,
  DuplicateToolError,
  ToolPathEscapeError,
  resolveInRoot,
  ok,
  fail,
  createFsTools,
  createShellTool,
  createBrowserTools,
  createHttpTool,
  assertSafeHttpUrl,
  isPrivateHostname,
  UnsafeUrlError,
} from "../dist/tools/index.js";

/** A fresh registry with the jailed fs tools, plus a temp root to jail them to. */
function fsSetup(options) {
  const root = mkdtempSync(join(tmpdir(), "proofcast-tools-"));
  const registry = new ToolRegistry().registerAll(createFsTools(options));
  return { root, registry, ctx: { root } };
}

// ── registry ─────────────────────────────────────────────────────────────────

test("registry registers, looks up, and catalogues tools", () => {
  const { registry } = fsSetup();
  assert.deepEqual(
    registry.catalogue().map((t) => t.name),
    ["fs_read", "fs_write", "fs_list"],
    "registration order preserved",
  );
  assert.equal(registry.has("fs_read"), true);
  assert.equal(registry.get("fs_read")?.name, "fs_read");
  assert.equal(registry.has("nope"), false);
  // The catalogue carries the model-facing schema.
  const spec = registry.catalogue().find((t) => t.name === "fs_write");
  assert.deepEqual(spec.inputSchema.required, ["path", "content"]);
});

test("registry rejects a duplicate tool name", () => {
  const registry = new ToolRegistry();
  const tool = { name: "dup", description: "", inputSchema: {}, run: async () => ok(null) };
  registry.register(tool);
  assert.throws(() => registry.register(tool), DuplicateToolError);
});

test("registry.invoke on an unknown tool returns a structured failure (never throws)", async () => {
  const { registry, ctx } = fsSetup();
  const res = await registry.invoke("does_not_exist", {}, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown tool/);
});

test("registry.invoke wraps an unexpected tool throw as { ok:false }", async () => {
  const registry = new ToolRegistry().register({
    name: "boom",
    description: "",
    inputSchema: {},
    run: async () => {
      throw new Error("kaboom");
    },
  });
  const res = await registry.invoke("boom", {}, { root: "/" });
  assert.equal(res.ok, false);
  assert.match(res.error, /threw unexpectedly.*kaboom/);
});

// ── resolveInRoot ──────────────────────────────────────────────────────────────

test("resolveInRoot keeps in-jail paths and rejects escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "proofcast-jail-"));
  try {
    assert.equal(resolveInRoot(root, "a/b.txt"), join(root, "a", "b.txt"));
    assert.throws(() => resolveInRoot(root, "../escape"), ToolPathEscapeError);
    assert.throws(() => resolveInRoot(root, "a/../../escape"), ToolPathEscapeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fs_write / fs_read roundtrip ───────────────────────────────────────────────

test("fs_write then fs_read round-trips content and creates parent dirs", async () => {
  const { root, registry, ctx } = fsSetup();
  try {
    const w = await registry.invoke("fs_write", { path: "src/app.js", content: "export const x = 1;\n" }, ctx);
    assert.equal(w.ok, true);
    assert.equal(w.output.bytes, 20);
    assert.equal(readFileSync(join(root, "src", "app.js"), "utf8"), "export const x = 1;\n");

    const r = await registry.invoke("fs_read", { path: "src/app.js" }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.output.content, "export const x = 1;\n");
    assert.equal(r.output.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs_read caps output at maxReadBytes and flags truncation (full size still reported)", async () => {
  const { root, registry, ctx } = fsSetup({ maxReadBytes: 5 });
  try {
    await registry.invoke("fs_write", { path: "big.txt", content: "abcdefghij" }, ctx);
    const r = await registry.invoke("fs_read", { path: "big.txt" }, ctx);
    assert.equal(r.output.content, "abcde", "truncated to the cap");
    assert.equal(r.output.truncated, true);
    assert.equal(r.output.bytes, 10, "still reports the true byte size");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs_read on a missing file fails cleanly (no throw)", async () => {
  const { root, registry, ctx } = fsSetup();
  try {
    const r = await registry.invoke("fs_read", { path: "ghost.txt" }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fs_list ────────────────────────────────────────────────────────────────────

test("fs_list returns typed entries and defaults to the root", async () => {
  const { root, registry, ctx } = fsSetup();
  try {
    await registry.invoke("fs_write", { path: "a.txt", content: "x" }, ctx);
    await registry.invoke("fs_write", { path: "sub/b.txt", content: "y" }, ctx);
    const r = await registry.invoke("fs_list", {}, ctx);
    assert.equal(r.ok, true);
    const byName = Object.fromEntries(r.output.entries.map((e) => [e.name, e.type]));
    assert.equal(byName["a.txt"], "file");
    assert.equal(byName["sub"], "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs_list caps entries at maxListEntries", async () => {
  const { root, registry, ctx } = fsSetup({ maxListEntries: 2 });
  try {
    for (const name of ["a", "b", "c", "d"]) {
      await registry.invoke("fs_write", { path: `${name}.txt`, content: "x" }, ctx);
    }
    const r = await registry.invoke("fs_list", {}, ctx);
    assert.equal(r.output.entries.length, 2);
    assert.equal(r.output.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── jail enforcement ───────────────────────────────────────────────────────────

test("fs tools refuse path traversal and write NOTHING outside the root", async () => {
  const { root, registry, ctx } = fsSetup();
  try {
    const w = await registry.invoke("fs_write", { path: "../escape.txt", content: "nope" }, ctx);
    assert.equal(w.ok, false);
    assert.match(w.error, /outside the tool root/);
    assert.equal(existsSync(join(root, "..", "escape.txt")), false, "nothing was written outside the jail");

    const r = await registry.invoke("fs_read", { path: "../../etc/passwd" }, ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /outside the tool root/);

    const l = await registry.invoke("fs_list", { path: ".." }, ctx);
    assert.equal(l.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── input validation ───────────────────────────────────────────────────────────

test("fs tools validate untrusted input", async () => {
  const { root, registry, ctx } = fsSetup();
  try {
    assert.equal((await registry.invoke("fs_read", {}, ctx)).ok, false, "missing path");
    assert.equal((await registry.invoke("fs_read", { path: 42 }, ctx)).ok, false, "non-string path");
    assert.equal((await registry.invoke("fs_write", { path: "a.txt" }, ctx)).ok, false, "missing content");
    // content === "" is valid: an empty file is a legitimate write.
    const empty = await registry.invoke("fs_write", { path: "empty.txt", content: "" }, ctx);
    assert.equal(empty.ok, true);
    assert.equal(empty.output.bytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ok/fail build the documented shapes", () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, output: { a: 1 } });
  assert.deepEqual(fail("boom"), { ok: false, error: "boom" });
});

// ── shell_run (sandboxed, injected runner) ────────────────────────────────────

/** A registry holding only shell_run, with an injected runner recording its calls. */
function shellSetup(runResultOrThrow) {
  const calls = [];
  const runner = async (codeDir, command, opts) => {
    calls.push({ codeDir, command, opts });
    if (typeof runResultOrThrow === "function") return runResultOrThrow();
    return runResultOrThrow;
  };
  const registry = new ToolRegistry().register(createShellTool({ runner }));
  return { registry, calls, ctx: { root: "/jail" } };
}

test("shell_run runs in the sandbox and forwards the jail root + command", async () => {
  const { registry, calls, ctx } = shellSetup({ exitCode: 0, output: "done", timedOut: false, truncated: false });
  const res = await registry.invoke("shell_run", { command: "ls -la" }, ctx);

  assert.equal(res.ok, true);
  assert.equal(res.output.exitCode, 0);
  assert.equal(res.output.output, "done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].codeDir, "/jail", "runs jailed to the tool root");
  assert.equal(calls[0].command, "ls -la");
});

test("shell_run: a non-zero exit is a SUCCESSFUL tool call (exitCode in output, not an error)", async () => {
  const { registry, ctx } = shellSetup({ exitCode: 2, output: "tsc error", timedOut: false, truncated: false });
  const res = await registry.invoke("shell_run", { command: "tsc" }, ctx);
  assert.equal(res.ok, true, "the tool ran the command successfully");
  assert.equal(res.output.exitCode, 2, "the command's failure is reported, not thrown");
});

test("shell_run surfaces a timed-out command", async () => {
  const { registry, ctx } = shellSetup({ exitCode: 137, output: "", timedOut: true, truncated: false });
  const res = await registry.invoke("shell_run", { command: "sleep 999" }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.output.timedOut, true);
});

test("shell_run fails cleanly when the sandbox itself can't run (Docker down)", async () => {
  const { registry, ctx } = shellSetup(() => {
    throw new Error("Docker n'est pas installé");
  });
  const res = await registry.invoke("shell_run", { command: "echo hi" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /could not execute in the sandbox/i);
});

test("shell_run validates its input", async () => {
  const { registry, calls, ctx } = shellSetup({ exitCode: 0, output: "", timedOut: false, truncated: false });
  assert.equal((await registry.invoke("shell_run", {}, ctx)).ok, false, "missing command");
  assert.equal((await registry.invoke("shell_run", { command: "" }, ctx)).ok, false, "empty command");
  assert.equal(calls.length, 0, "never reaches the sandbox on bad input");
});

// ── browser_* (injected fake session) ─────────────────────────────────────────

/** A fake BrowserSession that records how it was driven; no Chromium is launched. */
function fakeBrowser(overrides = {}) {
  const calls = [];
  const track = (name, fn) => async (...args) => {
    calls.push({ name, args });
    return fn ? fn(...args) : undefined;
  };
  return {
    calls,
    goto: overrides.goto ?? track("goto", (url) => ({ status: 200, url })),
    click: overrides.click ?? track("click"),
    fill: overrides.fill ?? track("fill"),
    extractText: overrides.extractText ?? track("extractText", () => "Hello world"),
    extractHtml: overrides.extractHtml ?? track("extractHtml", () => "<p>Hello</p>"),
    screenshot: overrides.screenshot ?? track("screenshot", () => Buffer.from("PNGDATA")),
    close: overrides.close ?? track("close"),
  };
}

function browserSetup(overrides, options) {
  const session = fakeBrowser(overrides);
  const registry = new ToolRegistry().registerAll(createBrowserTools(session, options));
  return { session, registry };
}

test("browser_goto navigates and reports status + final url", async () => {
  const { session, registry } = browserSetup();
  const res = await registry.invoke("browser_goto", { url: "https://x.test/" }, { root: "/jail" });
  assert.equal(res.ok, true);
  assert.equal(res.output.status, 200);
  assert.equal(res.output.url, "https://x.test/");
  assert.deepEqual(session.calls.find((c) => c.name === "goto").args, ["https://x.test/"]);
});

test("browser_click and browser_fill forward selector/value (empty value is valid)", async () => {
  const { session, registry } = browserSetup();
  assert.equal((await registry.invoke("browser_click", { selector: "button.go" }, { root: "/j" })).ok, true);
  assert.equal((await registry.invoke("browser_fill", { selector: "#email", value: "a@b.co" }, { root: "/j" })).ok, true);
  assert.equal((await registry.invoke("browser_fill", { selector: "#clear", value: "" }, { root: "/j" })).ok, true);
  assert.deepEqual(session.calls.find((c) => c.name === "click").args, ["button.go"]);
  assert.deepEqual(session.calls.find((c) => c.name === "fill").args, ["#email", "a@b.co"]);
});

test("browser_extract returns text by default, html on request, scoped by selector", async () => {
  const { registry } = browserSetup();
  const t = await registry.invoke("browser_extract", {}, { root: "/j" });
  assert.equal(t.output.format, "text");
  assert.equal(t.output.content, "Hello world");
  assert.equal(t.output.selector, null, "whole page when no selector");

  const h = await registry.invoke("browser_extract", { format: "html", selector: "main" }, { root: "/j" });
  assert.equal(h.output.format, "html");
  assert.equal(h.output.selector, "main");
  assert.equal(h.output.content, "<p>Hello</p>");
});

test("browser_extract caps output at maxExtractBytes", async () => {
  const { registry } = browserSetup({ extractText: async () => "0123456789" }, { maxExtractBytes: 4 });
  const r = await registry.invoke("browser_extract", {}, { root: "/j" });
  assert.equal(r.output.content, "0123");
  assert.equal(r.output.truncated, true);
});

test("browser_screenshot writes the PNG inside the jail and returns its path", async () => {
  const root = mkdtempSync(join(tmpdir(), "proofcast-shot-"));
  try {
    const { registry } = browserSetup();
    const r = await registry.invoke("browser_screenshot", { path: "shots/p.png" }, { root });
    assert.equal(r.ok, true);
    assert.equal(r.output.path, "shots/p.png");
    assert.equal(r.output.bytes, 7); // "PNGDATA"
    assert.equal(readFileSync(join(root, "shots", "p.png"), "utf8"), "PNGDATA");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser_screenshot refuses a path outside the jail", async () => {
  const root = mkdtempSync(join(tmpdir(), "proofcast-shot2-"));
  try {
    const { registry } = browserSetup();
    const r = await registry.invoke("browser_screenshot", { path: "../evil.png" }, { root });
    assert.equal(r.ok, false);
    assert.match(r.error, /outside the tool root/);
    assert.equal(existsSync(join(root, "..", "evil.png")), false, "nothing written outside the jail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser_close closes the shared session", async () => {
  const { session, registry } = browserSetup();
  const r = await registry.invoke("browser_close", {}, { root: "/j" });
  assert.equal(r.ok, true);
  assert.ok(session.calls.some((c) => c.name === "close"));
});

test("browser tools validate input and turn a session error into ok:false", async () => {
  const { registry } = browserSetup({
    goto: async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
  });
  assert.equal((await registry.invoke("browser_goto", {}, { root: "/j" })).ok, false, "missing url");
  assert.equal((await registry.invoke("browser_click", {}, { root: "/j" })).ok, false, "missing selector");
  assert.equal((await registry.invoke("browser_fill", { selector: "#a" }, { root: "/j" })).ok, false, "missing value");

  const navErr = await registry.invoke("browser_goto", { url: "https://x" }, { root: "/j" });
  assert.equal(navErr.ok, false, "a session throw becomes a structured failure");
  assert.match(navErr.error, /browser_goto failed.*ERR_NAME_NOT_RESOLVED/);
});

// ── http_fetch (injected fetcher) ─────────────────────────────────────────────

/** Build a minimal fetch-Response-like object for the fake transport. */
function mkResponse({ status = 200, url = "https://x.test/", contentType = "text/html", body = "" } = {}) {
  return {
    status,
    url,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

/** A registry holding only http_fetch, with an injected fetcher recording calls. */
function httpSetup(handler, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const registry = new ToolRegistry().register(createHttpTool({ fetcher, ...options }));
  return { registry, calls, ctx: { root: "/jail" } };
}

test("http_fetch GETs by default and reports status, final url, content type and body", async () => {
  const { registry, calls, ctx } = httpSetup(() =>
    mkResponse({ status: 200, url: "https://x.test/final", contentType: "text/plain", body: "hello" }),
  );
  const res = await registry.invoke("http_fetch", { url: "https://x.test/" }, ctx);

  assert.equal(res.ok, true);
  assert.equal(res.output.status, 200);
  assert.equal(res.output.url, "https://x.test/final", "reports the post-redirect URL");
  assert.equal(res.output.contentType, "text/plain");
  assert.equal(res.output.body, "hello");
  assert.equal(res.output.truncated, false);
  assert.equal(calls[0].init.method, "GET", "GET is the default method");
});

test("http_fetch POST forwards method, headers and body", async () => {
  const { registry, calls, ctx } = httpSetup(() => mkResponse({ status: 201, body: "created" }));
  const res = await registry.invoke(
    "http_fetch",
    { url: "https://api.test/items", method: "POST", headers: { "x-token": "t1" }, body: '{"a":1}' },
    ctx,
  );
  assert.equal(res.ok, true);
  assert.equal(res.output.status, 201);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-token"], "t1");
  assert.equal(calls[0].init.body, '{"a":1}');
});

test("http_fetch: a non-2xx status is a RESULT, not an error (like a shell exit code)", async () => {
  const { registry, ctx } = httpSetup(() => mkResponse({ status: 404, body: "not found" }));
  const res = await registry.invoke("http_fetch", { url: "https://x.test/missing" }, ctx);
  assert.equal(res.ok, true, "the fetch itself succeeded");
  assert.equal(res.output.status, 404, "the agent reads the status and decides");
});

test("http_fetch parses JSON when complete; leaves json undefined when invalid", async () => {
  const okJson = httpSetup(() => mkResponse({ contentType: "application/json", body: '{"a":1}' }));
  const r1 = await okJson.registry.invoke("http_fetch", { url: "https://api.test/" }, okJson.ctx);
  assert.deepEqual(r1.output.json, { a: 1 });

  const badJson = httpSetup(() => mkResponse({ contentType: "application/json", body: "{oops" }));
  const r2 = await badJson.registry.invoke("http_fetch", { url: "https://api.test/" }, badJson.ctx);
  assert.equal(r2.ok, true);
  assert.equal(r2.output.json, undefined, "invalid JSON body → no json field, still ok");
});

test("http_fetch caps the body at maxBodyBytes and skips json when truncated", async () => {
  const { registry, ctx } = httpSetup(
    () => mkResponse({ contentType: "application/json", body: '{"key":"0123456789"}' }),
    { maxBodyBytes: 4 },
  );
  const res = await registry.invoke("http_fetch", { url: "https://x.test/big" }, ctx);
  assert.equal(res.output.body, '{"ke');
  assert.equal(res.output.truncated, true);
  assert.equal(res.output.json, undefined, "no json for an incomplete payload");
});

test("http_fetch refuses non-http(s) URLs and bad input BEFORE any request", async () => {
  const { registry, calls, ctx } = httpSetup(() => mkResponse());
  assert.equal((await registry.invoke("http_fetch", { url: "file:///etc/passwd" }, ctx)).ok, false);
  assert.equal((await registry.invoke("http_fetch", { url: "ftp://x.test/" }, ctx)).ok, false);
  assert.equal((await registry.invoke("http_fetch", { url: "not a url" }, ctx)).ok, false);
  assert.equal((await registry.invoke("http_fetch", {}, ctx)).ok, false, "missing url");
  assert.equal(
    (await registry.invoke("http_fetch", { url: "https://x.test/", method: "DELETE" }, ctx)).ok,
    false,
    "only GET/POST",
  );
  assert.equal(
    (await registry.invoke("http_fetch", { url: "https://x.test/", headers: { n: 42 } }, ctx)).ok,
    false,
    "non-string header value",
  );
  assert.equal(
    (await registry.invoke("http_fetch", { url: "https://x.test/", body: "x" }, ctx)).ok,
    false,
    "body without POST",
  );
  assert.equal(calls.length, 0, "no request was ever made on invalid input");
});

test("http_fetch turns a network error into a structured failure", async () => {
  const { registry, ctx } = httpSetup(() => {
    throw new Error("getaddrinfo ENOTFOUND x.test");
  });
  const res = await registry.invoke("http_fetch", { url: "https://x.test/" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /http_fetch failed.*ENOTFOUND/);
});

test("http_fetch aborts past the timeout and reports it", async () => {
  const { registry, ctx } = httpSetup(
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    { timeoutMs: 20 },
  );
  const res = await registry.invoke("http_fetch", { url: "https://slow.test/" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out after 20 ms/);
});

// ── SSRF url-guard (15.3) ─────────────────────────────────────────────────────

test("isPrivateHostname flags loopback, private ranges, link-local/metadata and IPv6", () => {
  for (const h of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.1",
    "172.16.5.5",
    "172.31.255.255",
    "169.254.169.254", // cloud metadata
    "100.100.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1234",
  ]) {
    assert.equal(isPrivateHostname(h), true, `${h} must be private`);
  }
  for (const h of ["example.com", "8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1"]) {
    assert.equal(isPrivateHostname(h), false, `${h} must be public`);
  }
});

test("assertSafeHttpUrl blocks non-http(s) and private hosts, allows public, honors allowPrivate", () => {
  assert.throws(() => assertSafeHttpUrl("file:///etc/passwd"), UnsafeUrlError);
  assert.throws(() => assertSafeHttpUrl("http://169.254.169.254/latest/meta-data/"), UnsafeUrlError);
  assert.throws(() => assertSafeHttpUrl("http://localhost:3000/"), UnsafeUrlError);
  assert.equal(assertSafeHttpUrl("https://example.com/x").hostname, "example.com");
  // Opt-in override (e.g. testing a locally-served project).
  assert.equal(assertSafeHttpUrl("http://localhost:3000/", { allowPrivate: true }).hostname, "localhost");
});

test("http_fetch blocks a private URL by default, allows it with allowPrivate", async () => {
  const blocked = httpSetup(() => mkResponse());
  const r1 = await blocked.registry.invoke("http_fetch", { url: "http://169.254.169.254/" }, blocked.ctx);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /private\/loopback/);
  assert.equal(blocked.calls.length, 0, "no request made to the metadata endpoint");

  const allowed = httpSetup(() => mkResponse({ body: "ok" }), { allowPrivate: true });
  const r2 = await allowed.registry.invoke("http_fetch", { url: "http://127.0.0.1:8080/" }, allowed.ctx);
  assert.equal(r2.ok, true, "opt-in reaches the local service");
});

test("browser_goto blocks a private URL by default (SSRF guard) and never touches the session", async () => {
  const { session, registry } = browserSetup();
  const res = await registry.invoke("browser_goto", { url: "http://localhost:5173/" }, { root: "/j" });
  assert.equal(res.ok, false);
  assert.match(res.error, /private\/loopback/);
  assert.equal(session.calls.length, 0, "the browser never navigated");

  const { session: s2, registry: r2 } = browserSetup(undefined, { allowPrivate: true });
  const okRes = await r2.invoke("browser_goto", { url: "http://localhost:5173/" }, { root: "/j" });
  assert.equal(okRes.ok, true);
  assert.ok(s2.calls.some((c) => c.name === "goto"));
});
