#!/usr/bin/env bun
/**
 * bb — bulletin board CLI.
 *
 * Lets concurrent agents announce intent and claim working directories so they
 * don't clobber each other (e.g. two Claude instances checking out branches in
 * the same repo).
 *
 *   bb claim [path]      claim a directory you're working in
 *   bb release [path]    release your claim
 *   bb renew [path]      extend your claim's TTL
 *   bb check [path]      what's claimed here? (exit 3 if a conflict)
 *   bb list              show live bulletins
 *   bb note <text>       post a note (dir-scoped or --global)
 *   bb gc                purge old released/expired rows
 *   bb whoami            show your agent id + db path
 */

import {
  agentDisplay,
  agentKey,
  agentPid,
  allBulletins,
  bulletinsByAgent,
  bulletinsForPath,
  canonicalDir,
  currentBranch,
  dbPath,
  DEFAULT_TTL,
  findConflicts,
  findGitRoot,
  fmtAgo,
  fmtExpiry,
  gc,
  liveBulletins,
  openBoard,
  ownLiveClaimOn,
  parseDuration,
  pathsOverlap,
  post,
  refreshClaim,
  release,
  renew,
  setCursor,
  stealOverlapping,
  unread,
  type Bulletin,
} from "./board";

const HOME = process.env.HOME ?? "";
const tilde = (p: string | null) => (p ? p.replace(HOME, "~") : "—");

