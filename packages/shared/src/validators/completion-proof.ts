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
  commands: z
    .array(z.string().min(1))
    .min(1, "at least one command is required")
    .refine(
      (cmds) => {
        // ZAL-89: the peer payload must include the literal executable block
        // the runtime will re-run. `cat-file -t` confirms object type, `log
        // -1 --format=%H` confirms the SHA resolves in the worktree.
        const hasCatFile = cmds.some((c) => /git\s+-C\s+\S+\s+cat-file\s+-t\s+\S+/.test(c));
        const hasLog = cmds.some(
          (c) => /git\s+-C\s+\S+\s+log\s+-1\s+--format=%H\s+\S+/.test(c),
        );
        return hasCatFile && hasLog;
      },
      {
        message:
          "commands must include literal `git -C <peerWorktree> cat-file -t <sha>` and `git -C <peerWorktree> log -1 --format=%H <sha>`",
      },
    ),
  commandOutput: z.string().max(64_000),
  note: z.string().max(2_000).optional(),
});

export type CreateIssueCompletionPeerVerificationProof = z.infer<typeof createIssueCompletionPeerVerificationProofSchema>;

export const createIssueCompletionOperationVerificationProofSchema = z.object({
  commentId: z.string().uuid("commentId must be a UUID"),
  summary: z.string().trim().min(1, "summary is required").max(500),
});

export type CreateIssueCompletionOperationVerificationProof = z.infer<
  typeof createIssueCompletionOperationVerificationProofSchema
>;
