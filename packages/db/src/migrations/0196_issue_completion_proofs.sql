-- ZAL-86 / ZAL-88 — CompletionProof table for the `in_review → done` SHA gate.
--
-- This migration creates the table that holds immutable proof objects
-- (commits + peer verifications) that the runtime requires before accepting
-- a transition of a code issue from `in_review` to `done`.
--
-- Idempotent: every statement uses IF NOT EXISTS so this migration can be
-- re-run on a database that already has the table.
CREATE TABLE IF NOT EXISTS "issue_completion_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "submitted_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "submitted_by_user_id" text,
  "submitted_by_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "consumed_at_transition_id" uuid,
  "superseded_at" timestamp with time zone,
  "superseded_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "superseded_by_user_id" text,
  "superseded_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issue_completion_proofs_issue_kind_idx"
  ON "issue_completion_proofs"
  USING btree ("company_id","issue_id","kind");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issue_completion_proofs_submitted_at_idx"
  ON "issue_completion_proofs"
  USING btree ("company_id","submitted_at");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "issue_completion_proofs_peer_unique_idx"
  ON "issue_completion_proofs"
  USING btree ("issue_id","kind", (payload->>'sha'))
  WHERE "kind" = 'peer_verification';