// --- tiny flag parser ------------------------------------------------------

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(
  argv: string[],
  spec: { bool: string[]; value: string[]; alias: Record<string, string> },
): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith("-")) {
      a = a.replace(/^-+/, "");
      const name = spec.alias[a] ?? a;
      if (spec.bool.includes(name)) flags[name] = true;
      else if (spec.value.includes(name)) flags[name] = argv[++i];
      else flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function fail(msg: string): never {
  process.stderr.write(`bb: ${msg}\n`);
  process.exit(1);
}

// --- rendering -------------------------------------------------------------

function icon(b: Bulletin): string {
  if (b.scope === "global") return "🌐";
  return b.kind === "claim" ? "🔒" : "📌";
}

function renderBulletin(b: Bulletin, opts: { mineKey?: string } = {}): string {
  const mine = opts.mineKey && b.agent === opts.mineKey ? " (you)" : "";
  const where =
    b.scope === "global" ? "global" : `${tilde(b.path)}${b.branch ? ` @ ${b.branch}` : ""}`;
  const head = `${icon(b)} #${b.id} ${where}`;
  const meta = `   ${b.display}${mine} · ${fmtAgo(b.created_at)} · expires ${fmtExpiry(b.expires_at)}`;
  const note = b.message ? `\n   "${b.message}"` : "";
  return `${head}\n${meta}${note}`;
}

function printList(bulletins: Bulletin[], emptyMsg: string): void {
  if (bulletins.length === 0) {
    console.log(emptyMsg);
    return;
  }
  const me = agentKey();
  console.log(bulletins.map((b) => renderBulletin(b, { mineKey: me })).join("\n\n"));
}

// --- commands --------------------------------------------------------------

function cmdClaim(argv: string[]): void {
  const { positionals, flags } = parseArgs(argv, {
    bool: ["steal"],
    value: ["branch", "ttl", "message"],
    alias: { b: "branch", t: "ttl", m: "message" },
  });
  const db = openBoard()!;
  const target = canonicalDir(positionals[0], process.cwd());
  const ttl = flags.ttl ? parseDuration(String(flags.ttl)) : DEFAULT_TTL.claim;
  const branch =
    (flags.branch as string) ?? currentBranch(target) ?? null;
  const me = agentKey();

  if (flags.steal) {
    const stolen = stealOverlapping(db, target, me);
    if (stolen.length)
      console.log(`Stole ${stolen.length} claim(s): ${stolen.map((s) => s.display).join(", ")}`);
  } else {
    const conflicts = findConflicts(db, target, me);
    if (conflicts.length) {
      console.log("⚠  Already claimed by another agent:");
      printList(conflicts, "");
      console.log("\nClaiming anyway (both claims coexist). Use --steal to release theirs.");
    }
  }

  const message = (flags.message as string) ?? null;
  const existing = ownLiveClaimOn(db, me, target);
  if (existing) {
    // Idempotent: you already hold this dir — refresh rather than duplicate.
    const b = refreshClaim(db, existing.id, { branch, message, ttl });
    console.log(`🔁 Refreshed claim on ${tilde(target)}${branch ? ` @ ${branch}` : ""} (#${b.id}, expires ${fmtExpiry(b.expires_at)})`);
    return;
  }
  const b = post(db, {
    kind: "claim",
    scope: "dir",
    path: target,
    branch,
    message,
    ttl,
    agent: me,
    display: agentDisplay(),
    pid: agentPid(),
  });
  console.log(`🔒 Claimed ${tilde(target)}${branch ? ` @ ${branch}` : ""} (#${b.id}, expires ${fmtExpiry(b.expires_at)})`);
}

function cmdRelease(argv: string[]): void {
  const { positionals, flags } = parseArgs(argv, {
    bool: ["all"],
    value: ["id"],
    alias: {},
  });
  const db = openBoard()!;
  const me = agentKey();
  let n: number;
  if (flags.id != null) n = release(db, { id: parseInt(String(flags.id), 10) });
  else if (flags.all) n = release(db, { agent: me });
  else n = release(db, { agent: me, path: canonicalDir(positionals[0], process.cwd()) });
  console.log(n ? `Released ${n} bulletin(s).` : "Nothing to release.");
}

function cmdRenew(argv: string[]): void {
  const { positionals, flags } = parseArgs(argv, {
    bool: [],
    value: ["id", "ttl"],
    alias: { t: "ttl" },
  });
  const db = openBoard()!;
  const ttl = flags.ttl ? parseDuration(String(flags.ttl)) : DEFAULT_TTL.claim;
  const me = agentKey();
  const updated =
    flags.id != null
      ? renew(db, { id: parseInt(String(flags.id), 10), agent: me }, ttl)
      : renew(db, { agent: me, path: canonicalDir(positionals[0], process.cwd()) }, ttl);
  if (!updated.length) {
    console.log("Nothing to renew.");
    return;
  }
  for (const b of updated)
    console.log(`Renewed #${b.id} ${tilde(b.path)} → expires ${fmtExpiry(b.expires_at)}`);
}

function cmdCheck(argv: string[]): void {
  const { positionals } = parseArgs(argv, { bool: [], value: [], alias: {} });
  const db = openBoard({ create: false });
  const target = canonicalDir(positionals[0], process.cwd());
  const me = agentKey();
  if (!db) {
    console.log(`✓ clear — ${tilde(target)}`);
    process.exit(0);
  }
  const here = bulletinsForPath(db, target);
  const conflicts = findConflicts(db, target, me);
  if (here.length) {
    console.log(`Bulletins affecting ${tilde(target)}:\n`);
    printList(here, "");
    console.log("");
  }
  if (conflicts.length) {
    console.log(`✗ conflict — ${conflicts.length} live claim(s) by another agent.`);
    process.exit(3);
  }
  console.log(`✓ clear — no conflicting claims in ${tilde(target)}.`);
  process.exit(0);
}

function cmdList(argv: string[]): void {
  const { flags } = parseArgs(argv, {
    bool: ["global", "mine", "all", "json"],
    value: ["dir"],
    alias: { g: "global" },
  });
  const db = openBoard({ create: false });
  if (!db) {
    if (flags.json) console.log("[]");
    else console.log("No bulletins yet.");
    return;
  }
  let rows = flags.all ? allBulletins(db) : liveBulletins(db);
  if (flags.global) rows = rows.filter((b) => b.scope === "global");
  if (flags.mine) rows = rows.filter((b) => b.agent === agentKey());
  if (flags.dir) {
    const d = canonicalDir(String(flags.dir), process.cwd());
    rows = rows.filter(
      (b) => b.scope === "global" || (b.path != null && pathsOverlap(b.path, d)),
    );
  }
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printList(rows, "No bulletins.");
}

function cmdNote(argv: string[]): void {
  const { positionals, flags } = parseArgs(argv, {
    bool: ["global"],
    value: ["ttl", "path"],
    alias: { g: "global", t: "ttl", p: "path" },
  });
  const text = positionals.join(" ").trim();
  if (!text) fail("note requires text: bb note \"message\" [--global | --path DIR]");
  const db = openBoard()!;
  const global = !!flags.global && !flags.path;
  const ttl = flags.ttl
    ? parseDuration(String(flags.ttl))
    : global
      ? DEFAULT_TTL.global
      : DEFAULT_TTL.note;
  const b = post(db, {
    kind: "note",
    scope: global ? "global" : "dir",
    path: global ? null : canonicalDir((flags.path as string) ?? undefined, process.cwd()),
    message: text,
    ttl,
    agent: agentKey(),
    display: agentDisplay(),
    pid: agentPid(),
  });
  console.log(
    `${global ? "🌐" : "📌"} Noted (#${b.id}, ${global ? "global" : tilde(b.path)}, expires ${fmtExpiry(b.expires_at)})`,
  );
}

function cmdUnread(argv: string[]): void {
  const { flags } = parseArgs(argv, {
    bool: ["peek", "json", "quiet"],
    value: [],
    alias: { q: "quiet" },
  });
  const db = openBoard({ create: false });
  const me = agentKey();
  const rows = db ? unread(db, me) : [];
  if (db && !flags.peek) setCursor(db, me); // advance cursor unless peeking
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    if (!flags.quiet) console.log("Nothing new on the board.");
    return;
  }
  console.log(`📋 ${rows.length} new bulletin(s) since you last looked:\n`);
  printList(rows, "");
}

