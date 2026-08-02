import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KNOWN_RUNTIME_FLAGS,
  runtimeFlagService,
  type RuntimeFlagAuditLogger,
} from "../services/runtime-flags.js";

describe("runtimeFlagService — ZAL-90 (C-4)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Strip env overrides that could leak between tests.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PAPERCLIP_RUNTIME_FLAG_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults `recovery.pause.codeGates` to true (anti-spoofing safety net)", () => {
    const svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(true);
  });

  it("exports the known flag list", () => {
    expect(KNOWN_RUNTIME_FLAGS).toContain("recovery.pause.codeGates");
    // Only one flag today; future additions should be deliberate.
    expect(KNOWN_RUNTIME_FLAGS).toHaveLength(1);
  });

  it("env var `PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES=true|1|false|0` overrides the default", () => {
    process.env.PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES = "false";
    let svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(false);

    process.env.PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES = "0";
    svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(false);

    process.env.PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES = "true";
    svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(true);

    process.env.PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES = "1";
    svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(true);
  });

  it("ignores malformed env values (logs warning, falls back to default)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PAPERCLIP_RUNTIME_FLAG_RECOVERY_PAUSE_CODE_GATES = "yes-please";
    const svc = runtimeFlagService();
    expect(svc.get("recovery.pause.codeGates")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("set() flips the flag and records audit", async () => {
    const audit: Parameters<RuntimeFlagAuditLogger>[0][] = [];
    const svc = runtimeFlagService({
      audit: async (entry) => {
        audit.push(entry);
      },
    });
    const snap = await svc.set({
      key: "recovery.pause.codeGates",
      value: false,
      actorUserId: "local-board",
      reason: "C-1+C-2+C-3 verified in prod",
    });
    expect(svc.get("recovery.pause.codeGates")).toBe(false);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      flag: "recovery.pause.codeGates",
      previousValue: true,
      nextValue: false,
      actorUserId: "local-board",
      reason: "C-1+C-2+C-3 verified in prod",
    });
    expect(snap["recovery.pause.codeGates"]).toBe(false);
  });

  it("set() is a no-op when the value already matches (no audit entry)", async () => {
    const audit: Parameters<RuntimeFlagAuditLogger>[0][] = [];
    const svc = runtimeFlagService({ audit: async (e) => audit.push(e) });
    // Default is `true`; setting it again to `true` should not audit.
    await svc.set({
      key: "recovery.pause.codeGates",
      value: true,
      actorUserId: "local-board",
    });
    expect(audit).toHaveLength(0);
  });

  it("set() rolls back when audit logging throws (state stays consistent)", async () => {
    const svc = runtimeFlagService({
      audit: async () => {
        throw new Error("activity log unreachable");
      },
    });
    const before = svc.get("recovery.pause.codeGates");
    await expect(
      svc.set({
        key: "recovery.pause.codeGates",
        value: false,
        actorUserId: "local-board",
        reason: "should roll back",
      }),
    ).rejects.toThrow(/activity log unreachable/);
    expect(svc.get("recovery.pause.codeGates")).toBe(before);
  });

  it("snapshot() reflects the most recent write", async () => {
    const svc = runtimeFlagService();
    await svc.set({ key: "recovery.pause.codeGates", value: false, actorUserId: "u1" });
    const snap = svc.snapshot();
    expect(snap["recovery.pause.codeGates"]).toBe(false);
    expect(snap.updatedByUserId).toBe("u1");
    expect(typeof snap.updatedAt).toBe("string");
    expect(new Date(snap.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it("rejects unknown flag keys", async () => {
    const svc = runtimeFlagService();
    await expect(
      svc.set({
        // @ts-expect-error: testing runtime guard
        key: "totally.made.up",
        value: true,
        actorUserId: null,
      }),
    ).rejects.toThrow(/unknown runtime flag/);
  });
});
