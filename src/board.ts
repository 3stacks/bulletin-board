/**
 * bulletin-board — core domain logic.
 *
 * A local, file-backed bulletin board so concurrent agents (e.g. several Claude
 * Code instances) can announce intent and claim working directories before they
 * do something destructive — like checking out a branch in a repo another agent
 * is mid-edit on.
 *
 * This module has ZERO dependency on toolgate or any host. It is pure SQLite +
 * path logic so it can be used standalone or wired into any policy engine.
 */

import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join, resolve } from "path";

export type Kind = "claim" | "note";
export type Scope = "dir" | "global";

export interface Bulletin {
  id: number;
  kind: Kind;
  scope: Scope;
  /** Canonical absolute directory (git toplevel when inside a repo). null for global. */
  path: string | null;
  branch: string | null;
  /** Stable identity key used for matching/self-exclusion (e.g. "tmux:%2"). */
  agent: string;
  /** Human-friendly label for display (e.g. "grind:%2"). */
  display: string;
  host: string;
  pid: number | null;
  message: string | null;
  created_at: number;
  expires_at: number;
  released_at: number | null;
}

/** Default TTLs in seconds, keyed by what is being posted. */
export const DEFAULT_TTL = {
  claim: 2 * 60 * 60, // 2h — active work; auto-frees if an agent dies/forgets
  note: 24 * 60 * 60, // 1d — dir-scoped informational note
  global: 7 * 24 * 60 * 60, // 7d — global announcement
} as const;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Resolve the board database path. Override with $BB_DB. */
export function dbPath(): string {
  if (process.env.BB_DB) return process.env.BB_DB;
  return join(homedir(), ".bulletin-board", "board.db");
}

/**
 * Open (and migrate) the board.
 * Pass { create: false } on read-only hot paths (e.g. a hook): returns null if
 * the DB does not exist yet, avoiding a side-effecting file creation.
 */
