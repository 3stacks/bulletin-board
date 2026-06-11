import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  canonicalDir,
  canonicalResource,
  findConflicts,
  findResourceConflicts,
  openBoard,
  ownLiveClaimOn,
  ownLiveResourceClaim,
  parseDuration,
  pathsOverlap,
  post,
  refreshClaim,
  release,
  renew,
  setCursor,
  unread,
  nowSec,
} from "./board";
import {
  makeDirectoryClaimPolicy,
  parseDockerOp,
  parseGitOp,
} from "./toolgate-policy";

const TMP = join(tmpdir(), `bb-test-${process.pid}.db`);

beforeEach(() => {
  process.env.BB_DB = TMP;
});
afterEach(() => {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try {
      rmSync(f);
    } catch {}
  }
});

function claim(agent: string, path: string) {
  const db = openBoard()!;
  const b = post(db, {
    kind: "claim",
    scope: "dir",
    path,
    branch: "main",
    ttl: 3600,
    agent,
    display: agent,
  });
  db.close();
  return b;
}

function claimResource(agent: string, resource: string) {
  const db = openBoard()!;
  const b = post(db, {
    kind: "claim",
    scope: "resource",
    resource,
    ttl: 3600,
    agent,
    display: agent,
  });
  db.close();
  return b;
}

test("pathsOverlap respects segment boundaries", () => {
  expect(pathsOverlap("/a/b", "/a/b")).toBe(true);
  expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true); // child
  expect(pathsOverlap("/a/b/c", "/a/b")).toBe(true); // parent
  expect(pathsOverlap("/a/foo", "/a/foobar")).toBe(false); // not a prefix match
  expect(pathsOverlap("/a/b", "/x/y")).toBe(false);
});

test("parseDuration handles units and bare seconds", () => {
  expect(parseDuration("30")).toBe(30);
  expect(parseDuration("30m")).toBe(1800);
  expect(parseDuration("2h")).toBe(7200);
  expect(parseDuration("1d")).toBe(86400);
  expect(parseDuration("1w")).toBe(604800);
  expect(() => parseDuration("soon")).toThrow();
});

test("a claim conflicts for a different agent but not the owner", () => {
  claim("tmux:%2", "/repo/ko-sites");
  const db = openBoard()!;
  expect(findConflicts(db, "/repo/ko-sites", "tmux:%5")).toHaveLength(1);
  expect(findConflicts(db, "/repo/ko-sites", "tmux:%2")).toHaveLength(0); // self
  expect(findConflicts(db, "/repo/ko-sites/app", "tmux:%5")).toHaveLength(1); // child dir
  expect(findConflicts(db, "/repo/other", "tmux:%5")).toHaveLength(0);
  db.close();
});

test("released and expired claims stop conflicting", () => {
  const b = claim("tmux:%2", "/repo/ko-sites");
  let db = openBoard()!;
  expect(findConflicts(db, "/repo/ko-sites", "tmux:%5")).toHaveLength(1);
  release(db, { id: b.id });
  expect(findConflicts(db, "/repo/ko-sites", "tmux:%5")).toHaveLength(0);
  db.close();
});

test("renew extends expiry", () => {
  const b = claim("tmux:%2", "/repo/ko-sites");
  const db = openBoard()!;
  const [renewed] = renew(db, { id: b.id, agent: "tmux:%2" }, 7200);
  expect(renewed.expires_at).toBeGreaterThanOrEqual(nowSec() + 7100);
  db.close();
});

test("unread returns others' new bulletins and respects the cursor", () => {
  claim("tmux:%2", "/repo/a");
  const db = openBoard()!;
  // %5 has never looked: sees %2's claim.
  expect(unread(db, "tmux:%5")).toHaveLength(1);
  // %2 doesn't see its own.
  expect(unread(db, "tmux:%2")).toHaveLength(0);
  // After %5 marks seen, nothing new...
  setCursor(db, "tmux:%5");
  expect(unread(db, "tmux:%5")).toHaveLength(0);
  // ...until another agent posts.
  post(db, {
    kind: "note", scope: "global", message: "heads up", ttl: 3600,
    agent: "tmux:%9", display: "tmux:%9",
  });
  expect(unread(db, "tmux:%5")).toHaveLength(1);
  db.close();
});

