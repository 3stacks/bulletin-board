/**
 * bulletin-board — toolgate sidecar policy.
 *
 * A drop-in policy that gates destructive operations against the board:
 *   - a destructive git op (checkout/switch/reset/etc.) in a directory another
 *     *live* agent has claimed, and
 *   - a destructive docker op (stop/kill/rm/restart, or `compose down`) on a
 *     container or project another live agent has claimed,
 * prompt the host to confirm before proceeding.
 *
 * Verdict constructors are INJECTED so this package never imports toolgate (or
 * any specific host). Wire it in your toolgate.config.ts:
 *
 *   import { ask, next } from "./Sites/toolgate/src/verdicts";
 *   import { makeDirectoryClaimPolicy } from "./Sites/bulletin-board/src/toolgate-policy";
 *
 *   export default definePolicy([
 *     ...yourPolicies,
 *     makeDirectoryClaimPolicy({ ask, next }),
 *   ]);
 */

import {
  agentKey,
  canonicalDir,
  canonicalResource,
  fmtAgo,
  fmtExpiry,
  findConflicts,
  findResourceConflicts,
  openBoard,
  type Bulletin,
} from "./board";

/** Minimal structural shape of a toolgate ToolCall — avoids importing the host. */
interface ToolCallish {
  tool: string;
  args: Record<string, any>;
  context?: { cwd?: string };
}

interface VerdictDeps {
  ask: (reason?: string) => any;
  next: () => any;
}

export interface PolicyOptions {
  /** Which git subcommands count as destructive (mutate HEAD / index / tree). */
  destructiveSubcommands?: string[];
  /** Which `docker <verb> <container>` subcommands disrupt a running container. */
  dockerContainerSubcommands?: string[];
  /** Which `docker compose <verb>` subcommands tear down / disrupt a project. */
  dockerComposeSubcommands?: string[];
}

const DEFAULT_DESTRUCTIVE = [
  "checkout",
  "switch",
  "reset",
  "restore",
  "clean",
  "rebase",
  "merge",
  "cherry-pick",
  "revert",
  "stash",
  "pull",
  "am",
  "apply",
];

// `docker <verb> <names…>` ops that stop/destroy a container another agent uses.
// `up`/`start` are deliberately excluded — they begin work rather than clobber it.
const DEFAULT_DOCKER_CONTAINER = [
  "stop",
  "kill",
  "rm",
  "restart",
  "pause",
  "unpause",
];

// `docker compose <verb>` ops that tear down / disrupt a whole project.
const DEFAULT_DOCKER_COMPOSE = ["down", "stop", "restart", "kill", "rm"];

// Flags that consume the following token, so its value isn't mistaken for a
// container name or subcommand. Best-effort — a miss only costs a skipped prompt.
const CONTAINER_VALUE_FLAGS = new Set(["-t", "--time", "-s", "--signal"]);
const COMPOSE_VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--profile",
  "--env-file",
  "-c",
  "--context",
  "-H",
  "--host",
  "--progress",
  "--ansi",
]);

/**
 * Inspect a Bash command for a destructive git op and the directory it targets.
 * Returns null when the command is not a gated git op.
 *
 * Handles the common shapes: `git <sub>`, `git -C <dir> <sub>`, and a leading
 * `cd <dir> && git <sub>` / `pushd <dir>; git <sub>`. Anything fancier falls
 * back to the call's cwd — worst case is a missed prompt (the bb CLI is still
 * available for an explicit check), never a wrong block.
 */
export function parseGitOp(
  command: string,
  destructive: string[],
): { dir?: string } | null {
  if (!/\bgit\b/.test(command)) return null;
  const subPattern = new RegExp(
    `\\bgit\\b[^|;&]*?\\b(${destructive.join("|")})\\b`,
  );
  if (!subPattern.test(command)) return null;

  // git -C <dir>
  const dashC = /\bgit\b[^|;&]*?-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command);
  if (dashC) return { dir: unquote(dashC[1]) };

  // leading `cd <dir> &&` / `pushd <dir>;`
  const cd = /^\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(command);
  if (cd) return { dir: unquote(cd[1]) };

  return {}; // target = caller's cwd
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** A gated docker command: container-targeting, or a compose project teardown. */
export interface DockerOp {
  kind: "container" | "compose";
  /** Container names (kind === "container"). */
  names?: string[];
  /** Compose project directory, if a leading `cd`/`--project-directory` gave one. */
  dir?: string;
}

