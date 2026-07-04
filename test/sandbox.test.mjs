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
