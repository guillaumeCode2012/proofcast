/**
 * ProofCast Docker sandbox.
 *
 * Isolates every ProofCast run inside a throwaway `node:20-alpine` container so
 * generated (and possibly broken) code can install, build, and serve itself
 * WITHOUT touching the user's machine. The project directory is bind-mounted
 * read/write and the container's internal port 3000 is published to a host port
 * that Playwright then drives.
 *
 * Contract:
 *   - {@link startSandbox} verifies Docker is present, creates+starts the
 *     container, and fails with a CLEAR error (never a silent crash) when Docker
 *     is missing/stopped or the host port is already taken — cleaning up any
 *     half-created container on the way out.
 *   - {@link stopSandbox} stops then removes the container and is fully
 *     idempotent: calling it on an already-stopped/removed (or undefined)
 *     container never throws.
 *
 * dockerode is heavy, so — like the other providers — it is lazy-loaded on first
 * real use; tests inject a mock `docker` instead of touching a daemon.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

// Type-only: the runtime module is lazy-loaded inside startSandbox.
import type Docker from "dockerode";

/** Base image the sandbox container runs. */
export const SANDBOX_IMAGE = "node:20-alpine";

/** Port the app is expected to listen on INSIDE the container. */
export const SANDBOX_INTERNAL_PORT = 3000;

/** Working directory the project is mounted at inside the container. */
export const SANDBOX_WORKDIR = "/app";

/** The one command the container runs: install, build, then start the app. */
export const SANDBOX_COMMAND = ["sh", "-c", "npm install && npm run build && npm run start"];

/** Default grace period (seconds) given to a container to stop before it is killed. */
export const DEFAULT_STOP_TIMEOUT_SEC = 10;

/**
 * True when a usable Docker is available — i.e. the daemon actually responds
 * (`docker info`), not merely that the CLI is installed. This is the up-front
 * check the orchestrator/bot use to decide between the Docker sandbox and the
 * local fallback. Never throws.
 */
export function isDockerAvailable(check?: () => void): boolean {
  const probe = check ?? (() => execSync("docker info", { stdio: "ignore" }));
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

/** Thrown when Docker is not installed, or its daemon is not running. */
export class DockerNotAvailableError extends Error {
  constructor(detail = "Docker n'est pas installé ou n'est pas accessible.") {
    super(
      `${detail} ProofCast exécute le code dans un conteneur isolé (${SANDBOX_IMAGE}) et a donc besoin ` +
        `de Docker : installe Docker Desktop / le moteur Docker et démarre le démon, puis réessaie.`,
    );
    this.name = "DockerNotAvailableError";
  }
}

/** Thrown when the requested host port is already bound by something else. */
export class SandboxPortInUseError extends Error {
  constructor(port: number) {
    super(
      `Le port hôte ${port} est déjà utilisé — impossible d'y publier le conteneur ProofCast. ` +
        `Libère ce port (ou choisis-en un autre) puis réessaie.`,
    );
    this.name = "SandboxPortInUseError";
  }
}

export interface StartSandboxOptions {
  /** Injected dockerode instance (or a mock). Defaults to a real, lazy-loaded client. */
  docker?: Docker;
  /** Injected Docker-availability probe (defaults to `docker -v`). Lets tests skip the real CLI. */
  checkDocker?: () => void;
  /** Override the container image (default {@link SANDBOX_IMAGE}). */
  image?: string;
  /** Override the container command (default {@link SANDBOX_COMMAND}). */
  command?: string[];
}

/**
 * Start an isolated sandbox container for `codeDir`, publishing its internal
 * port 3000 to host `port`. Resolves once the container has STARTED (the app may
 * still be installing/building — callers wait for the port separately).
 *
 * @throws {DockerNotAvailableError} if Docker is missing or its daemon is down.
 * @throws {SandboxPortInUseError}   if the host `port` is already bound.
 */
export async function startSandbox(
  codeDir: string,
  port: number = SANDBOX_INTERNAL_PORT,
  options: StartSandboxOptions = {},
): Promise<Docker.Container> {
  ensureDockerAvailable(options.checkDocker);

  const docker = options.docker ?? (await createDefaultDocker());
  const image = options.image ?? SANDBOX_IMAGE;
  const portKey = `${SANDBOX_INTERNAL_PORT}/tcp`;

  let container: Docker.Container;
  try {
    container = await docker.createContainer({
      Image: image,
      Cmd: options.command ?? SANDBOX_COMMAND,
      WorkingDir: SANDBOX_WORKDIR,
      Env: [`PORT=${SANDBOX_INTERNAL_PORT}`],
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        // Bind-mount the project read/write so the container works on the real files.
        Binds: [`${resolve(codeDir)}:${SANDBOX_WORKDIR}:rw`],
        // Publish internal 3000 → the requested host port.
        PortBindings: { [portKey]: [{ HostPort: String(port) }] },
      },
      Tty: false,
    });
  } catch (err) {
    throw wrapCreateError(err, image);
  }

  try {
    await container.start();
  } catch (err) {
    // The container was created but never ran — don't leave it dangling.
    await removeQuietly(container);
    if (isPortInUse(err)) {
      throw new SandboxPortInUseError(port);
    }
    throw wrapCreateError(err, image);
  }

  return container;
}

/**
 * Stop and remove a sandbox container. Idempotent by design: a container that is
 * already stopped, already removed, or `undefined` resolves silently — this is
 * meant to run in a `finally`, where throwing would mask the real error.
 */
export async function stopSandbox(
  container: Docker.Container | undefined | null,
  timeoutSec: number = DEFAULT_STOP_TIMEOUT_SEC,
): Promise<void> {
  if (!container) {
    return;
  }
  try {
    await container.stop({ t: timeoutSec });
  } catch {
    /* already stopped / not running (304) — fine */
  }
  try {
    await container.remove({ force: true });
  } catch {
    /* already removed / no such container (404) — fine */
  }
}

// ── internals ──────────────────────────────────────────────────────────────

/** Verify Docker is reachable via the CLI; throw a clear error otherwise. */
function ensureDockerAvailable(check?: () => void): void {
  const probe = check ?? (() => execSync("docker -v", { stdio: "ignore" }));
  try {
    probe();
  } catch {
    throw new DockerNotAvailableError();
  }
}

/** Lazy-load dockerode and construct a client bound to the default daemon. */
async function createDefaultDocker(): Promise<Docker> {
  const { default: Dockerode } = await import("dockerode");
  return new Dockerode();
}

/** Best-effort container removal; never throws. */
async function removeQuietly(container: Docker.Container): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** True when an error looks like a host-port conflict from the Docker daemon. */
function isPortInUse(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /port is already allocated|address already in use|already in use|bind for .* failed/i.test(msg);
}

/**
 * Turn a low-level dockerode/daemon error into a clear ProofCast error: a
 * connection failure means the daemon is down; a missing image is spelled out.
 */
function wrapCreateError(err: unknown, image: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|ENOENT|EPIPE|connect|socket|daemon/i.test(msg)) {
    return new DockerNotAvailableError("Le démon Docker ne répond pas — est-il démarré ?");
  }
  if (/no such image|not found/i.test(msg)) {
    return new Error(
      `Image Docker introuvable : ${image}. Récupère-la avec \`docker pull ${image}\` puis réessaie.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
