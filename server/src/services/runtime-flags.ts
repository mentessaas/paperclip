/**
 * Runtime flags — ZAL-90 (anti-spoofing C-4).
 *
 * Holds the in-process values for control-plane kill switches that the board
 * can toggle without redeploying. The flagship flag is
 * `recovery.pause.codeGates`: when `true`, the `in_review -> done` gate
 * refuses every transition on a code-bearing issue with
 * `409 RecoveryPausedUntilGitGate` until the board sets it back to `false`.
 *
 * Defaults are resolved once at module load:
 *   - `runtime.flags.<key>` (lowercased env var) overrides everything.
 *   - otherwise the per-key default declared in `FLAG_DEFAULTS` applies.
 *
 * The board-only endpoint `PATCH /api/companies/:companyId/runtime-flags`
 * mutates the in-process store and writes an activity-log entry so the
 * change is auditable.
 *
 * NOTE: the store is per-process. In a multi-replica deployment each
 * replica must be restarted (or the env var updated) to converge. This
 * is acceptable for ZAL-90 because the flag exists as a safety net during
 * the C-1/C-2/C-3 rollout; once the SHA + peer gate ships the flag is
 * retired.
 */

export type RuntimeFlagKey = "recovery.pause.codeGates";

export type RuntimeFlagSnapshot = Record<RuntimeFlagKey, boolean> & {
  updatedAt: string;
  updatedByUserId: string | null;
};

const FLAG_DEFAULTS: Record<RuntimeFlagKey, boolean> = {
  // Default ON: while C-1+C-2 (ZAL-88, ZAL-89) are landing, no code issue
  // should be able to auto-transition to `done` without the board
  // explicitly lifting the pause. The board sets this to `false` only
  // once the SHA gate is observably healthy in production.
  "recovery.pause.codeGates": true,
};

function envOverride(key: RuntimeFlagKey): boolean | null {
  // Convert dotted+camelCase key to SCREAMING_SNAKE_CASE:
  //   recovery.pause.codeGates -> RECOVERY_PAUSE_CODE_GATES
  const envKey =
    "PAPERCLIP_RUNTIME_FLAG_" +
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toUpperCase();
  const raw = process.env[envKey];
  if (raw === undefined) return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  // Treat malformed env as "no override" so a typo does not silently flip
  // the default. Surface a console warning to aid debugging.
  console.warn(
    `[runtime-flags] ignoring invalid value '${raw}' for ${envKey} (expected true|false|1|0)`,
  );
  return null;
}

function resolveInitial(key: RuntimeFlagKey): boolean {
  return envOverride(key) ?? FLAG_DEFAULTS[key];
}

export type RuntimeFlagAuditLogger = (input: {
  flag: RuntimeFlagKey;
  previousValue: boolean;
  nextValue: boolean;
  actorUserId: string | null;
  reason?: string | null;
}) => Promise<void> | void;

export function runtimeFlagService(opts: { audit?: RuntimeFlagAuditLogger } = {}) {
  const state: Record<RuntimeFlagKey, { value: boolean; updatedAt: Date; updatedByUserId: string | null }> = {
    "recovery.pause.codeGates": {
      value: resolveInitial("recovery.pause.codeGates"),
      updatedAt: new Date(),
      updatedByUserId: null,
    },
  };

  function snapshot(): RuntimeFlagSnapshot {
    const out = {} as RuntimeFlagSnapshot;
    (Object.keys(state) as RuntimeFlagKey[]).forEach((k) => {
      out[k] = state[k].value;
    });
    // updatedAt + updatedByUserId are derived from the most-recent write
    // across all flags; for ZAL-90 we only have one key so this collapses
    // cleanly. When more flags are added we should track per-key timestamps.
    const latest = (Object.values(state) as Array<{ updatedAt: Date; updatedByUserId: string | null }>)
      .reduce((acc, cur) => (cur.updatedAt > acc.updatedAt ? cur : acc), state["recovery.pause.codeGates"]);
    out.updatedAt = latest.updatedAt.toISOString();
    out.updatedByUserId = latest.updatedByUserId;
    return out;
  }

  function get(key: RuntimeFlagKey): boolean {
    const entry = state[key];
    if (!entry) throw new Error(`unknown runtime flag: ${key}`);
    return entry.value;
  }

  async function set(input: {
    key: RuntimeFlagKey;
    value: boolean;
    actorUserId: string | null;
    reason?: string | null;
  }): Promise<RuntimeFlagSnapshot> {
    const entry = state[input.key];
    if (!entry) throw new Error(`unknown runtime flag: ${input.key}`);
    const previousValue = entry.value;
    if (previousValue === input.value) return snapshot();
    entry.value = input.value;
    entry.updatedAt = new Date();
    entry.updatedByUserId = input.actorUserId;
    if (opts.audit) {
      try {
        await opts.audit({
          flag: input.key,
          previousValue,
          nextValue: input.value,
          actorUserId: input.actorUserId,
          reason: input.reason ?? null,
        });
      } catch (err) {
        // Audit failure must not leave the in-process state out of sync
        // with the activity log. Roll back so the operator sees the
        // mismatch instead of an inconsistent record.
        entry.value = previousValue;
        entry.updatedAt = new Date();
        entry.updatedByUserId = input.actorUserId;
        throw err;
      }
    }
    return snapshot();
  }

  return { get, set, snapshot };
}

// Module-level singleton so the route and the gate share state. Tests
// should not import this directly — they construct their own service
// instance to keep state isolated.
let _defaultService: ReturnType<typeof runtimeFlagService> | null = null;

export function defaultRuntimeFlagService() {
  if (!_defaultService) _defaultService = runtimeFlagService();
  return _defaultService;
}

export const KNOWN_RUNTIME_FLAGS = Object.keys(FLAG_DEFAULTS) as RuntimeFlagKey[];