export function openBoard(opts: { create?: boolean } = {}): Database | null {
  const path = dbPath();
  const fresh = !existsSync(path);
  if (fresh && opts.create === false) return null;
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bulletins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      scope       TEXT NOT NULL,
      path        TEXT,
      branch      TEXT,
      agent       TEXT NOT NULL,
      display     TEXT NOT NULL,
      host        TEXT NOT NULL,
      pid         INTEGER,
      message     TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bulletins_path ON bulletins(path);
    CREATE INDEX IF NOT EXISTS idx_bulletins_expires ON bulletins(expires_at);

    -- Per-agent "last seen" cursor (bulletin id, monotonic — no clock issues),
    -- so an agent can pull only what's new.
    CREATE TABLE IF NOT EXISTS cursors (
      agent   TEXT PRIMARY KEY,
      seen_id INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Stable identity key for the current agent, used for matching and
 * self-exclusion. Cheap (no subprocess) so it is safe on hook hot paths.
 *
 * Resolution order:
 *   1. $BB_AGENT  — explicit override (set this for non-tmux / overseer agents)
 *   2. tmux:<pane> — from $TMUX_PANE, unique per tmux pane
 *   3. pid:<ppid>  — last-resort fallback
 */
export function agentKey(): string {
  if (process.env.BB_AGENT) return process.env.BB_AGENT;
  if (process.env.TMUX_PANE) return `tmux:${process.env.TMUX_PANE}`;
  return `pid:${process.ppid}`;
}

/** Human-friendly label (may shell out to tmux). Used for display only. */
export function agentDisplay(): string {
  if (process.env.BB_AGENT) return process.env.BB_AGENT;
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      const session = execSync("tmux display-message -p '#S'", {
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      if (session) return `${session}:${pane}`;
    } catch {
      // fall through
    }
    return pane;
  }
  return `pid:${process.ppid}@${hostname()}`;
}

/** Best-effort owning pid for display (the tmux pane's process). */
export function agentPid(): number | null {
  if (!process.env.TMUX_PANE) return process.ppid ?? null;
  try {
    const out = execSync("tmux display-message -p '#{pane_pid}'", {
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Find the git toplevel for a directory, or null if not in a repo. */
export function findGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Current branch of a repo at `cwd`, or null. */
export function currentBranch(cwd: string): string | null {
  try {
    const b = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalise a directory for a claim/check: resolve relative to `cwd`, expand
 * `~`, then prefer the git toplevel so "claiming ko-sites" means the whole repo
 * regardless of which subdir you ran from.
 */
export function canonicalDir(input: string | undefined, cwd: string): string {
  const start = input ? resolve(cwd, expandTilde(input)) : resolve(cwd);
  return findGitRoot(start) ?? start;
}

/**
 * Two directories conflict when one contains the other (or they are equal).
 * Uses path-segment boundaries so /a/foo does not "overlap" /a/foobar.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aa = a.endsWith("/") ? a : a + "/";
  const bb = b.endsWith("/") ? b : b + "/";
  return aa.startsWith(bb) || bb.startsWith(aa);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const LIVE = "released_at IS NULL AND expires_at > ?";

/** All live bulletins (claims + notes + global), newest first. */
export function liveBulletins(db: Database): Bulletin[] {
  return db
    .query(`SELECT * FROM bulletins WHERE ${LIVE} ORDER BY created_at DESC`)
    .all(nowSec()) as Bulletin[];
}

/** All bulletins including expired/released (history), newest first. */
export function allBulletins(db: Database): Bulletin[] {
  return db
    .query("SELECT * FROM bulletins ORDER BY created_at DESC")
    .all() as Bulletin[];
}

/**
 * Live bulletins affecting `path`: any dir-scoped row whose directory overlaps
 * `path`, plus all global notes. Includes the caller's own rows.
 */
export function bulletinsForPath(db: Database, path: string): Bulletin[] {
  const live = liveBulletins(db);
  return live.filter(
    (b) =>
      b.scope === "global" || (b.path != null && pathsOverlap(b.path, path)),
  );
}

/**
 * The core arbitration query: live CLAIMS on a directory overlapping `path`
 * that are held by an agent OTHER than `selfAgent`. An empty array means the
 * caller is free to operate in `path`.
 */
export function findConflicts(
  db: Database,
  path: string,
  selfAgent: string,
): Bulletin[] {
  const rows = db
    .query(
      `SELECT * FROM bulletins
       WHERE kind = 'claim' AND scope = 'dir' AND ${LIVE} AND agent != ?
       ORDER BY created_at ASC`,
    )
    .all(nowSec(), selfAgent) as Bulletin[];
  return rows.filter((b) => b.path != null && pathsOverlap(b.path, path));
}

/** Live bulletins owned by `agent`. */
export function bulletinsByAgent(db: Database, agent: string): Bulletin[] {
  return db
    .query(`SELECT * FROM bulletins WHERE ${LIVE} AND agent = ? ORDER BY created_at DESC`)
    .all(nowSec(), agent) as Bulletin[];
}

/** The agent's last-seen bulletin id; 0 if never set. */
export function getCursor(db: Database, agent: string): number {
  const row = db
    .query("SELECT seen_id FROM cursors WHERE agent = ?")
    .get(agent) as { seen_id: number } | null;
  return row?.seen_id ?? 0;
}

function maxId(db: Database): number {
  const row = db.query("SELECT MAX(id) AS m FROM bulletins").get() as {
    m: number | null;
  };
  return row?.m ?? 0;
}

/** Mark the agent as having seen everything up to `id` (default: latest). */
export function setCursor(db: Database, agent: string, id?: number): void {
  db.run(
    `INSERT INTO cursors (agent, seen_id) VALUES (?, ?)
     ON CONFLICT(agent) DO UPDATE SET seen_id = excluded.seen_id`,
    [agent, id ?? maxId(db)],
  );
}

/**
 * Live bulletins posted by OTHER agents since `agent` last looked — the
 * "what changed while I was working" feed. Newest first.
 */
export function unread(db: Database, agent: string): Bulletin[] {
  const since = getCursor(db, agent);
  return db
    .query(
      `SELECT * FROM bulletins
       WHERE ${LIVE} AND agent != ? AND id > ?
       ORDER BY created_at DESC`,
    )
    .all(nowSec(), agent, since) as Bulletin[];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface PostInput {
  kind: Kind;
  scope: Scope;
  path?: string | null;
  branch?: string | null;
  message?: string | null;
  ttl: number; // seconds
  agent: string;
  display: string;
  host?: string;
  pid?: number | null;
}

export function post(db: Database, input: PostInput): Bulletin {
  const created = nowSec();
  const row = db
    .query(
      `INSERT INTO bulletins
         (kind, scope, path, branch, agent, display, host, pid, message, created_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       RETURNING *`,
    )
    .get(
      input.kind,
      input.scope,
      input.path ?? null,
      input.branch ?? null,
      input.agent,
      input.display,
      input.host ?? hostname(),
      input.pid ?? null,
      input.message ?? null,
      created,
      created + input.ttl,
    ) as Bulletin;
  return row;
}

/** Mark live bulletins released. Returns the number released. */
export function release(
  db: Database,
  filter: { id?: number; agent?: string; path?: string },
): number {
  const now = nowSec();
  if (filter.id != null) {
    const r = db.run(
      `UPDATE bulletins SET released_at = ? WHERE id = ? AND released_at IS NULL`,
      [now, filter.id],
    );
    return r.changes;
  }
  // Release the agent's own live rows, optionally narrowed to a path overlap.
  const rows = db
    .query(`SELECT * FROM bulletins WHERE ${LIVE} AND agent = ?`)
    .all(now, filter.agent ?? "") as Bulletin[];
  let n = 0;
  const stmt = db.query(`UPDATE bulletins SET released_at = ? WHERE id = ?`);
  for (const b of rows) {
    if (filter.path && !(b.path != null && pathsOverlap(b.path, filter.path)))
      continue;
    stmt.run(now, b.id);
    n++;
  }
  return n;
}

/** Forcibly release others' live claims overlapping a path (the --steal path). */
export function stealOverlapping(
  db: Database,
  path: string,
  selfAgent: string,
): Bulletin[] {
  const victims = findConflicts(db, path, selfAgent);
  const now = nowSec();
  const stmt = db.query(`UPDATE bulletins SET released_at = ? WHERE id = ?`);
  for (const v of victims) stmt.run(now, v.id);
  return victims;
}

/** Extend a bulletin's expiry to now + ttl. Returns updated rows. */
export function renew(
  db: Database,
  filter: { id?: number; agent: string; path?: string },
  ttl: number,
): Bulletin[] {
  const now = nowSec();
  const expires = now + ttl;
  let targets: Bulletin[];
  if (filter.id != null) {
    targets = db
      .query(`SELECT * FROM bulletins WHERE id = ? AND ${LIVE}`)
      .all(filter.id, now) as Bulletin[];
  } else {
    const rows = db
      .query(`SELECT * FROM bulletins WHERE ${LIVE} AND agent = ?`)
      .all(now, filter.agent) as Bulletin[];
    targets = rows.filter(
      (b) => !filter.path || (b.path != null && pathsOverlap(b.path, filter.path)),
    );
  }
  const stmt = db.query(
    `UPDATE bulletins SET expires_at = ? WHERE id = ? RETURNING *`,
  );
  return targets.map((b) => stmt.get(expires, b.id) as Bulletin);
}

/** Hard-delete released/expired rows older than `days`. Returns count removed. */
export function gc(db: Database, days = 7): number {
  const cutoff = nowSec() - days * 24 * 60 * 60;
  const r = db.run(
    `DELETE FROM bulletins
     WHERE (released_at IS NOT NULL AND released_at < ?)
        OR (expires_at < ?)`,
    [cutoff, cutoff],
  );
  return r.changes;
}

// ---------------------------------------------------------------------------
// Duration & formatting helpers
// ---------------------------------------------------------------------------

/** Parse a duration like "30m", "2h", "1d", "1w", or bare seconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhdw])?$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: "${s}" (use e.g. 30m, 2h, 1d, 1w)`);
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? "s";
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit]!;
  return n * mult;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    // Round to whole minutes first, then decompose — avoids "1h60m".
    const totalMin = Math.round(s / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h${m}m` : `${h}h`;
  }
  // Round to whole hours first, then decompose — avoids "6d24h".
  const totalHr = Math.round(s / 3600);
  const d = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return h ? `${d}d${h}h` : `${d}d`;
}

export function fmtAgo(epoch: number): string {
  return `${fmtDuration(nowSec() - epoch)} ago`;
}

export function fmtExpiry(epoch: number): string {
  const left = epoch - nowSec();
  return left <= 0 ? "expired" : `in ${fmtDuration(left)}`;
}
