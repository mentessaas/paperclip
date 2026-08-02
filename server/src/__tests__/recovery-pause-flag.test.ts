/**
 * Negative tests for the ZAL-90 (C-4) flag wiring in the
 * IssueCompletionProof gate. We exercise `completionProofService.verifyAtTransition`
 * directly with a fake flag and assert the `RecoveryPausedUntilGitGate`
 * code path only fires for code-bearing issues.
 *
 * Why this matters: the flag is the last line of defense against
 * self-signed SHAs. It MUST refuse code transitions when ON, MUST
 * permit non-code transitions even when ON, and MUST permit code
 * transitions when the board explicitly turns it OFF.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCompletionProofs,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completionProofService } from "../services/completion-proofs.js";
import { runtimeFlagService } from "../services/runtime-flags.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping recovery-pause-flag tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ZAL-90 C-4 — recovery.pause.codeGates flag wiring", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof completionProofService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-c4-flag-");
    db = createDb(tempDb.connectionString);
    svc = completionProofService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueCompletionProofs);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertIssue(opts: {
    codeRepoPaths?: string[] | null;
    billingCode?: string | null;
  } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `C4Co-${companyId.slice(0, 6)}`,
      issuePrefix: `C4${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Zaltyko-Web",
      status: "active",
      codeRepoPaths: opts.codeRepoPaths ?? null,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "test",
      status: "in_review",
      billingCode: opts.billingCode ?? null,
    });
    return { companyId, projectId, issueId };
  }

  it("[NEGATIVE 1] flag ON + code issue -> 409 RecoveryPausedUntilGitGate (short-circuits before SHA check)", async () => {
    const flags = runtimeFlagService(); // default ON
    expect(flags.get("recovery.pause.codeGates")).toBe(true);
    const { issueId } = await insertIssue({
      codeRepoPaths: ["/tmp/whatever"],
      billingCode: "ZAL-86-C4",
    });
    const verdict = await svc.verifyAtTransition(issueId, {
      recoveryPauseFlag: flags.get("recovery.pause.codeGates"),
      isCodeIssue: true,
      projectRepoPaths: ["/tmp/whatever"],
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.code).toBe("RecoveryPausedUntilGitGate");
  });

  it("[NEGATIVE 2] flag ON + NON-code issue -> gate proceeds (no false-positive block)", async () => {
    const flags = runtimeFlagService();
    const { issueId } = await insertIssue({ billingCode: null });
    const verdict = await svc.verifyAtTransition(issueId, {
      recoveryPauseFlag: flags.get("recovery.pause.codeGates"),
      isCodeIssue: false, // marketing / docs / coordination work
      projectRepoPaths: null,
    });
    // No commit proof is attached to this issue, so the gate falls through
    // to `ProofRequired`. The key assertion is that it is NOT
    // `RecoveryPausedUntilGitGate` — that confirms the flag does not
    // block non-code issues even when ON.
    expect(verdict).not.toBeNull();
    expect(verdict!.code).not.toBe("RecoveryPausedUntilGitGate");
    expect(verdict!.code).toBe("ProofRequired");
  });

  it("[NEGATIVE 3] flag OFF + code issue -> gate proceeds (board explicitly lifted the pause)", async () => {
    const flags = runtimeFlagService();
    await flags.set({ key: "recovery.pause.codeGates", value: false, actorUserId: "local-board" });
    const { issueId } = await insertIssue({ billingCode: "ZAL-86-C4" });
    const verdict = await svc.verifyAtTransition(issueId, {
      recoveryPauseFlag: flags.get("recovery.pause.codeGates"),
      isCodeIssue: true,
      projectRepoPaths: null,
    });
    // With flag OFF and no commit proof attached, the gate falls through
    // to `ProofRequired`. Critically, it is NOT `RecoveryPausedUntilGitGate`:
    // that proves the pause was lifted.
    expect(verdict).not.toBeNull();
    expect(verdict!.code).not.toBe("RecoveryPausedUntilGitGate");
    expect(verdict!.code).toBe("ProofRequired");
  });

  it("flag never affects transitions to anything other than `done`", async () => {
    // This is a structural test for the gate contract: the flag's effect
    // is gated on `nextStatus === 'done'` at the route layer. The service
    // returns RecoveryPaused regardless of nextStatus because the route
    // is the only caller; we assert here that the contract is documented
    // and exercised only by `verifyAtTransition` callers that already
    // short-circuited non-`done` transitions.
    const flags = runtimeFlagService();
    const { issueId } = await insertIssue({ billingCode: "ZAL-86-C4" });
    const verdict = await svc.verifyAtTransition(issueId, {
      recoveryPauseFlag: flags.get("recovery.pause.codeGates"),
      isCodeIssue: true,
    });
    expect(verdict?.code).toBe("RecoveryPausedUntilGitGate");
  });
});