/**
 * Claude Code lifecycle hooks. Wired in settings.json:
 *   SessionStart → bb hook session-start   (claim this repo for the session)
 *   SessionEnd   → bb hook session-end      (release it)
 * Reads the hook payload (with `cwd`) from stdin. Never throws — a hook must
 * not disrupt the session.
 */
async function cmdHook(argv: string[]): Promise<void> {
  const event = argv[0];
  let input: Record<string, any> = {};
  try {
    const text = await Bun.stdin.text();
    if (text.trim()) input = JSON.parse(text);
  } catch {
    // no / invalid stdin — fall back to process.cwd()
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  try {
    if (event === "session-start") hookSessionStart(cwd);
    else if (event === "session-end") hookSessionEnd(cwd);
  } catch {
    // swallow — never break the session over a coordination hook
  }
}

function hookSessionStart(cwd: string): void {
  const root = findGitRoot(cwd);
  if (!root) return; // not in a repo — nothing to claim, emit nothing
  const db = openBoard()!;
  const me = agentKey();
  const branch = currentBranch(root);
  // Generous TTL: SessionEnd releases sooner; the TTL is the crash backstop so
  // a killed session frees the dir within a workday.
  const ttl = process.env.BB_SESSION_TTL
    ? parseDuration(process.env.BB_SESSION_TTL)
    : 8 * 60 * 60;
  const existing = ownLiveClaimOn(db, me, root);
  if (existing) refreshClaim(db, existing.id, { branch, message: "active session", ttl });
  else
    post(db, {
      kind: "claim",
      scope: "dir",
      path: root,
      branch,
      message: "active session",
      ttl,
      agent: me,
      display: agentDisplay(),
      pid: agentPid(),
    });

  const newsCount = unread(db, me).length; // peek; the cursor is not advanced
  const lines = [
    `🔒 bulletin-board: claimed ${tilde(root)}${branch ? ` @ ${branch}` : ""} for this session — other agents are warned before they checkout/switch/reset here.`,
  ];
  if (newsCount > 0)
    lines.push(`📋 ${newsCount} board note(s) since you last looked — run \`bb unread\`.`);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    }),
  );
}

function hookSessionEnd(cwd: string): void {
  const db = openBoard({ create: false });
  if (!db) return;
  const root = findGitRoot(cwd) ?? canonicalDir(cwd, cwd);
  release(db, { agent: agentKey(), path: root });
}

function cmdGc(argv: string[]): void {
  const { flags } = parseArgs(argv, { bool: [], value: ["days"], alias: {} });
  const db = openBoard({ create: false });
  if (!db) {
    console.log("Nothing to collect.");
    return;
  }
  const days = flags.days ? parseInt(String(flags.days), 10) : 7;
  const n = gc(db, days);
  console.log(`Purged ${n} row(s) older than ${days}d.`);
}

function cmdWhoami(): void {
  console.log(`agent key : ${agentKey()}`);
  console.log(`display   : ${agentDisplay()}`);
  console.log(`pid       : ${agentPid() ?? "—"}`);
  console.log(`db        : ${tilde(dbPath())}`);
}

const HELP = `bb — bulletin board for coordinating concurrent agents

USAGE
  bb claim [path]          Claim a directory (default: cwd → git root)
     -b, --branch <name>     Branch (default: current branch)
     -t, --ttl <dur>         TTL, e.g. 30m 2h 1d 1w (default: 2h)
     -m, --message <text>    What you're doing
     --steal                 Release others' overlapping claims first
  bb release [path]        Release your claim(s) here (default: cwd)
     --id <n> | --all
  bb renew [path]          Extend your claim's TTL (default: cwd)
     --id <n> | -t, --ttl <dur>
  bb check [path]          Show bulletins here; exit 3 if a conflict
  bb list                  List live bulletins
     --dir <p> | --global | --mine | --all | --json
  bb unread                Bulletins from other agents since you last looked
     --peek (don't advance cursor) | --quiet | --json
  bb note <text>           Post a note
     -g, --global | -p, --path <dir> | -t, --ttl <dur>
  bb gc [--days N]         Purge old released/expired rows (default 7d)
  bb whoami                Show your agent id + db path
  bb hook <event>          Internal: Claude Code lifecycle hooks
                           session-start (claim repo) | session-end (release)

ENV
  BB_AGENT   override agent identity (set per-agent for non-tmux runners)
  BB_DB      override database path (default ~/.bulletin-board/board.db)`;

// --- dispatch --------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "claim": cmdClaim(rest); break;
    case "release": cmdRelease(rest); break;
    case "renew": cmdRenew(rest); break;
    case "check": cmdCheck(rest); break;
    case "list": case undefined: cmdList(rest); break;
    case "unread": case "inbox": cmdUnread(rest); break;
    case "note": cmdNote(rest); break;
    case "hook": await cmdHook(rest); break;
    case "gc": cmdGc(rest); break;
    case "whoami": cmdWhoami(); break;
    case "help": case "-h": case "--help": console.log(HELP); break;
    default: fail(`unknown command "${command}". Try: bb help`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
