-- ZAL-88: project-scoped repo-path allowlist for the SHA gate.
--
-- A commit proof whose `repoPath` is not in the project's `code_repo_paths`
-- list is rejected with `409 RepoNotRegistered` at `in_review -> done`
-- transitions. Empty list = no commit proofs accepted. Zaltyko-web and
-- Zaltyko-mobile projects register both their canonical repo paths.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "code_repo_paths" jsonb;--> statement-breakpoint
