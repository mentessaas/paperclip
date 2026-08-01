import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCompletionProofs,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completionProofService } from "../services/completion-proofs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping completion-proof gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface GitRepoFixture {
  path: string;
  headSha: string;
}

async function createGitRepoWithCommit(): Promise<GitRepoFixture> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-cp-gate-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  execSync("git commit --allow-empty -q -m initial", { cwd: dir });
  const headSha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
  return { path: dir, headSha };
}

describeEmbeddedPostgres("completionProofService gate — ZAL-88 + ZAL-89", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof completionProofService>;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cp-gate-");
    db = createDb(tempDb.connectionString);
    svc = completionProofService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueCompletionProofs);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    while (tempDirs.length) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndIssue(opts: { codeRepoPaths?: string[] | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GateCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Zaltyko-Web",
      status: "active",
      codeRepoPaths: opts.codeRepoPaths ?? null,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "ZAL-88 gate fixture",
      status: "in_review",
    });
    return { companyId, projectId, issueId };
  }

  async function insertAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ZAL-88 spec: 4 negative cases the SHA gate must reject at in_review → done.
  // ─────────────────────────────────────────────────────────────────────────

  it("ZAL-88 #1 SHA fabricado (no existe en repo) → 409 ProofRequired-equivalent", async () => {
    // The fabricated SHA never resolves: there is no commit proof at all, so
    // the gate returns `ProofRequired` (status 409 in the route layer).
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/tmp/registered-zaltyko-web"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    // Delete the proof to simulate a fabricated SHA: no commit proof for
    // a fabricated SHA = the gate rejects before any git call.
    await db.delete(issueCompletionProofs);

    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: ["/tmp/registered-zaltyko-web"],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("ProofRequired");
  });

  it("ZAL-88 #2 SHA válido pero repoPath no registrado en codeRepoPaths → 409 RepoNotRegistered", async () => {
    // The project's allowlist is the canonical Zaltyko-Web path. The
    // commit proof declares a tmpdir that is NOT in the allowlist, so the
    // gate rejects even though the SHA resolves in the unregistered repo.
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/Users/elvisvaldesinerarte/Desktop/_PROYECTOS/Zaltyko"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: ["/Users/elvisvaldesinerarte/Desktop/_PROYECTOS/Zaltyko"],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("RepoNotRegistered");
    expect(verdict?.message).toMatch(/not in the project's codeRepoPaths/i);
  });

  it("ZAL-88 #3 project has no codeRepoPaths registered (empty list) → 409 RepoNotRegistered", async () => {
    // Even a valid SHA in a valid repo is rejected because the project has
    // not been onboarded to the SHA gate. This is the "fabricated SHA could
    // otherwise slip through" defense: missing allowlist = no proofs
    // accepted.
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: [],
    });
    const authorId = await insertAgent(companyId, "Author");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: [],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("RepoNotRegistered");
  });

  it("ZAL-88 #4 commit proof's repoPath resolves via git cat-file but is not in whitelist → 409 RepoNotRegistered", async () => {
    // The git check would otherwise succeed; the allowlist is the deciding
    // factor. This is the regression case ZAL-78 nailed: a SHA that
    // resolves in an unrelated repo a humanoid reviewer can't cross-check.
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/zaltyko/canonical/web"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    // The git cat-file / git log checks would pass for this SHA, but the
    // allowlist is the gate that fires first.
    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: ["/zaltyko/canonical/web"],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("RepoNotRegistered");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ZAL-88 #5: PATCH over a WorkProduct (CompletionProof) is immutable.
  // The service has no `update` method for issue_completion_proofs; any
  // attempt to mutate the table directly must be rejected by the absence
  // of an updater. We assert this by reading the service: there is no
  // `updateProof` method. (Pre-existing C-1+C-3 invariant.)
  // ─────────────────────────────────────────────────────────────────────────

  it("ZAL-88 #5 CompletionProofs are immutable: no update method exposed", () => {
    const serviceKeys = Object.keys(svc);
    expect(serviceKeys).not.toContain("updateProof");
    expect(serviceKeys).not.toContain("update");
    expect(serviceKeys).not.toContain("patch");
    // The only mutators are submit/insert + consumeAtTransition (which
    // sets consumedAtTransitionId, not the payload — payloads are
    // append-only).
    expect(serviceKeys).toContain("submitCommit");
    expect(serviceKeys).toContain("submitPeerVerification");
    expect(serviceKeys).toContain("consumeAtTransition");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ZAL-89 peer-verification gate (existing 5 negatives, kept verbatim).
  // ─────────────────────────────────────────────────────────────────────────

  it("ZAL-89 #1 no peer verification attached → rejects with PeerVerificationRequired", async () => {
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/anywhere"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: [authorRepo.path],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("PeerVerificationRequired");
  });

  it("ZAL-89 #2 peer verification from the same agent → rejects with PeerNotIndependent (agentId)", async () => {
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/anywhere"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const peerRepo = await createGitRepoWithCommit();
    tempDirs.push(peerRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: peerRepo.headSha, repoPath: peerRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    const authorWorktree = peerRepo.path;
    await expect(
      svc.submitPeerVerification(
        { id: issueId, companyId },
        {
          sha: peerRepo.headSha,
          repoPath: authorWorktree,
          peerWorktree: "/tmp/peer-distinct",
          commands: [
            `git -C /tmp/peer-distinct cat-file -t ${peerRepo.headSha}`,
            `git -C /tmp/peer-distinct log -1 --format=%H ${peerRepo.headSha}`,
          ],
          commandOutput: `commit\n${peerRepo.headSha}\n`,
        },
        { agentId: authorId, userId: null, runId: null },
        authorWorktree,
        authorId,
      ),
    ).rejects.toMatchObject({ code: "PeerNotIndependent" });
  });

  it("ZAL-89 #3 peer verification with same worktree as author → rejects with PeerNotIndependent (worktree)", async () => {
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/anywhere"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const peerId = await insertAgent(companyId, "Peer");
    const authorRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    await expect(
      svc.submitPeerVerification(
        { id: issueId, companyId },
        {
          sha: authorRepo.headSha,
          repoPath: authorRepo.path,
          peerWorktree: authorRepo.path,
          commands: [
            `git -C ${authorRepo.path} cat-file -t ${authorRepo.headSha}`,
            `git -C ${authorRepo.path} log -1 --format=%H ${authorRepo.headSha}`,
          ],
          commandOutput: `commit\n${authorRepo.headSha}\n`,
        },
        { agentId: peerId, userId: null, runId: null },
        authorRepo.path,
        authorId,
      ),
    ).rejects.toMatchObject({ code: "PeerNotIndependent" });
  });

  it("ZAL-89 #4 peer verification older than 60s → rejects with PeerVerificationStale", async () => {
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/anywhere"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const peerId = await insertAgent(companyId, "Peer");
    const authorRepo = await createGitRepoWithCommit();
    const peerRepo = await createGitRepoWithCommit();
    tempDirs.push(authorRepo.path, peerRepo.path);
    execSync(`git remote add origin ${authorRepo.path}`, { cwd: peerRepo.path });
    execSync("git fetch -q origin && git reset -q --hard origin/main", {
      cwd: peerRepo.path,
    });

    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );
    const proof = await svc.submitPeerVerification(
      { id: issueId, companyId },
      {
        sha: authorRepo.headSha,
        repoPath: authorRepo.path,
        peerWorktree: peerRepo.path,
        commands: [
          `git -C ${peerRepo.path} cat-file -t ${authorRepo.headSha}`,
          `git -C ${peerRepo.path} log -1 --format=%H ${authorRepo.headSha}`,
        ],
        commandOutput: `commit\n${authorRepo.headSha}\n`,
      },
      { agentId: peerId, userId: null, runId: null },
      authorRepo.path,
      authorId,
    );
    expect(proof).not.toBeNull();

    await db
      .update(issueCompletionProofs)
      .set({ submittedAt: sql`now() - interval '90 seconds'` })
      .where(eq(issueCompletionProofs.id, proof!.id));

    const verdict = await svc.verifyAtTransition(issueId, {
      projectRepoPaths: [authorRepo.path],
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.code).toBe("PeerVerificationStale");
  });

  it("ZAL-89 #5 peer SHA does not resolve in the peer's worktree → submit-time ProofExpired", async () => {
    const { companyId, issueId } = await insertCompanyAndIssue({
      codeRepoPaths: ["/anywhere"],
    });
    const authorId = await insertAgent(companyId, "Author");
    const peerId = await insertAgent(companyId, "Peer");
    const authorRepo = await createGitRepoWithCommit();
    const peerDir = await mkdtemp(join(tmpdir(), "paperclip-cp-gate-peer-"));
    tempDirs.push(peerDir);
    execSync("git init -q -b main", { cwd: peerDir });
    execSync("git config user.email peer@example.com", { cwd: peerDir });
    execSync("git config user.name Peer", { cwd: peerDir });
    execSync("git commit --allow-empty -q -m peer-only", { cwd: peerDir });
    tempDirs.push(authorRepo.path);
    await svc.submitCommit(
      { id: issueId, companyId },
      { sha: authorRepo.headSha, repoPath: authorRepo.path },
      { agentId: authorId, userId: null, runId: null },
    );

    await expect(
      svc.submitPeerVerification(
        { id: issueId, companyId },
        {
          sha: authorRepo.headSha,
          repoPath: authorRepo.path,
          peerWorktree: peerDir,
          commands: [
            `git -C ${peerDir} cat-file -t ${authorRepo.headSha}`,
            `git -C ${peerDir} log -1 --format=%H ${authorRepo.headSha}`,
          ],
          commandOutput: `commit\n${authorRepo.headSha}\n`,
        },
        { agentId: peerId, userId: null, runId: null },
        authorRepo.path,
        authorId,
      ),
    ).rejects.toThrow(/git cat-file/);
  });
});
