import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import type {
  IssueCompletionProof,
  IssueCompletionProofKind,
} from "@paperclipai/shared";

/**
 * CompletionProofs are signed, immutable proof objects attached to an issue
 * that must exist before the runtime will accept an `in_review → done`
 * transition on a code issue (C-1 + C-3 of ZAL-86 / ZAL-88).
 *
 * Two kinds are accepted:
 *
 *   - `commit`: the agent that produced the code submits the SHA + repoPath.
 *     The runtime resolves it via `git -C <repoPath> cat-file -t <sha>` at
 *     transition time. A missing or fabricated SHA returns `409 ProofRequired`.
 *
 *   - `peer_verification`: a second agent (distinct `authorAgentId` from the
 *     issuer, distinct worktree) posts the executable commands + their literal
 *     output that independently resolves the same SHA. The runtime enforces a
 *     60-second freshness window between the comment and the transition.
 *
 * Rows are immutable by convention. A board user may supersede a proof by
 * setting `supersededAt` (which the runtime treats as soft-deleted); any other
 * UPDATE is rejected by the service layer and recorded as a `tamperAttempt`
 * in `activity_log`.
 *
 * Why a separate table from `issue_work_products` (which holds external
 * artifacts like deployments and PR links): we need a different write path
 * with stricter authorization (no agent may edit after insert) and a different
 * index strategy (we look up by `kind+submittedAt` per issue, not by
 * `provider+externalId`).
 */
export const issueCompletionProofs = pgTable(
  "issue_completion_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IssueCompletionProofKind>().notNull(),
    payload: jsonb("payload").$type<IssueCompletionProof["payload"]>().notNull(),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    submittedByUserId: text("submitted_by_user_id"),
    submittedByRunId: uuid("submitted_by_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set by the runtime when this proof is consumed as evidence for an
     * `in_review → done` transition. Multiple proofs can share the same
     * transition reference (one `commit` + one `peer_verification` is the
     * common case). NULL means the proof is attached but unused.
     */
    consumedAtTransitionId: uuid("consumed_at_transition_id"),
    /**
     * Soft-delete marker. Only board users may set it; once set, the runtime
     * rejects any transition that references this proof. The row is kept
     * forever for audit purposes.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByAgentId: uuid("superseded_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    supersededByUserId: text("superseded_by_user_id"),
    supersededReason: text("superseded_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueKindIdx: index("issue_completion_proofs_issue_kind_idx").on(
      table.companyId,
      table.issueId,
      table.kind,
    ),
    submittedAtIdx: index("issue_completion_proofs_submitted_at_idx").on(
      table.companyId,
      table.submittedAt,
    ),
    /**
     * A peer-verification proof is unique per (issue, kind, sha) so the same
     * proof cannot be submitted twice. Commit proofs do not carry this
     * constraint because stacked commits / amends are legitimate.
     */
    peerUniqueIdx: uniqueIndex("issue_completion_proofs_peer_unique_idx")
      .on(table.issueId, table.kind, sql`(${table.payload}->>'sha')`)
      .where(sql`${table.kind} = 'peer_verification'`),
  }),
);

export type IssueCompletionProofRow = typeof issueCompletionProofs.$inferSelect;
export type IssueCompletionProofInsert = typeof issueCompletionProofs.$inferInsert;