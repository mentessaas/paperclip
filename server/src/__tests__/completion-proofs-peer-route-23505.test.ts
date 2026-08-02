/**
 * ZAL-136: route-level test for the 23505 → 409 PeerProofDuplicate mapping.
 *
 * The runtime's `submitPeerVerification` can throw a Drizzle-wrapped
 * `DrizzleQueryError` whose `cause.code === '23505'` (Postgres unique
 * violation on `issue_completion_proofs_peer_unique_idx`). Before ZAL-136
 * the route only mapped `PeerNotIndependent` and `ProofRequired` and
 * surfaced 23505 as a 500 leaking the ORM error. This test verifies the
 * new branch on the POST `/issues/:id/completion-proofs/peer-verifications`
 * handler that catches `cause.code === '23505'` and returns 409 with
 * `code: "PeerProofDuplicate"`.
 *
 * Strategy: `vi.mock` the entire services barrel BEFORE the route
 * imports. This way the REAL `issueRoutes` is loaded once (with the
 * mocks wired in), the route handler closes over the mocked
 * `completionProofService`, and each test resets the mocks' behavior in
 * `beforeEach`.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "company-1";
const ACTOR_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockCompletionProofsSvc = {
  listForIssue: vi.fn(),
  submitCommit: vi.fn(),
  submitPeerVerification: vi.fn(),
  consumeAtTransition: vi.fn(),
  verifyAtTransition: vi.fn(),
};

const mockIssueService = {
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
};

const mockAccessService = {
  canUser: vi.fn(async () => true),
  decide: vi.fn(async (input: { action?: string }) => ({
    allowed: true,
    action: input.action,
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant.",
  })),
  hasPermission: vi.fn(async () => true),
};

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
  completionProofService: () => mockCompletionProofsSvc,
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  defaultRuntimeFlagService: () => ({
    get: vi.fn((_key: string) => false),
    set: vi.fn(async () => ({})),
    snapshot: vi.fn(() => ({ "recovery.pause.codeGates": false, updatedAt: new Date().toISOString(), updatedByUserId: null })),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
  issueIsInTaskWatchdogSubtree: vi.fn(async () => false),
}));

// Import AFTER the mocks so the route is loaded against the mocked
// service barrel. `vi.mock` is hoisted, so this is safe.
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * Build a Postgres unique-violation error shaped like Drizzle's
 * `DrizzleQueryError`: original error on `.cause` with `code: '23505'`
 * and optionally `constraint: <index-name>`. The pg driver does not
 * always surface the constraint name; the route handles both cases
 * (see ZAL-136 comment in `server/src/routes/issues.ts:5912`).
 */
function makeDrizzleUniqueViolationError(opts: { withConstraint?: boolean } = {}) {
  const pgErr: { code: string; constraint?: string; message: string } = {
    code: "23505",
    message: 'duplicate key value violates unique constraint "issue_completion_proofs_peer_unique_idx"',
  };
  if (opts.withConstraint !== false) {
    pgErr.constraint = "issue_completion_proofs_peer_unique_idx";
  }
  const wrapped = new Error("Failed query: insert into \"issue_completion_proofs\"") as Error & {
    cause: { code: string; constraint?: string; message: string };
  };
  wrapped.cause = pgErr;
  return wrapped;
}

let app: express.Express;

function buildApp() {
  const expr = express();
  expr.use(express.json());
  expr.use((req, _res, next) => {
    // `runId: ""` short-circuits the watchdog-scope branch (which
    // would otherwise query the stub `db = {}`). With `assigneeAgentId
    // === null` on the issue stub, `assertAgentIssueMutationAllowed`
    // returns true at line 3656 of issues.ts.
    (req as unknown as { actor: unknown }).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      companyIds: [COMPANY_ID],
      runId: "",
      keyScope: { kind: "standard" },
      source: "agent_jwt",
    };
    next();
  });
  expr.use("/api", issueRoutes({} as never, {} as never));
  expr.use(errorHandler);
  return expr;
}

