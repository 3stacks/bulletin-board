# bulletin-board

A local bulletin board so concurrent agents can **claim working directories and other resources** and **announce intent** before they step on each other — e.g. two Claude Code instances checking out branches in the same repo, or restarting the same docker container.

It's a sidecar for **[toolgate](https://github.com/brycehans/toolgate)**: drop in one policy and a destructive op in something another live agent has claimed will prompt for confirmation instead of silently clobbering their work.

```
$ git switch main      # in a repo another agent is mid-edit on

bulletin-board: ~/Sites/ko-sites is claimed by another agent.
  • grind:%2 (pid 8123) @ feat/caddy-map — claimed 14m ago, expires in 1h46m
    "rebuilding Caddy map"
Don't switch branches here — work in an isolated copy instead:
  bb fork <name>   (clones to ~/Sites/ko-sites-<name>, claimed for you)
Allow this git op anyway? [y/N]
```

The gate doesn't just block — it **routes** you to the right move: rather than fight over a checkout, `bb fork <name>` makes an isolated copy in `Sites/<repo>-<name>` (fresh clone by default; `--worktree` for a linked worktree), claims it for you, and tells you where to `cd`.

The same gate covers **resources** that aren't directories. Claim a docker container (`bb claim -r docker:kohub-api`) and a destructive docker op on it by another agent prompts too:

```
$ docker stop kohub-api      # a container another agent is using

bulletin-board: container docker:kohub-api is claimed by another agent.
  • grind:%2 (pid 8123) — claimed 4m ago, expires in 1h56m
    "running migrations"
Stopping or removing it will disrupt their work.
Coordinate first, or use a separate container.
Allow this docker op anyway? [y/N]
```

A `docker compose down/stop/restart` is gated against the **directory** claim of the project it runs in (which a session already auto-claims), so the common "one agent tears down the stack another is using" race becomes a prompt with no extra bookkeeping.

## Why

Parallel agents sharing a checkout is a race condition. One agent runs `git switch`, `git reset --hard`, or `git clean` and the other's uncommitted work vanishes. A TTL'd, advisory claim board — enforced at the one operation that does the damage — turns that race into a prompt.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link            # puts `bb` on PATH (~/.bun/bin/bb)
```

Wire the gate into your [toolgate](https://github.com/brycehans/toolgate) config (verdict helpers are injected, so this package never imports toolgate):

```ts
// toolgate: github.com/brycehans/toolgate — `bun add github:brycehans/toolgate`
import { definePolicy } from "@brycehanscomb/toolgate";
import { ask, next } from "@brycehanscomb/toolgate/verdicts";
import { makeDirectoryClaimPolicy } from "bulletin-board/toolgate";

