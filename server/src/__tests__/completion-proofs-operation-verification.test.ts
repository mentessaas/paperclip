import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueCompletionProofs,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completionProofService } from "../services/completion-proofs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("operation_verification completion proof — ZAL-215", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operation-proof-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await db.delete(issueCompletionProofs);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Operation Proof Co",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const creatorId = randomUUID();
    const executorId = randomUUID();
    const otherId = randomUUID();
    await db.insert(agents).values([
      {
        id: creatorId,
        companyId,
        name: "Creator",
        role: "lead",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: executorId,
        companyId,
        name: "Executor",
        role: "operator",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherId,
        companyId,
        name: "Other",
        role: "operator",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const parentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent operation",
        status: "in_progress",
        assigneeAgentId: creatorId,
      },
      {
        id: issueId,
        companyId,
        parentId,
        title: "Execute operation",
        status: "in_progress",
        workMode: "standard",
        createdByAgentId: creatorId,
        assigneeAgentId: executorId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "in_progress",
        assigneeAgentId: executorId,
      },
    ]);

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: executorId,
      authorType: "agent",
      body: "Operación ejecutada y verificada contra el sandbox local.",
    });

    return { companyId, creatorId, executorId, otherId, parentId, issueId, otherIssueId, commentId };
  }

  async function withIssueLock<T>(
    issueId: string,
    callback: (
      service: ReturnType<typeof completionProofService>,
      issue: {
        id: string;
        companyId: string;
        parentId: string | null;
        status: string;
        workMode: string;
        createdByAgentId: string | null;
        assigneeAgentId: string | null;
      },
      tx: Pick<TestDb, "update">,
    ) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`);
      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          status: issues.status,
          workMode: issues.workMode,
          createdByAgentId: issues.createdByAgentId,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]!);
      return callback(
        completionProofService(tx as unknown as TestDb),
        issue,
        tx as unknown as Pick<TestDb, "update">,
      );
    });
  }

  async function submitOperationProof(input: Awaited<ReturnType<typeof fixture>>) {
    return withIssueLock(input.issueId, (service, issue) =>
      service.submitOperationVerification(
        issue,
        { commentId: input.commentId, summary: "Sandbox local completado sin cambios de código." },
        { agentId: input.creatorId, userId: null, runId: null },
      ));
  }

  it("creator que sigue siendo owner del padre verifica evidencia del assignee y este cierra sin SHA", async () => {
    const input = await fixture();
    const proof = await submitOperationProof(input);
    expect(proof?.kind).toBe("operation_verification");

    const consumed = await withIssueLock(input.issueId, async (service, _issue, tx) => {
      const transitionId = randomUUID();
      const accepted = await service.tryConsumeOperationVerificationAtTransition(
        input.issueId,
        input.executorId,
        transitionId,
      );
      if (accepted) {
        await tx.update(issues).set({ status: "done" }).where(eq(issues.id, input.issueId));
      }
      return { accepted, transitionId };
    });

    expect(consumed.accepted).toBe(true);
    expect(await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0]?.status)).toBe("done");
    const [storedProof] = await db
      .select()
      .from(issueCompletionProofs)
      .where(eq(issueCompletionProofs.issueId, input.issueId));
    expect(storedProof?.consumedAtTransitionId).toBe(consumed.transitionId);
  });

  it("rechaza auto-verificación del assignee", async () => {
    const input = await fixture();
    await expect(withIssueLock(input.issueId, (service, issue) =>
      service.submitOperationVerification(
        issue,
        { commentId: input.commentId, summary: "Self verify" },
        { agentId: input.executorId, userId: null, runId: null },
      ))).rejects.toMatchObject({ code: "OperationVerificationNotAllowed" });
  });

  it("rechaza al creator que ya no posee el padre", async () => {
    const input = await fixture();
    await db.update(issues).set({ assigneeAgentId: input.otherId }).where(eq(issues.id, input.parentId));
    await expect(submitOperationProof(input)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });
  });

  it("rechaza comentario ajeno, borrado o de otra issue", async () => {
    const foreignAuthor = await fixture();
    await db
      .update(issueComments)
      .set({ authorAgentId: foreignAuthor.otherId })
      .where(eq(issueComments.id, foreignAuthor.commentId));
    await expect(submitOperationProof(foreignAuthor)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });

    await db.delete(issueCompletionProofs);
    await db
      .update(issueComments)
      .set({ authorAgentId: foreignAuthor.executorId, deletedAt: new Date() })
      .where(eq(issueComments.id, foreignAuthor.commentId));
    await expect(submitOperationProof(foreignAuthor)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });

    const otherCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: otherCommentId,
      companyId: foreignAuthor.companyId,
      issueId: foreignAuthor.otherIssueId,
      authorAgentId: foreignAuthor.executorId,
      authorType: "agent",
      body: "Evidence on another issue",
    });
    foreignAuthor.commentId = otherCommentId;
    await expect(submitOperationProof(foreignAuthor)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });
  });

  it("rechaza operation_verification tras commit y commit tras operation_verification", async () => {
    const priorCommit = await fixture();
    await withIssueLock(priorCommit.issueId, (service, issue) =>
      service.submitCommit(
        issue,
        { sha: "abcdef1", repoPath: "/sandbox/repo" },
        { agentId: priorCommit.executorId, userId: null, runId: null },
      ));
    await expect(submitOperationProof(priorCommit)).rejects.toMatchObject({
      code: "CompletionProofConflict",
    });

    const priorOperation = await fixture();
    await submitOperationProof(priorOperation);
    await expect(withIssueLock(priorOperation.issueId, (service, issue) =>
      service.submitCommit(
        issue,
        { sha: "abcdef2", repoPath: "/sandbox/repo" },
        { agentId: priorOperation.executorId, userId: null, runId: null },
      ))).rejects.toMatchObject({ code: "CompletionProofConflict" });
  });

  it("rechaza nuevos proofs en issue terminal", async () => {
    const input = await fixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.issueId));
    await expect(submitOperationProof(input)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });
    await expect(withIssueLock(input.issueId, (service, issue) =>
      service.submitCommit(
        issue,
        { sha: "abcdef3", repoPath: "/sandbox/repo" },
        { agentId: input.executorId, userId: null, runId: null },
      ))).rejects.toMatchObject({ code: "CompletionProofConflict" });
  });

  it("serializa la carrera commit vs operation proof y solo persiste un kind", async () => {
    const input = await fixture();
    const [commit, operation] = await Promise.allSettled([
      withIssueLock(input.issueId, (service, issue) =>
        service.submitCommit(
          issue,
          { sha: "abcdef4", repoPath: "/sandbox/repo" },
          { agentId: input.executorId, userId: null, runId: null },
        )),
      submitOperationProof(input),
    ]);

    expect([commit.status, operation.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await db
      .select({ kind: issueCompletionProofs.kind })
      .from(issueCompletionProofs)
      .where(eq(issueCompletionProofs.issueId, input.issueId));
    expect(rows).toHaveLength(1);
  });

  it("ante una invariante inválida cae al gate SHA ordinario", async () => {
    const input = await fixture();
    await submitOperationProof(input);
    await db.update(issues).set({ assigneeAgentId: input.otherId }).where(eq(issues.id, input.parentId));

    await withIssueLock(input.issueId, async (service) => {
      expect(await service.tryConsumeOperationVerificationAtTransition(
        input.issueId,
        input.executorId,
        randomUUID(),
      )).toBe(false);
      expect((await service.verifyAtTransition(input.issueId))?.code).toBe("ProofRequired");
    });
  });

  it("no ensancha review_no_code ni el cierre de código sin SHA", async () => {
    const input = await fixture();
    await db.execute(
      sql`update issues set work_mode = 'review_no_code' where id = ${input.issueId}`,
    );
    await expect(submitOperationProof(input)).rejects.toMatchObject({
      code: "OperationVerificationNotAllowed",
    });

    const ordinary = await fixture();
    const verdict = await completionProofService(db).verifyAtTransition(ordinary.issueId);
    expect(verdict?.code).toBe("ProofRequired");
  });
});
