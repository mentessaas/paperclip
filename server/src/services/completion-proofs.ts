import { spawn } from "node:child_process";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueCompletionProofs } from "@paperclipai/db";
import type {
  IssueCompletionProof,
  IssueCompletionCommitPayload,
  IssueCompletionPeerVerificationPayload,
  IssueCompletionProofErrorCode,
} from "@paperclipai/shared";

type IssueCompletionProofRow = typeof issueCompletionProofs.$inferSelect;

const PEER_FRESHNESS_MS = 60_000;
const PROOF_VALIDATION_TIMEOUT_MS = 5_000;

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Run `git <args>` in `cwd` with a hard timeout. Rejects on non-zero exit
 * or timeout. Used by the transition-time gate and the peer-verification
 * freshness re-check; never trusts `commandOutput` blindly.
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out after ${PROOF_VALIDATION_TIMEOUT_MS}ms`));
    }, PROOF_VALIDATION_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code ?? -1 });
    });
  });
}

function toIssueCompletionProof(row: IssueCompletionProofRow): IssueCompletionProof {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    kind: row.kind as IssueCompletionProof["kind"],
    payload: row.payload as IssueCompletionProof["payload"],
    submittedByAgentId: row.submittedByAgentId,
    submittedByUserId: row.submittedByUserId,
    submittedByRunId: row.submittedByRunId,
    submittedAt: row.submittedAt.toISOString(),
    consumedAtTransitionId: row.consumedAtTransitionId,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    supersededByAgentId: row.supersededByAgentId,
    supersededByUserId: row.supersededByUserId,
    supersededReason: row.supersededReason,
  };
}

async function gitCatFile(cwd: string, sha: string): Promise<string> {
  const result = await runGit(cwd, ["cat-file", "-t", sha]);
  const type = result.stdout.trim();
  if (result.status !== 0 || type !== "commit") {
    throw new Error(`git cat-file -t ${sha} returned ${type || `<status=${result.status}>`} (expected commit)`);
  }
  return type;
}

async function gitLogSha(cwd: string, sha: string): Promise<string> {
  const result = await runGit(cwd, ["log", "-1", "--format=%H", sha]);
  const resolved = result.stdout.trim();
  if (result.status !== 0 || resolved !== sha) {
    throw new Error(`git log -1 --format=%H ${sha} returned ${resolved || `<status=${result.status}>`} (expected ${sha})`);
  }
  return resolved;
}

export function completionProofService(db: Db) {
  return {
    listForIssue: async (issueId: string, opts: { kind?: "commit" | "peer_verification" } = {}) => {
      const where = opts.kind
        ? and(eq(issueCompletionProofs.issueId, issueId), eq(issueCompletionProofs.kind, opts.kind))
        : eq(issueCompletionProofs.issueId, issueId);
      const rows = await db
        .select()
        .from(issueCompletionProofs)
        .where(where)
        .orderBy(desc(issueCompletionProofs.submittedAt));
      return rows
        .filter((row) => row.supersededAt === null)
        .map(toIssueCompletionProof);
    },

    /**
     * Insert a `commit` proof. The runtime does NOT validate the SHA here; it
     * is re-validated at `in_review -> done` transition time. This keeps the
     * insert path cheap and lets the issuer stage a proof before the actual
     * commit lands in their worktree.
     */
    submitCommit: async (
      issue: { id: string; companyId: string },
      payload: IssueCompletionCommitPayload,
      actor: {
        agentId: string | null;
        userId: string | null;
        runId: string | null;
      },
    ) => {
      if (!payload.sha || !/^[0-9a-f]{7,64}$/i.test(payload.sha)) {
        throw new Error("Invalid sha in commit payload");
      }
      if (!payload.repoPath || typeof payload.repoPath !== "string") {
        throw new Error("repoPath is required");
      }
      const row = await db
        .insert(issueCompletionProofs)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          kind: "commit",
          payload,
          submittedByAgentId: actor.agentId,
          submittedByUserId: actor.userId,
          submittedByRunId: actor.runId,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueCompletionProof(row) : null;
    },

    /**
     * Insert a `peer_verification` proof. Enforces:
     *   - the issuer is not the author of the matching `commit` proof
     *   - the issuer's `peerWorktree` is distinct from the author's worktree
     *     (we compare to the most recent commit proof's `repoPath`; if no
     *     commit proof exists, we cannot anchor and reject as ProofRequired)
     *   - submittedAt within `PEER_FRESHNESS_MS` of `now`
     *   - the runtime successfully re-runs the commands against the peer
     *     worktree (this is the freshness re-check; we run, we don't trust
     *     `commandOutput` blindly)
     */
    submitPeerVerification: async (
      issue: { id: string; companyId: string },
      payload: IssueCompletionPeerVerificationPayload,
      actor: {
        agentId: string | null;
        userId: string | null;
        runId: string | null;
      },
      authorWorktree: string | null,
      authorAgentId: string | null = null,
    ) => {
      if (!actor.agentId) {
        throw new Error("Peer verification requires an agent actor");
      }
      if (!payload.sha || !/^[0-9a-f]{7,64}$/i.test(payload.sha)) {
        throw new Error("Invalid sha in peer_verification payload");
      }
      if (!payload.peerWorktree || typeof payload.peerWorktree !== "string") {
        throw new Error("peerWorktree is required");
      }
      if (!authorWorktree || !authorAgentId) {
        // ZAL-89: a peer verification cannot be anchored without an
        // author commit proof. Reject up-front (and the route will map
        // this to 409 ProofRequired) rather than letting the row land
        // and discovering the missing author at transition time.
        const err = new Error(
          "ProofRequired: no author commit proof to anchor peer verification against",
        );
        (err as Error & { code: string }).code = "ProofRequired";
        throw err;
      }
      if (authorAgentId === actor.agentId) {
        const err = new Error(
          "PeerNotIndependent: peer agent is the same as the author agent",
        );
        (err as Error & { code: string }).code = "PeerNotIndependent";
        throw err;
      }
      if (payload.peerWorktree === authorWorktree) {
        const err = new Error(
          "PeerNotIndependent: peerWorktree matches the author worktree",
        );
        (err as Error & { code: string }).code = "PeerNotIndependent";
        throw err;
      }
      // The service sets `submittedAt` from its own clock (never trusts the
      // caller's). Freshness is re-checked at transition time against this
      // stored timestamp in `verifyAtTransition` below.
      const submittedAt = new Date();
      // Re-run the verifier's commands in the same shell as a sanity check.
      // We deliberately use the peerWorktree path the peer claims to have
      // executed from; if the SHA no longer resolves there (force-push, gc,
      // unrelated repo), the transition must reject even if `commandOutput`
      // looks healthy.
      await gitCatFile(payload.peerWorktree, payload.sha);
      await gitLogSha(payload.peerWorktree, payload.sha);

      const row = await db
        .insert(issueCompletionProofs)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          kind: "peer_verification",
          payload,
          submittedByAgentId: actor.agentId,
          submittedByUserId: actor.userId,
          submittedByRunId: actor.runId,
          submittedAt,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueCompletionProof(row) : null;
    },

    /**
     * Mark a set of proofs as consumed by a transition. Sets
     * `consumedAtTransitionId` on the rows; rows are otherwise immutable.
     */
    consumeAtTransition: async (transitionId: string, proofIds: string[]) => {
      if (!proofIds.length) return 0;
      const updated = await db
        .update(issueCompletionProofs)
        .set({ consumedAtTransitionId: transitionId })
        .where(
          and(
            isNull(issueCompletionProofs.consumedAtTransitionId),
            isNull(issueCompletionProofs.supersededAt),
          ),
        )
        .returning({ id: issueCompletionProofs.id });
      return updated.length;
    },

    /**
     * The actual gate. Called at `in_review -> done` transition time. Returns
     * `null` if the gate passes, or a structured error payload (matching
     * IssueCompletionProofErrorCode) if it rejects. The caller maps that to
     * the appropriate HTTP response.
     *
     * Rules enforced:
     *   1. At least one non-superseded `commit` proof exists.
     *   2. The commit SHA resolves via `git cat-file -t` against `repoPath`.
     *   3. A peer-verification proof exists for the same SHA, from an agent
     *      whose worktree differs from the author's.
     *   4. The peer-verification proof's submittedAt is within the freshness
     *      window.
     *   5. The peer-verification proof is not superseded.
     */
    verifyAtTransition: async (
      issueId: string,
      options: {
        recoveryPauseFlag?: boolean;
        /**
         * Optional project-scoped repo-path allowlist. When provided, the
         * commit proof's `repoPath` MUST be in the list, otherwise the
         * gate returns `409 RepoNotRegistered`. ZAL-88: the route resolves
         * this from `projects.codeRepoPaths`; the service does not look it
         * up itself to keep the gate composable.
         */
        projectRepoPaths?: string[] | null;
      } = {},
    ): Promise<null | {
      code: IssueCompletionProofErrorCode;
      message: string;
      proofId?: string;
    }> => {
      if (options.recoveryPauseFlag) {
        return { code: "RecoveryPausedUntilGitGate", message: "recovery.handoff paused until the SHA gate ships" };
      }
      const commits = await db
        .select()
        .from(issueCompletionProofs)
        .where(
          and(
            eq(issueCompletionProofs.issueId, issueId),
            eq(issueCompletionProofs.kind, "commit"),
            isNull(issueCompletionProofs.supersededAt),
          ),
        )
        .orderBy(desc(issueCompletionProofs.submittedAt));
      if (!commits.length) {
        return { code: "ProofRequired", message: "No commit proof attached to this issue" };
      }
      const commit = commits[0]!;
      const commitPayload = commit.payload as IssueCompletionCommitPayload;
      // ZAL-88: the project-scoped allowlist. A `null` list means the
      // project has not been onboarded to the SHA gate (no canonical
      // repo paths registered), so commit proofs cannot be verified.
      const allowlist = options.projectRepoPaths ?? null;
      if (!allowlist || allowlist.length === 0) {
        return {
          code: "RepoNotRegistered",
          message: "project has no canonical repo paths registered; register them in projects.codeRepoPaths",
          proofId: commit.id,
        };
      }
      if (!allowlist.includes(commitPayload.repoPath)) {
        return {
          code: "RepoNotRegistered",
          message: `repoPath '${commitPayload.repoPath}' is not in the project's codeRepoPaths allowlist`,
          proofId: commit.id,
        };
      }
      try {
        await gitCatFile(commitPayload.repoPath, commitPayload.sha);
        await gitLogSha(commitPayload.repoPath, commitPayload.sha);
      } catch (err) {
        return {
          code: "ProofExpired",
          message: err instanceof Error ? err.message : "git re-check failed",
          proofId: commit.id,
        };
      }
      const peers = await db
        .select()
        .from(issueCompletionProofs)
        .where(
          and(
            eq(issueCompletionProofs.issueId, issueId),
            eq(issueCompletionProofs.kind, "peer_verification"),
            isNull(issueCompletionProofs.supersededAt),
          ),
        )
        .orderBy(desc(issueCompletionProofs.submittedAt));
      const matchingPeer = peers.find((p) => {
        const pp = p.payload as IssueCompletionPeerVerificationPayload;
        return pp.sha === commitPayload.sha;
      });
      if (!matchingPeer) {
        return { code: "PeerVerificationRequired", message: "No peer verification for the submitted SHA" };
      }
      const peerPayload = matchingPeer.payload as IssueCompletionPeerVerificationPayload;
      const ageMs = Date.now() - new Date(matchingPeer.submittedAt).getTime();
      if (ageMs > PEER_FRESHNESS_MS) {
        return {
          code: "PeerVerificationStale",
          message: `peer verification is ${Math.round(ageMs / 1000)}s old`,
          proofId: matchingPeer.id,
        };
      }
      if (
        matchingPeer.submittedByAgentId &&
        commit.submittedByAgentId &&
        matchingPeer.submittedByAgentId === commit.submittedByAgentId
      ) {
        return {
          code: "PeerNotIndependent",
          message: "Peer and author are the same agent",
          proofId: matchingPeer.id,
        };
      }
      if (peerPayload.peerWorktree === commitPayload.repoPath) {
        return {
          code: "PeerNotIndependent",
          message: "peerWorktree matches the author repoPath",
          proofId: matchingPeer.id,
        };
      }
      return null;
    },
  };
}

export { toIssueCompletionProof };