export default definePolicy([
  makeDirectoryClaimPolicy({ ask, next }), // FIRST — see ordering note
  ...yourPolicies,
]);
```

> **Ordering matters — put the gate first.** toolgate returns the *first* non-`next` verdict, so the gate must run **before** any "allow non-destructive bash/git" policy, or that policy will greenlight `git switch`/`checkout` (it doesn't consider them destructive) before the gate can ask. toolgate also loads `toolgate.config.local.ts` **before** `toolgate.config.ts`, and inner directories before outer ones. So place the gate at the **top of the earliest-loaded config** on the path from your repos up to `$HOME` — in practice, the first entry of your `toolgate.config.local.ts`. Verify with `toolgate test --why Bash '{"command":"git switch x"}'` (or `'{"command":"docker stop x"}'` against a claimed `docker:x`): the deciding policy should be `Guard claimed directories & resources`, not an allow policy. Set `BB_DEBUG=1` to trace the gate's decision.

### Lifecycle hooks (optional)

Wire the hooks so each Claude Code instance claims its repo automatically and sees the board update itself — no need to remember `bb claim` or `bb unread`:

```jsonc
// ~/.claude/settings.json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "bb hook session-start" }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "bb hook session-end" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bb hook prompt" }] }]
}
```

- **`session-start`** claims the repo at the session's cwd (8h TTL, idempotent — resume/compact refresh rather than duplicate) and injects a one-line confirmation plus any unread count. **`session-end`** releases it; the TTL is the crash backstop. Non-repo dirs are skipped.
- **`prompt`** is the context feed: before each turn it injects any bulletins posted by *other* agents since this agent's last turn, then advances the cursor (each shown once). This is how a mid-session broadcast (`bb note "staging DB migrated" -g`) reaches the other agents without anyone running `bb unread`. Silent when nothing is new.

Identity is shared across all hooks and the gate via `$TMUX_PANE`/`$BB_AGENT`, so a session never prompts on its own claim or sees its own notes.

## Use

```bash
bb claim -m "refactoring auth"   # claim cwd's repo (2h TTL, current branch)
bb check                          # who else is here? (exit 3 = conflict)
bb note "staging DB migrated" -g  # broadcast a context change to all agents
bb unread                         # what changed while I was heads-down
bb fork auth                      # claimed dir? isolated copy in Sites/<repo>-auth
bb release                        # done (or let the TTL expire)
bb list                           # everything live
```

### Resources (not just directories)

Claim anything contended — a docker container, a dev-server port, a deploy slot — with a `-r <type>:<id>` key. Resources conflict on an **exact key match** (not path overlap), and the same lifecycle verbs apply:

```bash
bb claim -r docker:kohub-api -m "running migrations"   # claim a container
bb claim -r port:5173                                   # claim a dev-server port
bb check -r docker:kohub-api                            # exit 3 if a conflict
bb list --resources                                     # only resource claims
bb release -r docker:kohub-api                          # done
```

Omit the type and it defaults to `resource` (`bb claim -r build-lock` → `resource:build-lock`). With the gate wired, destructive docker ops (`stop`/`kill`/`rm`/`restart`, and `compose down`) are checked automatically — claiming is what makes the prompt fire for the *other* agent.

See `bb help` or the [`bb` skill](../../.claude/skills/bb/SKILL.md) for the full command set.

## Design

- **`src/board.ts`** — pure domain core: SQLite (`bun:sqlite`), claims/notes, TTLs, repo-scoped conflict detection (`sameRepoScope`; path-overlap kept for informational queries), per-agent unread cursors. Zero host dependency; usable standalone.
- **`src/cli.ts`** — the `bb` binary.
- **`src/toolgate-policy.ts`** — `makeDirectoryClaimPolicy({ ask, next })`. Verdict constructors are injected; the package stays host-agnostic.

Key decisions:

- **Identity** is `$TMUX_PANE` (`tmux:%2`) by default, overridable via `$BB_AGENT`. Distinct panes = distinct agents. Non-tmux runners must set `BB_AGENT`.
- **TTL is the staleness mechanism.** Claims default to 2h so a crashed or forgotten agent auto-frees the directory. Notes are longer-lived (1d dir, 7d global). All renewable.
- **Conflict = same repository.** A directory claim is scoped to exactly one repo. Both the claim and the op's target resolve to their git toplevel first, then conflict is path *equality* — so "claim the repo" and "operate in a subdir of it" line up, while a repo *nested* under a claimed dir (e.g. `~/ko-work/Sites/*` beneath a claim on `~/ko-work`) keeps its own toplevel and stays independent. Path *containment* is still used for informational queries (`bb check`/`bb list --dir` show what's going on in the whole subtree) and for releasing/renewing your own claims, just never for cross-agent arbitration.
- **Cursors are id-based**, not timestamp-based — monotonic, immune to clock resolution and skew.
- **The gate fails open.** Any error → the op proceeds. A coordination tool must never wedge an agent.
- **Storage is volatile and untracked** (`~/.bulletin-board/board.db`, gitignored) — it's live coordination state, not history to commit.

## Shipped

- **Conflict routing** — the gate sends a blocked agent to `bb fork <name>` (isolated copy in `Sites/<repo>-<name>`) instead of just warning.
- **Auto-claim / auto-release** — `SessionStart` claims the cwd repo, `SessionEnd` releases it (`bb hook`).
- **Context-feed hook** — `UserPromptSubmit` injects other agents' new bulletins into context each turn (`bb hook prompt`), so a mid-session broadcast reaches everyone without a manual `bb unread`.
- **Resource claims + docker gate** — `bb claim -r <type>:<id>` claims things that aren't directories (containers, ports, deploy slots), matched on an exact key. The gate guards destructive docker ops: container-targeting commands (`stop`/`kill`/`rm`/`restart`/`pause`) against `docker:<name>` claims, and `compose down/stop/restart` against the project's directory claim.
- **Repo-scoped claims** — a directory claim is scoped to its own git repo, so claiming a parent (e.g. `~/ko-work`) no longer blocks work in repos nested under it (`~/ko-work/Sites/*` are separate toplevels). Conflict, release, and renew all match by repo identity; `bb check`/`bb list --dir` still *show* ancestor and nested claims as context.

## Roadmap

Natural extensions, roughly by value:

- **Liveness reaping** — detect dead owners (pane/pid gone) and free their claims before the TTL.
- **Wait / queue / handoff** — `bb wait <dir>` blocks until free; release can leave a handoff note for whoever's next, instead of `--steal`.
- **Broaden the gate further** — beyond git and docker: `rm -rf`, force-push, branch deletes, `docker system/volume prune` (sweeps that hit every agent's containers), writes to shared files (`.env`, migrations).
- **Notifications** — ping (Slack / terminal) when your claim is stolen or a conflict occurs.
- **Audit timeline** — `bb log` of who held what when (forensics for "who broke main at 2pm").

## Test

```bash
bun test
```