const PEER_PAYLOAD = {
  sha: "cf2c34437e03b9c2bd2547560a83c7b8cf36a5dc",
  repoPath: "/zaltyko/canonical/web",
  peerWorktree: "/zaltyko/canonical/web.peer",
  commands: [
    "git -C /zaltyko/canonical/web.peer cat-file -t cf2c34437e03b9c2bd2547560a83c7b8cf36a5dc",
    "git -C /zaltyko/canonical/web.peer log -1 --format=%H cf2c34437e03b9c2bd2547560a83c7b8cf36a5dc",
  ],
  commandOutput: "commit\ncf2c34437e03b9c2bd2547560a83c7b8cf36a5dc\n",
};

function makeIssueRow() {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_review",
    projectId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
  };
}

function makeCommitProofRow() {
  return {
    id: "proof-commit-1",
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    kind: "commit" as const,
    payload: { sha: PEER_PAYLOAD.sha, repoPath: PEER_PAYLOAD.repoPath },
    submittedByAgentId: "author-agent-id",
    submittedByUserId: null,
    submittedByRunId: null,
    submittedAt: new Date(),
    consumedAtTransitionId: null,
    supersededAt: null,
    supersededByAgentId: null,
    supersededByUserId: null,
    supersededReason: null,
  };
}

describe("peer-verification route — ZAL-136 23505 → 409 mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssueRow());
    mockCompletionProofsSvc.listForIssue.mockResolvedValue([makeCommitProofRow()]);
    app = buildApp();
  });

  afterAll(() => {
    // No-op: mocks are cleaned up by vitest.
  });

  it("maps a Postgres 23505 (with constraint name) to 409 PeerProofDuplicate", async () => {
    mockCompletionProofsSvc.submitPeerVerification.mockRejectedValue(
      makeDrizzleUniqueViolationError({ withConstraint: true }),
    );

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/completion-proofs/peer-verifications`)
      .send(PEER_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PeerProofDuplicate");
    expect(res.body.error).toMatch(/peer-verification proof/i);
  });

  it("maps a Postgres 23505 (without constraint name) to 409 PeerProofDuplicate (pg driver sometimes omits it)", async () => {
    mockCompletionProofsSvc.submitPeerVerification.mockRejectedValue(
      makeDrizzleUniqueViolationError({ withConstraint: false }),
    );

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/completion-proofs/peer-verifications`)
      .send(PEER_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PeerProofDuplicate");
  });

  it("does not map unrelated 23505 violations to PeerProofDuplicate (passes through to errorHandler)", async () => {
    // A 23505 from a different unique index must NOT be swallowed as
    // PeerProofDuplicate; the route only maps 23505 when the constraint
    // is the peer-proof index or unnamed. With a different named
    // constraint the route re-throws → errorHandler responds with 500.
    const otherConstraintError = makeDrizzleUniqueViolationError({ withConstraint: true });
    (otherConstraintError.cause as { constraint: string }).constraint =
      "projects_code_repo_paths_unique_idx";
    mockCompletionProofsSvc.submitPeerVerification.mockRejectedValue(otherConstraintError);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/completion-proofs/peer-verifications`)
      .send(PEER_PAYLOAD);

    expect(res.status).not.toBe(409);
    if (res.status === 409) {
      expect(res.body.code).not.toBe("PeerProofDuplicate");
    }
  });

  it("still maps PeerNotIndependent service errors to 409 with the service code", async () => {
    // Regression: ZAL-136 must NOT break the pre-existing PeerNotIndependent
    // handling. The service throws with `code: 'PeerNotIndependent'`, the
    // route maps that to 409 with the service-supplied code (not
    // PeerProofDuplicate).
    const peerErr = new Error("peer agent is the same as the author agent") as Error & {
      code: string;
    };
    peerErr.code = "PeerNotIndependent";
    mockCompletionProofsSvc.submitPeerVerification.mockRejectedValue(peerErr);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/completion-proofs/peer-verifications`)
      .send(PEER_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PeerNotIndependent");
  });

  it("happy path: submitPeerVerification resolves → 201", async () => {
    const fakeProof = {
      ...makeCommitProofRow(),
      kind: "peer_verification" as const,
      id: "proof-peer-1",
    };
    mockCompletionProofsSvc.submitPeerVerification.mockResolvedValue(fakeProof);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/completion-proofs/peer-verifications`)
      .send(PEER_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("peer_verification");
  });
});
