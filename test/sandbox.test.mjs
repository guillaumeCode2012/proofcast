import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DockerNotAvailableError,
  SANDBOX_IMAGE,
  SandboxPortInUseError,
  isDockerAvailable,
  startSandbox,
  stopSandbox,
  runInSandbox,
} from "../dist/sandbox.js";

/** A fake dockerode client + container that records how it was driven. */
function mockDocker(overrides = {}) {
  const created = [];
  const container = {
    id: "fake-container-id",
    started: false,
    stopCalls: [],
    removeCalls: [],
    start: overrides.start ?? (async () => {
      container.started = true;
    }),
    stop: overrides.stop ?? (async (opts) => {
      container.stopCalls.push(opts);
    }),
    remove: overrides.remove ?? (async (opts) => {
      container.removeCalls.push(opts);
    }),
  };
  const docker = {
    createContainer:
      overrides.createContainer ??
      (async (config) => {
        created.push(config);
        return container;
      }),
  };
  return { docker, container, created };
}

const noopCheck = () => {};

test("startSandbox passes the correct image, command, volume bind and port mapping", async () => {
  const { docker, container, created } = mockDocker();
  const codeDir = join(tmpdir(), "proofcast-project");

  const returned = await startSandbox(codeDir, 8080, { docker, checkDocker: noopCheck });

  assert.equal(returned, container, "returns the started container");
  assert.equal(created.length, 1, "created exactly one container");

  const cfg = created[0];
  assert.equal(cfg.Image, SANDBOX_IMAGE);
  assert.equal(cfg.Image, "node:20-alpine");
  assert.deepEqual(cfg.Cmd, ["sh", "-c", "npm install && npm run build && npm run start"]);
  assert.equal(cfg.WorkingDir, "/app");
  assert.deepEqual(cfg.ExposedPorts, { "3000/tcp": {} });
  assert.deepEqual(cfg.HostConfig.Binds, [`${resolve(codeDir)}:/app:rw`], "read/write bind mount");
  assert.deepEqual(
    cfg.HostConfig.PortBindings,
    { "3000/tcp": [{ HostPort: "8080" }] },
    "internal 3000 → host 8080",
  );
  assert.equal(container.started, true, "the container was started");
});

test("startSandbox maps host 3000 by default", async () => {
  const { docker, created } = mockDocker();
  await startSandbox("/some/dir", undefined, { docker, checkDocker: noopCheck });
  assert.deepEqual(created[0].HostConfig.PortBindings, { "3000/tcp": [{ HostPort: "3000" }] });
});

test("startSandbox throws SandboxPortInUseError and cleans up the container on a port clash", async () => {
  const { docker, container } = mockDocker({
    start: async () => {
      throw new Error(
        "driver failed programming external connectivity: Bind for 0.0.0.0:3000 failed: port is already allocated",
      );
    },
  });

  await assert.rejects(
    () => startSandbox("/p", 3000, { docker, checkDocker: noopCheck }),
    SandboxPortInUseError,
  );
  assert.equal(container.removeCalls.length, 1, "the half-created container was removed");
});

test("startSandbox throws DockerNotAvailableError and never creates a container when Docker is absent", async () => {
  const { docker, created } = mockDocker();
  await assert.rejects(
    () =>
      startSandbox("/p", 3000, {
        docker,
        checkDocker: () => {
          throw new Error("'docker' is not recognized");
        },
      }),
    DockerNotAvailableError,
  );
  assert.equal(created.length, 0, "no container created without Docker");
});

test("stopSandbox stops (with a timeout) then force-removes the container", async () => {
  const { container } = mockDocker();
  await stopSandbox(container, 7);
  assert.deepEqual(container.stopCalls, [{ t: 7 }], "stopped with the given timeout");
  assert.equal(container.removeCalls.length, 1);
  assert.equal(container.removeCalls[0].force, true, "force-removed");
});

test("stopSandbox is idempotent: already-stopped / already-removed never throws", async () => {
  const { container } = mockDocker({
    stop: async () => {
      const err = new Error("Container already stopped");
      err.statusCode = 304;
      throw err;
    },
    remove: async () => {
      const err = new Error("No such container");
      err.statusCode = 404;
      throw err;
    },
  });
  await assert.doesNotReject(() => stopSandbox(container));
});

test("stopSandbox tolerates an undefined container", async () => {
  await assert.doesNotReject(() => stopSandbox(undefined));
});

test("isDockerAvailable reflects whether the daemon probe succeeds", () => {
  assert.equal(isDockerAvailable(() => {}), true, "probe ok → available");
  assert.equal(
    isDockerAvailable(() => {
      throw new Error("Cannot connect to the Docker daemon");
    }),
    false,
    "probe throws → not available",
  );
});