test("ownLiveClaimOn + refreshClaim back idempotent claims", () => {
  const c = claim("tmux:%2", "/repo/a");
  const db = openBoard()!;
  expect(ownLiveClaimOn(db, "tmux:%2", "/repo/a")?.id).toBe(c.id);
  expect(ownLiveClaimOn(db, "tmux:%2", "/repo/b")).toBeNull(); // different dir
  expect(ownLiveClaimOn(db, "tmux:%9", "/repo/a")).toBeNull(); // different agent
  const refreshed = refreshClaim(db, c.id, { branch: "feat/x", message: "still here", ttl: 7200 });
  expect(refreshed.message).toBe("still here");
  expect(refreshed.branch).toBe("feat/x");
  expect(refreshed.expires_at).toBeGreaterThanOrEqual(nowSec() + 7100);
  // still exactly one live claim on that dir (refreshed, not duplicated)
  expect(findConflicts(db, "/repo/a", "tmux:%9")).toHaveLength(1);
  db.close();
});

test("parseGitOp detects destructive ops and extracts dirs", () => {
  const subs = ["checkout", "switch", "reset", "clean", "rebase", "merge"];
  expect(parseGitOp("git status", subs)).toBeNull();
  expect(parseGitOp("git log --oneline", subs)).toBeNull();
  expect(parseGitOp("ls -la", subs)).toBeNull();
  expect(parseGitOp("git switch main", subs)).toEqual({});
  expect(parseGitOp("git checkout -b feat", subs)).toEqual({});
  expect(parseGitOp("git -C /repo/ko-sites reset --hard", subs)).toEqual({
    dir: "/repo/ko-sites",
  });
  expect(parseGitOp("cd /repo/ko-sites && git switch main", subs)).toEqual({
    dir: "/repo/ko-sites",
  });
});

test("canonicalResource builds <type>:<id> keys", () => {
  expect(canonicalResource("docker:kohub-api")).toBe("docker:kohub-api");
  expect(canonicalResource("kohub-api")).toBe("resource:kohub-api"); // default type
  expect(canonicalResource("  PORT : 3000 ")).toBe("port:3000"); // trim + lc type
  expect(() => canonicalResource("   ")).toThrow();
  expect(() => canonicalResource("docker:")).toThrow(); // empty id
});

test("resource claims conflict on exact key, not for the owner", () => {
  claimResource("tmux:%2", "docker:kohub-api");
  const db = openBoard()!;
  expect(findResourceConflicts(db, "docker:kohub-api", "tmux:%5")).toHaveLength(1);
  expect(findResourceConflicts(db, "docker:kohub-api", "tmux:%2")).toHaveLength(0); // self
  expect(findResourceConflicts(db, "docker:other", "tmux:%5")).toHaveLength(0); // diff id
  expect(findResourceConflicts(db, "port:kohub-api", "tmux:%5")).toHaveLength(0); // diff type
  db.close();
});

test("resource claims are idempotent and releasable by key", () => {
  const me = "tmux:%2";
  claimResource(me, "docker:db");
  const db = openBoard()!;
  expect(ownLiveResourceClaim(db, me, "docker:db")?.resource).toBe("docker:db");
  expect(ownLiveResourceClaim(db, me, "docker:web")).toBeNull();
  expect(release(db, { agent: me, resource: "docker:db" })).toBe(1);
  expect(findResourceConflicts(db, "docker:db", "tmux:%9")).toHaveLength(0);
  db.close();
});

test("releasing a resource leaves the agent's dir claims alone", () => {
  const me = "tmux:%2";
  claim(me, "/repo/a");
  claimResource(me, "docker:db");
  const db = openBoard()!;
  release(db, { agent: me, resource: "docker:db" });
  // dir claim still live; resource gone
  expect(findConflicts(db, "/repo/a", "tmux:%9")).toHaveLength(1);
  expect(findResourceConflicts(db, "docker:db", "tmux:%9")).toHaveLength(0);
  db.close();
});

