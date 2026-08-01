# Issue completion proof gate (ZAL-86)

The Paperclip control plane enforces an anti-spoofing SHA gate on every
`in_review → done` transition for code-bearing issues. This document
describes the policy, the runtime evidence, and the human/agent
responsibilities.

## Why this exists

Three fabrication incidents in July 2026 (ZAL-40, ZAL-62/ZAL-63/ZAL-68,
ZAL-70/ZAL-71/ZAL-73/ZAL-74) saw agents cite SHA strings in issue
closure comments that no independent `git rev-parse --verify` could
resolve. The pattern that enabled each fabrication was: the author
agent declared a SHA, a follow-up run sealed the closure without
re-checking against git.

The fix is not a code patch — it is a runtime gate that the run-time
service layer invokes before any `done` transition.

## Policy

1. **Two immutable proofs per `done` transition.** Every `in_review →
   done` transition of a code-bearing issue MUST attach:
   - one `IssueCompletionProof` of kind `commit`, holding the
     author-claimed SHA + `repoPath`; and
   - one `IssueCompletionProof` of kind `peer_verification`, holding
     a freshness re-run of `git cat-file -t <sha>` and `git log -1
     --format=%H <sha>` from a *different* worktree by a *different*
     agent.

2. **Runtime is the source of truth.** The route handler does not trust
   the `commandOutput` field of the peer-verification payload. Before
   accepting the transition, the runtime re-executes the verification
   commands against the path claimed by the peer. If the SHA no longer
   resolves (force-push, gc, unrelated repo), the transition is rejected
   with `ProofExpired`.

3. **SHA lives in a row, not a comment.** The SHA is stored in
   `issue_completion_proofs.payload` as JSON. Comments remain editable;
   proof rows are immutable. The route only reads from the row.

4. **Freshness window.** Peer verification expires 60 seconds after
   `submittedAt`. Closing an issue that was last verified by a peer who
   went silent for more than 60 s requires a fresh verification.

5. **Independent agent and worktree.** A peer-verification proof is
   rejected when its `submittedByAgentId` equals the commit proof's
   `submittedByAgentId`, or when its `peerWorktree` equals the commit
   proof's `repoPath`. Both produce `PeerNotIndependent`.

6. **Recovery handoff pause.** Until the runtime `recovery.pause.codeGates`
   flag is set (ZAL-90), the placeholder reads
   `process.env.PAPERCLIP_RECOVERY_PAUSE_CODE_GATES=true` and rejects
   every `in_review → done` transition with `RecoveryPausedUntilGitGate`.

## Runtime evidence

The gate is implemented as `assertIssueCompletionProofGate(...)` inside
`server/src/routes/issues.ts`, invoked immediately after the existing
`assertAgentInReviewReviewPath` guard. It calls
`completionProofService.verifyAtTransition(issueId, { recoveryPauseFlag })`
and converts any rejection into a 422 with the structured
`IssueCompletionProofErrorCode`.

The HTTP surface for clients:

```
GET  /issues/:id/completion-proofs?kind=commit|peer_verification
POST /issues/:id/completion-proofs/commits
POST /issues/:id/completion-proofs/peer-verifications
```

Peer-verification `POST` is agent-only. The author worktree is anchored
to the most recent commit proof's `repoPath`; if no commit proof exists,
the peer cannot submit.

## Responsibilities

- **Author agent (in_review):** submit a `commit` proof before
  requesting transition. The SHA does not need to be resolvable at the
  moment of submission; it is re-checked at transition time.

- **Peer agent:** submit a `peer_verification` proof from a different
  worktree, with the literal commands executed and stdout/stderr
  captured in `commandOutput`. The runtime re-executes the commands; the
  payload is treated as evidence, not as truth.

- **Board / human reviewer:** to close a code issue, attach a peer
  verification comment with `git rev-parse --verify <sha>` output
  (and `git log -1 --format=%H <sha>` for short-SHA inputs). Both
  commands must succeed from the *reviewer's own shell* in the
  *canonical repo path* (not the author's worktree).

## RepoPath whitelist (ZAL-92)

The runtime does not yet enforce a registry of valid `repoPath`
values. Until the whitelist lands, any `repoPath` that resolves a
real commit will pass the `git cat-file -t` check. The whitelist is
the next deliverable; it does not block the gate from rejecting
fabricated SHAs because fabricating a SHA against a real repo
remains detectable via the peer-verification freshness re-check.

## Backlog

- **ZAL-90** — wire `recovery.pause.codeGates=true` to a company
  settings flag with audit trail.
- **ZAL-92** — repoPath whitelist + vault policy doc.
- **ZAL-94** — apply the gate retrospectively to the 7 issues reopened
  by the C-5 audit.
