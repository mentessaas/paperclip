import { describe, expect, it } from "vitest";
import {
  createIssueCompletionCommitProofSchema,
  createIssueCompletionPeerVerificationProofSchema,
} from "./completion-proof.js";

describe("completion-proof validator", () => {
  describe("createIssueCompletionCommitProofSchema", () => {
    it("accepts a minimal valid commit payload", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c34437e03b9c2bd2547560a83c7b8cf36a5dc",
        repoPath: "/Users/elvisvaldesinerarte/Desktop/_PROYECTOS/Paperclip",
      });
      expect(result.success).toBe(true);
    });

    it("accepts a short SHA (>= 7 hex chars)", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c344",
        repoPath: "/tmp/repo",
      });
      expect(result.success).toBe(true);
    });

    it("accepts the full 64-char SHA", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "0c48e4d9a13fcf87e3a21ea5ea9dd0b0e6943e0c".padEnd(64, "0"),
        repoPath: "/tmp/repo",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a SHA shorter than 7 hex chars", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c34",
        repoPath: "/tmp/repo",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a SHA with non-hex characters", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c3443g",
        repoPath: "/tmp/repo",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty repoPath", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c34437",
        repoPath: "",
      });
      expect(result.success).toBe(false);
    });

    it("accepts touchedPaths and ref options", () => {
      const result = createIssueCompletionCommitProofSchema.safeParse({
        sha: "cf2c34437",
        repoPath: "/tmp/repo",
        ref: "feature/zal-86",
        touchedPaths: ["packages/shared/src/validators/completion-proof.ts"],
        note: "Initial gate wiring",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("createIssueCompletionPeerVerificationProofSchema", () => {
    it("accepts a minimal valid peer verification payload", () => {
      const result = createIssueCompletionPeerVerificationProofSchema.safeParse({
        sha: "cf2c34437e03b9c2bd2547560a83c7b8cf36a5dc",
        repoPath: "/Users/elvisvaldesinerarte/Desktop/_PROYECTOS/Paperclip",
        peerWorktree: "/Users/elvisvaldesinerarte/.paperclip/instances/default/workspaces/web-developer",
        commands: ["git cat-file -t cf2c34437", "git log -1 --format=%H cf2c34437"],
        commandOutput: "commit\ncf2c34437e03b9c2bd2547560a83c7b8cf36a5dc\n",
      });
      expect(result.success).toBe(true);
    });

    it("rejects when peerWorktree is missing", () => {
      const result = createIssueCompletionPeerVerificationProofSchema.safeParse({
        sha: "cf2c34437",
        repoPath: "/tmp/repo",
        commands: ["git cat-file -t cf2c34437"],
        commandOutput: "commit\n",
      });
      expect(result.success).toBe(false);
    });

    it("rejects when commands array is empty", () => {
      const result = createIssueCompletionPeerVerificationProofSchema.safeParse({
        sha: "cf2c34437",
        repoPath: "/tmp/repo",
        peerWorktree: "/tmp/peer",
        commands: [],
        commandOutput: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects when SHA is malformed", () => {
      const result = createIssueCompletionPeerVerificationProofSchema.safeParse({
        sha: "not-a-sha",
        repoPath: "/tmp/repo",
        peerWorktree: "/tmp/peer",
        commands: ["git cat-file -t cf2c34437"],
        commandOutput: "commit\n",
      });
      expect(result.success).toBe(false);
    });
  });
});