/** Split on whitespace, honoring simple single/double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Positional args among `tokens`, skipping flags (and value-flag values). */
function positionalArgs(tokens: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (t.includes("=")) continue; // --flag=value is self-contained
      if (valueFlags.has(t)) i++; // skip the flag's value token
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Inspect a Bash command for a destructive docker op and what it targets.
 * Returns null when the command isn't a gated docker op.
 *
 * Two shapes are recognised (mirroring parseGitOp's best-effort approach — it
 * handles the first command in a chain plus a leading `cd <dir> &&`):
 *   - `docker [container] <stop|kill|rm|restart|pause|unpause> <names…>`
 *       → { kind: "container", names } — checked against `docker:<name>` claims.
 *   - `docker compose <down|stop|restart|kill|rm>` / `docker-compose …`
 *       → { kind: "compose", dir? } — compose acts on the whole project rooted
 *         at a directory, so this is checked against *directory* claims (which a
 *         session already auto-claims), not a resource key.
 */
export function parseDockerOp(
  command: string,
  containerSubs: string[],
  composeSubs: string[],
): DockerOp | null {
  if (!/\bdocker\b/.test(command)) return null;

  // Honor a leading `cd <dir> &&` / `pushd <dir>;` for the compose project dir.
  let dir: string | undefined;
  const cd = /^\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(command);
  if (cd) dir = unquote(cd[1]);

  // `docker compose <sub>` / `docker-compose <sub>` — project teardown.
  const composeM = /\bdocker(?:-compose|\s+compose)\b([^|;&]*)/.exec(command);
  if (composeM) {
    const tail = composeM[1] ?? "";
    const sub = positionalArgs(tokenize(tail), COMPOSE_VALUE_FLAGS)[0];
    if (!sub || !composeSubs.includes(sub)) return null;
    const pd = /--project-directory(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(tail);
    if (pd) dir = unquote(pd[1]);
    return dir ? { kind: "compose", dir } : { kind: "compose" };
  }

  // `docker [container] <verb> <names…>` — container-targeting.
  const contM = new RegExp(
    `\\bdocker\\s+(?:container\\s+)?(${containerSubs.join("|")})\\b([^|;&]*)`,
  ).exec(command);
  if (contM) {
    const names = positionalArgs(tokenize(contM[2] ?? ""), CONTAINER_VALUE_FLAGS);
    if (names.length) return { kind: "container", names };
  }
  return null;
}

export function makeDirectoryClaimPolicy(
  deps: VerdictDeps,
  options: PolicyOptions = {},
) {
  const destructive = options.destructiveSubcommands ?? DEFAULT_DESTRUCTIVE;
  const dockerContainer =
    options.dockerContainerSubcommands ?? DEFAULT_DOCKER_CONTAINER;
  const dockerCompose =
    options.dockerComposeSubcommands ?? DEFAULT_DOCKER_COMPOSE;

  return {
    name: "Guard claimed directories & resources",
    description:
      "Asks before a destructive git op (checkout/switch/reset/etc.) in a claimed directory, or a destructive docker op (stop/kill/rm/restart, compose down) on a container/project another live agent has claimed. Fails open: never blocks on its own error.",
    handler: async (call: ToolCallish) => {
      try {
        if (call.tool !== "Bash") return deps.next();
        const command =
          typeof call.args?.command === "string" ? call.args.command : "";
        if (!command) return deps.next();

        const cwd = call.context?.cwd || process.cwd();
        const me = agentKey();

        // 1) git → directory gate
        const op = parseGitOp(command, destructive);
        if (process.env.BB_DEBUG)
          console.error(`[bb gate] tool=${call.tool} cmd=${JSON.stringify(command)} git=${JSON.stringify(op)}`);
        if (op) {
          // Resolve to the op's OWN git toplevel, so findConflicts matches by
          // repository: a git op in a nested repo (e.g. ~/ko-work/Sites/*) is
          // gated by a claim on that repo, not by a claim on an ancestor dir.
          const target = canonicalDir(op.dir, cwd);
          const db = openBoard({ create: false });
          if (!db) return deps.next(); // no board yet → nothing claimed
          const conflicts = findConflicts(db, target, me);
          db.close();
          if (process.env.BB_DEBUG)
            console.error(`[bb gate] target=${target} self=${me} conflicts=${conflicts.length}`);
          return conflicts.length
            ? deps.ask(renderConflict(target, conflicts))
            : deps.next();
        }

        // 2) docker → resource (container) / directory (compose project) gate
        const dop = parseDockerOp(command, dockerContainer, dockerCompose);
        if (process.env.BB_DEBUG)
          console.error(`[bb gate] docker=${JSON.stringify(dop)}`);
        if (dop) {
          const db = openBoard({ create: false });
          if (!db) return deps.next();
          try {
            if (dop.kind === "container") {
              for (const name of dop.names ?? []) {
                const key = canonicalResource(`docker:${name}`);
                const conflicts = findResourceConflicts(db, key, me);
                if (conflicts.length)
                  return deps.ask(renderResourceConflict("container", key, conflicts));
              }
              return deps.next();
            }
            // compose: the project is rooted at a directory — reuse dir claims.
            const target = canonicalDir(dop.dir, cwd);
            const conflicts = findConflicts(db, target, me);
            if (conflicts.length)
              return deps.ask(renderResourceConflict("compose", shortPath(target), conflicts));
            return deps.next();
          } finally {
            db.close();
          }
        }

        return deps.next();
      } catch (err) {
        // Fail open — a coordination tool must never wedge the agent.
        if (process.env.BB_DEBUG) console.error("[bb gate] error:", err);
        return deps.next();
      }
    },
  };
}

/** Going-forward name; the policy now guards resources as well as directories. */
export const makeClaimPolicy = makeDirectoryClaimPolicy;

function shortPath(p: string): string {
  return p.replace(process.env.HOME ?? "~", "~");
}

/** Render a conflict's owner lines (shared by the dir and resource renderers). */
function ownerLines(conflicts: Bulletin[]): string[] {
  const lines: string[] = [];
  for (const c of conflicts) {
    const at = c.branch ? ` @ ${c.branch}` : "";
    const pid = c.pid ? ` (pid ${c.pid})` : "";
    lines.push(
      `  • ${c.display}${pid}${at} — claimed ${fmtAgo(c.created_at)}, expires ${fmtExpiry(c.expires_at)}`,
    );
    if (c.message) lines.push(`    "${c.message}"`);
  }
  return lines;
}

function renderConflict(target: string, conflicts: Bulletin[]): string {
  const short = shortPath(target);
  const lines = [
    `bulletin-board: ${short} is claimed by another agent.`,
    ...ownerLines(conflicts),
    // Route to the right resolution: don't fight over the checkout — work in an
    // isolated copy. `bb fork` clones into Sites/<repo>-<name> and claims it.
    `Don't switch branches here — work in an isolated copy instead:`,
    `  bb fork <name>   (clones to ${short}-<name>, claimed for you)`,
    `Allow this git op anyway?`,
  ];
  return lines.join("\n");
}

/**
 * Render a docker conflict. Forking the repo doesn't help here (a clone still
 * shares the docker daemon, container names and ports), so the guidance differs
 * from the git case: coordinate, or run an isolated stack under a new project.
 */
function renderResourceConflict(
  kind: "container" | "compose",
  label: string,
  conflicts: Bulletin[],
): string {
  const head =
    kind === "compose"
      ? `bulletin-board: the Docker Compose project at ${label} is claimed by another agent.`
      : `bulletin-board: container ${label} is claimed by another agent.`;
  const advice =
    kind === "compose"
      ? [
          `This will stop or remove containers another agent is using.`,
          `Run an isolated stack under a different project name instead:`,
          `  docker compose -p <name> up   (separate containers; mind host ports)`,
          `Allow this docker op anyway?`,
        ]
      : [
          `Stopping or removing it will disrupt their work.`,
          `Coordinate first, or use a separate container.`,
          `Allow this docker op anyway?`,
        ];
  return [head, ...ownerLines(conflicts), ...advice].join("\n");
}
