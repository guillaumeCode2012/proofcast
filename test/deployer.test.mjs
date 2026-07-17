import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeploymentFailedError,
  DeploymentUrlNotFoundError,
  UnsafeArgumentError,
  VercelCliNotFoundError,
  VercelNotAuthenticatedError,
  assertSafeArg,
  deployWithVercel,
  extractDeploymentUrl,
  isVercelAuthenticated,
  looksLikeAuthError,
} from "../dist/deployer.js";

/** Real ANSI escape character. */
const ESC = String.fromCharCode(27);

/**
 * Build a mock exec that records commands and answers the `--version` probe
 * plus the deploy command.
 */
function mockExec({ versionOk = true, deploy = "" } = {}) {
  const commands = [];
  const exec = (command, options) => {
    commands.push({ command, options });
    if (command.includes("--version")) {
      if (versionOk) return "Vercel CLI 39.0.0\n";
      throw new Error("'vercel' is not recognized as a command");
    }
    return typeof deploy === "function" ? deploy(command, options) : deploy;
  };
  exec.commands = commands;
  return exec;
}

test("deployWithVercel returns the extracted production URL", () => {
  const output = [
    "Vercel CLI 39.0.0",
    `${ESC}[90m🔍  Inspect: https://vercel.com/acme/proj/abc${ESC}[39m`,
    `${ESC}[32m✅  Production: https://proj-acme.vercel.app${ESC}[39m [2s]`,
  ].join("\n");

  const exec = mockExec({ deploy: output });
  const result = deployWithVercel({ exec });

  assert.equal(result.url, "https://proj-acme.vercel.app");
  assert.ok(result.rawOutput.includes("Production"));

  // Version probe first, then the fixed deploy command.
  assert.equal(exec.commands.length, 2);
  assert.ok(exec.commands[0].command.includes("--version"));
  assert.equal(exec.commands[1].command, "vercel --yes --prod");
});

test("deployWithVercel forwards validated extra args", () => {
  const exec = mockExec({ deploy: "Production: https://x.vercel.app" });
  const result = deployWithVercel({ exec, extraArgs: ["--scope", "my-team"] });
  assert.equal(result.url, "https://x.vercel.app");
  assert.equal(exec.commands[1].command, "vercel --yes --prod --scope my-team");
});

test("extractDeploymentUrl handles the common Vercel output shapes", () => {
  // ANSI-wrapped Production line (proves ESC color codes are stripped).
  assert.equal(
    extractDeploymentUrl(`${ESC}[32mProduction: ${ESC}[36mhttps://a.vercel.app${ESC}[39m [1s]`),
    "https://a.vercel.app",
  );
  // No "Production" label → last *.vercel.app URL wins.
  assert.equal(
    extractDeploymentUrl("Inspect: https://vercel.com/x\nQueued: https://b.vercel.app"),
    "https://b.vercel.app",
  );
  // No vercel.app URL → last URL of any kind.
  assert.equal(
    extractDeploymentUrl("see https://one.example\nthen https://two.example/x"),
    "https://two.example/x",
  );
  // No URL at all.
  assert.equal(extractDeploymentUrl("nothing to see here"), null);
});

test("deployWithVercel throws VercelCliNotFoundError when the CLI is missing", () => {
  const exec = mockExec({ versionOk: false });
  assert.throws(() => deployWithVercel({ exec }), VercelCliNotFoundError);
  // The deploy command must never be attempted.
  assert.ok(!exec.commands.some((c) => c.command.includes("--prod")));
});

test("deployWithVercel surfaces build failures with captured output", () => {
  const exec = mockExec({
    deploy: () => {
      const err = new Error("Command failed: vercel --yes --prod");
      err.status = 1;
      err.stdout = "Building...\n";
      err.stderr = "Error: build failed: missing build script\n";
      throw err;
    },
  });

  assert.throws(
    () => deployWithVercel({ exec }),
    (err) =>
      err instanceof DeploymentFailedError &&
      /build failed/.test(err.stderr) &&
      /deployment failed/i.test(err.message),
  );
});

test("deployWithVercel throws DeploymentUrlNotFoundError when no URL is present", () => {
  const exec = mockExec({ deploy: "Building...\nDone, but no URL was printed.\n" });
  assert.throws(() => deployWithVercel({ exec }), DeploymentUrlNotFoundError);
});

test("deployWithVercel classifies a missing login as VercelNotAuthenticatedError (not a build failure)", () => {
  const exec = mockExec({
    deploy: () => {
      const err = new Error("Command failed: vercel --yes --prod");
      err.status = 1;
      err.stdout = "";
      err.stderr = "Error: No existing credentials found. Please run `vercel login`.\n";
      throw err;
    },
  });
  assert.throws(
    () => deployWithVercel({ exec }),
    (err) => err instanceof VercelNotAuthenticatedError && /vercel login/i.test(err.message),
  );
});

test("deployWithVercel refuses a non-existent cwd before touching the shell", () => {
  const exec = mockExec({ deploy: "Production: https://x.vercel.app" });
  const missing = join(tmpdir(), `proofcast-nope-${Math.random().toString(36).slice(2)}`);
  assert.throws(() => deployWithVercel({ exec, cwd: missing }), /n'existe pas/);
  assert.equal(exec.commands.length, 0, "must validate the cwd before running any command");
});

test("isVercelAuthenticated reflects `vercel whoami`", () => {
  const loggedIn = (command) => {
    if (command.includes("whoami")) return "guillaume\n";
    throw new Error(`unexpected command: ${command}`);
  };
  assert.equal(isVercelAuthenticated(loggedIn), true);

  const loggedOut = () => {
    throw new Error("Error: Please log in with `vercel login`.");
  };
  assert.equal(isVercelAuthenticated(loggedOut), false);
});

test("looksLikeAuthError distinguishes a login problem from a build failure", () => {
  assert.ok(looksLikeAuthError("Error: No existing credentials found. Please run `vercel login`"));
  assert.ok(looksLikeAuthError("You are not currently logged in."));
  assert.ok(!looksLikeAuthError("Error: build failed: missing build script"));
});

test("assertSafeArg rejects injection attempts and accepts safe args", () => {
  for (const bad of ["; rm -rf /", "a b", "$(whoami)", "`id`", "a|b", "a&&b", "a>b", ""]) {
    assert.throws(() => assertSafeArg(bad), UnsafeArgumentError, `should reject: ${bad}`);
  }
  for (const good of ["--scope", "my-team", "v1.2.3", "a/b_c.d", "name=value", "user@host"]) {
    assert.equal(assertSafeArg(good), good);
  }
});

test("deployWithVercel refuses an unsafe extra arg and never execs", () => {
  const exec = mockExec({ deploy: "Production: https://x.vercel.app" });
  assert.throws(
    () => deployWithVercel({ exec, extraArgs: ["; rm -rf /"] }),
    UnsafeArgumentError,
  );
  assert.equal(exec.commands.length, 0, "must validate args before touching the shell");
});
