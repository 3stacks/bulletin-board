import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findConflicts,
  openBoard,
  ownLiveClaimOn,
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
import { parseGitOp } from "./toolgate-policy";

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