test("parseDockerOp detects container ops and extracts names", () => {
  const cont = ["stop", "kill", "rm", "restart", "pause", "unpause"];
  const comp = ["down", "stop", "restart", "kill", "rm"];
  // non-destructive / non-docker → ignored
  expect(parseDockerOp("docker ps", cont, comp)).toBeNull();
  expect(parseDockerOp("docker logs kohub-api", cont, comp)).toBeNull();
  expect(parseDockerOp("ls -la", cont, comp)).toBeNull();
  expect(parseDockerOp("docker compose up -d", cont, comp)).toBeNull(); // up not gated
  // container ops + names (flags and their values skipped)
  expect(parseDockerOp("docker stop kohub-api", cont, comp)).toEqual({
    kind: "container",
    names: ["kohub-api"],
  });
  expect(parseDockerOp("docker rm -f web db", cont, comp)).toEqual({
    kind: "container",
    names: ["web", "db"],
  });
  expect(parseDockerOp("docker stop -t 5 api", cont, comp)).toEqual({
    kind: "container",
    names: ["api"],
  });
  expect(parseDockerOp("docker container restart api", cont, comp)).toEqual({
    kind: "container",
    names: ["api"],
  });
});

test("parseDockerOp detects compose teardown and project dir", () => {
  const cont = ["stop", "kill", "rm", "restart", "pause", "unpause"];
  const comp = ["down", "stop", "restart", "kill", "rm"];
  expect(parseDockerOp("docker compose down", cont, comp)).toEqual({ kind: "compose" });
  expect(parseDockerOp("docker-compose stop", cont, comp)).toEqual({ kind: "compose" });
  expect(parseDockerOp("docker compose ps", cont, comp)).toBeNull(); // ps not gated
  expect(parseDockerOp("cd /repo/kohub-api && docker compose down", cont, comp)).toEqual({
    kind: "compose",
    dir: "/repo/kohub-api",
  });
  expect(
    parseDockerOp("docker compose --project-directory /srv/app down", cont, comp),
  ).toEqual({ kind: "compose", dir: "/srv/app" });
});

/** Run the gate's handler with injected verdicts; returns which one fired. */
async function gateVerdict(
  command: string,
  selfAgent: string,
  cwd: string,
): Promise<"ask" | "next"> {
  const prev = process.env.BB_AGENT;
  process.env.BB_AGENT = selfAgent;
  try {
    const policy = makeDirectoryClaimPolicy({
      ask: () => "ask" as const,
      next: () => "next" as const,
    });
    return (await policy.handler({
      tool: "Bash",
      args: { command },
      context: { cwd },
    })) as "ask" | "next";
  } finally {
    if (prev === undefined) delete process.env.BB_AGENT;
    else process.env.BB_AGENT = prev;
  }
}

test("gate asks before a destructive docker op on a claimed container", async () => {
  claimResource("tmux:%owner", "docker:kohub-api");
  expect(await gateVerdict("docker stop kohub-api", "tmux:%me", "/tmp")).toBe("ask");
  expect(await gateVerdict("docker rm -f kohub-api", "tmux:%me", "/tmp")).toBe("ask");
  expect(await gateVerdict("docker stop kohub-api", "tmux:%owner", "/tmp")).toBe("next"); // self
  expect(await gateVerdict("docker stop unrelated", "tmux:%me", "/tmp")).toBe("next"); // unclaimed
  expect(await gateVerdict("docker ps", "tmux:%me", "/tmp")).toBe("next"); // not destructive
});

test("gate asks before `docker compose down` in a claimed project dir", async () => {
  // A non-existent /tmp subdir → not a git repo → canonicalDir returns it as-is.
  const dir = join(tmpdir(), `bb-gate-${process.pid}`);
  const target = canonicalDir(dir, dir);
  const db = openBoard()!;
  post(db, {
    kind: "claim", scope: "dir", path: target, branch: "main",
    ttl: 3600, agent: "tmux:%owner", display: "tmux:%owner",
  });
  db.close();
  expect(await gateVerdict("docker compose down", "tmux:%me", dir)).toBe("ask");
  expect(await gateVerdict("docker compose down", "tmux:%owner", dir)).toBe("next"); // self
  expect(await gateVerdict("docker compose up -d", "tmux:%me", dir)).toBe("next"); // up not gated
});