// A light REAL end-to-end test — only runs when a Docker daemon is actually up.
test(
  "integration (real Docker): start then stop a container",
  { skip: dockerDaemonRunning() ? false : "Docker daemon not running in this environment" },
  async () => {
    // A trivial command avoids needing a real package.json for install/build.
    const container = await startSandbox(process.cwd(), 0, {
      command: ["sh", "-c", "sleep 30"],
    });
    try {
      const info = await container.inspect();
      assert.equal(info.State.Running, true, "container is running");
    } finally {
      await stopSandbox(container);
    }
    // After stop, inspecting the removed container must fail.
    await assert.rejects(() => container.inspect());
  },
);

/** True if a Docker daemon is reachable (not just the CLI installed). */
function dockerDaemonRunning() {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── runInSandbox (mock dockerode) ────────────────────────────────────────────

/** A fake dockerode whose container runs ONE command to completion. */
function mockRunDocker({ statusCode = 0, hang = false, logs = "hello\n" } = {}) {
  let resolveWait;
  const waitPromise = new Promise((res) => {
    resolveWait = res;
  });
  if (!hang) resolveWait({ StatusCode: statusCode });

  const container = {
    started: false,
    stopCalls: [],
    removeCalls: [],
    start: async () => {
      container.started = true;
    },
    wait: async () => waitPromise,
    logs: async () => Buffer.from(logs, "utf8"),
    stop: async (opts) => {
      container.stopCalls.push(opts);
      resolveWait({ StatusCode: 137 }); // killed
    },
    remove: async (opts) => {
      container.removeCalls.push(opts);
    },
  };
  const created = [];
  const docker = {
    createContainer: async (cfg) => {
      created.push(cfg);
      return container;
    },
  };
  return { docker, container, created };
}

test("runInSandbox runs a command to completion and returns exit code + output", async () => {
  const { docker, container, created } = mockRunDocker({ statusCode: 0, logs: "build ok\n" });
  const res = await runInSandbox("/proj", "npm run build", { docker, checkDocker: noopCheck });

  assert.equal(res.exitCode, 0);
  assert.equal(res.output, "build ok\n");
  assert.equal(res.timedOut, false);
  assert.deepEqual(created[0].Cmd, ["sh", "-c", "npm run build"], "command passed via sh -c");
  assert.equal(created[0].Tty, true, "Tty on → clean combined output");
  assert.deepEqual(created[0].HostConfig.Binds, [`${resolve("/proj")}:/app:rw`], "project bind-mounted");
  assert.equal(container.removeCalls.length, 1, "container always removed");
});

test("runInSandbox surfaces a non-zero exit as a RESULT, not a throw", async () => {
  const { docker, container } = mockRunDocker({ statusCode: 2, logs: "error TS1005\n" });
  const res = await runInSandbox("/proj", "tsc", { docker, checkDocker: noopCheck });
  assert.equal(res.exitCode, 2);
  assert.match(res.output, /error TS1005/);
  assert.equal(container.removeCalls.length, 1);
});

test("runInSandbox kills and flags a command that exceeds the timeout, then cleans up", async () => {
  const { docker, container } = mockRunDocker({ hang: true });
  // runInSandbox's timeout timer is unref'd (so a fast command never keeps the
  // process alive). Here the mock hangs with no active handle, so on Node 20 the
  // event loop can drain before that 20 ms timer fires — cancelling the test. A
  // ref'd keep-alive holds the loop open across the await; cleared right after.
  const keepAlive = setInterval(() => {}, 1_000_000);
  try {
    const res = await runInSandbox("/proj", "sleep 999", {
      docker,
      checkDocker: noopCheck,
      timeoutMs: 20,
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.exitCode, 137, "reaped the killed status");
    assert.ok(container.stopCalls.length >= 1, "the container was stopped");
    assert.equal(container.removeCalls.length, 1, "…and removed — nothing leaks");
  } finally {
    clearInterval(keepAlive);
  }
});

test("runInSandbox caps output at maxOutputBytes", async () => {
  const { docker } = mockRunDocker({ statusCode: 0, logs: "0123456789" });
  const res = await runInSandbox("/proj", "cat big", {
    docker,
    checkDocker: noopCheck,
    maxOutputBytes: 4,
  });
  assert.equal(res.output, "0123");
  assert.equal(res.truncated, true);
});

test("runInSandbox omits NetworkMode by default and sets it when hardened to 'none'", async () => {
  const def = mockRunDocker();
  await runInSandbox("/proj", "npm install", { docker: def.docker, checkDocker: noopCheck });
  assert.equal(def.created[0].HostConfig.NetworkMode, undefined, "default: Docker networking (npm needs it)");

  const iso = mockRunDocker();
  await runInSandbox("/proj", "node evil.js", { docker: iso.docker, checkDocker: noopCheck, network: "none" });
  assert.equal(iso.created[0].HostConfig.NetworkMode, "none", "hardened: no network at all");
});

test("runInSandbox throws DockerNotAvailableError when Docker is absent", async () => {
  await assert.rejects(
    () =>
      runInSandbox("/proj", "echo hi", {
        checkDocker: () => {
          throw new Error("'docker' is not recognized");
        },
      }),
    DockerNotAvailableError,
  );
});
