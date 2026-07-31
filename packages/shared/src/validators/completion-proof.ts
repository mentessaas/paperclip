import { z } from "zod";

/**
 * Validators for the ZAL-86 issue completion proof gate.
 *
 * The runtime is the source of truth for SHA validity (it must re-run
 * `git cat-file -t` and `git log`): these schemas only defend the HTTP
 * surface so a malformed payload never reaches the service.
 */

const shaRegex = /^[0-9a-f]{7,64}$/i;

export const createIssueCompletionCommitProofSchema = z.object({
  sha: z.string().regex(shaRegex, "sha must be 7-64 hex chars"),
  repoPath: z.string().min(1, "repoPath is required"),
  ref: z.string().min(1).optional(),
  touchedPaths: z.array(z.string().min(1)).optional(),
  note: z.string().max(2_000).optional(),
});

export type CreateIssueCompletionCommitProof = z.infer<typeof createIssueCompletionCommitProofSchema>;

export const createIssueCompletionPeerVerificationProofSchema = z.object({
  sha: z.string().regex(shaRegex, "sha must be 7-64 hex chars"),
  repoPath: z.string().min(1, "repoPath is required"),
  peerWorktree: z.string().min(1, "peerWorktree is required"),
  commands: z.array(z.string().min(1)).min(1, "at least one command is required"),
  commandOutput: z.string().max(64_000),
  note: z.string().max(2_000).optional(),
});

export type CreateIssueCompletionPeerVerificationProof = z.infer<typeof createIssueCompletionPeerVerificationProofSchema>;
