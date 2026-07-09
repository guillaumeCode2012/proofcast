/**
 * ProofCast gate — the proof-before-deploy rule, expressed as an agent {@link ToolGuard}.
 *
 * {@link createProofGate} returns a guard for {@link runAgent} that vetoes a set of
 * IRREVERSIBLE tools (opening a PR, deploying…) unless a passing proof exists in
 * the current session. It is the same "no proof, no prod" discipline the Telegram
 * bot enforces on « Déploie », now available to the autonomous agent loop.
 *
 * The guard is fail-closed by construction: `runAgent` already treats a guard that
 * throws as a veto, and this guard blocks whenever `isProofReady()` is not strictly
 * true — so a missing or broken proof signal never lets an irreversible action slip.
 */

import type { ToolGuard } from "./agent.js";

export interface ProofGateOptions {
  /** Tool names that require a passing proof before they may run. */
  protectedTools: Iterable<string>;
  /** Predicate: does a passing proof exist for this session right now? */
  isProofReady: () => boolean;
  /** Custom veto message (a `{tool}` placeholder is substituted). */
  reason?: string;
}

/** Default veto message when a protected tool is blocked. */
export const DEFAULT_GATE_REASON =
  'Blocked by proof-before-deploy: "{tool}" needs a passing proof (a recorded « Démo ») first. No proof, no prod.';

/**
 * Build a {@link ToolGuard} enforcing proof-before-deploy on `protectedTools`.
 * Unprotected tools always pass; a protected tool passes only when `isProofReady()`
 * returns strictly `true`.
 */
export function createProofGate(options: ProofGateOptions): ToolGuard {
  const protectedSet = new Set(options.protectedTools);
  const template = options.reason ?? DEFAULT_GATE_REASON;

  return (tool) => {
    if (!protectedSet.has(tool)) {
      return { allow: true };
    }
    if (options.isProofReady() === true) {
      return { allow: true };
    }
    return { allow: false, reason: template.replace("{tool}", tool) };
  };
}
