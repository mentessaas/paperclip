/**
 * CompletionProofs are signed, immutable proof objects attached to an issue.
 *
 * Policy reference: ZAL-86 / ZAL-88 (control-plane SHA gate, C-1 + C-3 of the
 * anti-spoofing control plane). CompletionProofs are distinct from
 * `IssueWorkProduct` (which describes external artifacts such as PRs and
 * deployments): CompletionProofs are runtime-enforced gate evidence, never
 * rendered in the UI as a regular artifact, and never editable after insert.
 */

/** Kinds accepted at insertion. Anything else is a 422 at the route layer. */
export type IssueCompletionProofKind = "commit" | "peer_verification";

/**
 * The SHA + repoPath the issuer claims produced the change. Validated at
 * transition time via `git -C <repoPath> cat-file -t <sha>` (must return
 * `commit`). The `repoPath` must be registered in the project's whitelist;
 * otherwise the runtime returns `409 RepoNotRegistered`.
 *
 * `touchedPaths` is optional: when present, the runtime checks that the
 * commit actually touches at least one of those paths via `git log -1
 * --format=%H <sha> -- <path>`. A mismatch returns `409 ProofMismatch` (the
 * SHA exists but doesn't touch what the issue claims).
 */
export interface IssueCompletionCommitPayload {
  sha: string;
  repoPath: string;
  ref?: string;
  touchedPaths?: string[];
  /** Free-form note for the audit trail; never used as evidence by the gate. */
  note?: string;
}

/**
 * Independent verification by an agent whose `agentId` is distinct from the
 * issuer and whose `worktree` is distinct from the issuer's worktree. The
 * runtime enforces both invariants: same agent → `409 PeerNotIndependent`;
 * same worktree → `409 PeerNotIndependent`.
 *
 * `commandOutput` is the literal stdout/stderr of the executed commands. The
 * runtime applies a 60-second freshness window: if `submittedAt` is more than
 * 60 seconds older than the transition attempt, returns `409 PeerVerificationStale`.
 *
 * The runtime re-runs the commands in the same shell as a sanity check; if
 * they would now fail (e.g. SHA deleted by `gc` or force-push) the transition
 * returns `409 ProofExpired` even if `commandOutput` looks healthy.
 */
export interface IssueCompletionPeerVerificationPayload {
  sha: string;
  repoPath: string;
  /** Path to the peer agent's worktree (must differ from author's). */
  peerWorktree: string;
  /**
   * Commands the peer executed, in order. They MUST include at minimum
   * `git -C <repoPath> cat-file -t <sha>` (returns `commit`) and
   * `git -C <repoPath> log -1 --format=%H <sha>` (returns the same SHA).
   * The runtime parses the output and rejects mismatches.
   */
  commands: string[];
  commandOutput: string;
  /** Optional executable note (e.g. "amend detected, re-ran with new SHA"). */
  note?: string;
}

export interface IssueCompletionProof {
  id: string;
  companyId: string;
  issueId: string;
  kind: IssueCompletionProofKind;
  payload: IssueCompletionCommitPayload | IssueCompletionPeerVerificationPayload;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  submittedByRunId: string | null;
  submittedAt: string;
  consumedAtTransitionId: string | null;
  supersededAt: string | null;
  supersededByAgentId: string | null;
  supersededByUserId: string | null;
  supersededReason: string | null;
}

/**
 * Error codes returned by the control-plane gate. These are stable strings
 * the UI / SDK can switch on; do NOT localize in the runtime.
 */
export type IssueCompletionProofErrorCode =
  | "ProofRequired"
  | "ProofMismatch"
  | "ProofExpired"
  | "RepoNotRegistered"
  | "PeerNotIndependent"
  | "PeerVerificationStale"
  | "PeerVerificationRequired"
  | "CompletionProofTamper"
  | "RecoveryPausedUntilGitGate";