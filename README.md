# bulletin-board

A local bulletin board so concurrent agents can **claim working directories** and **announce intent** before they step on each other — e.g. two Claude Code instances checking out branches in the same repo.

It's a **toolgate sidecar**: drop in one policy and a destructive git op in a directory another live agent has claimed will prompt for confirmation instead of silently clobbering their working tree.

```
$ git switch main      # in a repo another agent is mid-edit on

bulletin-board: ~/Sites/ko-sites is claimed by another agent.
  • grind:%2 (pid 8123) @ feat/caddy-map — claimed 14m ago, expires in 1h46m
    "rebuilding Caddy map"
Proceeding may clobber their work. Allow this git op anyway? [y/N]
```

## Why

Parallel agents sharing a checkout is a race condition. One agent runs `git switch`, `git reset --hard`, or `git clean` and the other's uncommitted work vanishes. A TTL'd, advisory claim board — enforced at the one operation that does the damage — turns that race into a prompt.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link            # puts `bb` on PATH (~/.bun/bin/bb)
```

Wire the gate into your `toolgate.config.ts` (verdict helpers are injected, so this package never imports toolgate):

```ts
import { definePolicy } from "@brycehanscomb/toolgate";
import { ask, next } from "@brycehanscomb/toolgate/verdicts";
import { makeDirectoryClaimPolicy } from "bulletin-board/toolgate";

export default definePolicy([
  ...yourPolicies,
  makeDirectoryClaimPolicy({ ask, next }),
]);
```

## Use

```bash
bb claim -m "refactoring auth"   # claim cwd's repo (2h TTL, current branch)
bb check                          # who else is here? (exit 3 = conflict)
bb note "staging DB migrated" -g  # broadcast a context change to all agents
bb unread                         # what changed while I was heads-down
bb release                        # done (or let the TTL expire)
bb list                           # everything live
```

See `bb help` or the [`bb` skill](../../.claude/skills/bb/SKILL.md) for the full command set.

## Design

- **`src/board.ts`** — pure domain core: SQLite (`bun:sqlite`), claims/notes, TTLs, path-overlap conflict detection, per-agent unread cursors. Zero host dependency; usable standalone.
- **`src/cli.ts`** — the `bb` binary.
- **`src/toolgate-policy.ts`** — `makeDirectoryClaimPolicy({ ask, next })`. Verdict constructors are injected; the package stays host-agnostic.

Key decisions:

- **Identity** is `$TMUX_PANE` (`tmux:%2`) by default, overridable via `$BB_AGENT`. Distinct panes = distinct agents. Non-tmux runners must set `BB_AGENT`.
- **TTL is the staleness mechanism.** Claims default to 2h so a crashed or forgotten agent auto-frees the directory. Notes are longer-lived (1d dir, 7d global). All renewable.
- **Conflict = path overlap.** A claim covers a directory subtree; an op conflicts if its target is at, inside, or contains a claimed dir. Both sides resolve to the git toplevel first, so "claim the repo" and "operate in a subdir" line up.
- **Cursors are id-based**, not timestamp-based — monotonic, immune to clock resolution and skew.
- **The gate fails open.** Any error → the op proceeds. A coordination tool must never wedge an agent.
- **Storage is volatile and untracked** (`~/.bulletin-board/board.db`, gitignored) — it's live coordination state, not history to commit.

## Roadmap

Natural extensions, roughly by value:

- **Context-feed hook** — a `SessionStart` / `UserPromptSubmit` hook that runs `bb unread --quiet` and injects new bulletins into an agent's context, so a mid-session change ("I just migrated the shared DB") *reaches* other agents instead of waiting to be pulled.
- **Auto-claim / auto-release** — `SessionStart` claims the cwd repo; `Stop` releases. Removes the "agents forget to claim" failure mode.
- **Liveness reaping** — detect dead owners (pane/pid gone) and free their claims before the TTL.
- **Generalize claims to resources** — not just directories: a dev-server port, a deploy slot, a shared DB, a rate-limited credential. `bb claim --resource :3000`.
- **Wait / queue / handoff** — `bb wait <dir>` blocks until free; release can leave a handoff note for whoever's next, instead of `--steal`.
- **Broaden the gate** — beyond git: `rm -rf`, force-push, branch deletes, writes to shared files (`.env`, migrations).
- **Notifications** — ping (Slack / terminal) when your claim is stolen or a conflict occurs.
- **Audit timeline** — `bb log` of who held what when (forensics for "who broke main at 2pm").

## Test

```bash
bun test
```
