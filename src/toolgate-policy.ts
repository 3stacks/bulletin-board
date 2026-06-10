/**
 * bulletin-board — toolgate sidecar policy.
 *
 * A drop-in policy that gates destructive git operations against the board: if
 * an agent tries to checkout/switch/reset/etc. in a directory another *live*
 * agent has claimed, the host is asked to confirm before proceeding.
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
  fmtAgo,
  fmtExpiry,
  findConflicts,
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

export function makeDirectoryClaimPolicy(
  deps: VerdictDeps,
  options: PolicyOptions = {},
) {
  const destructive = options.destructiveSubcommands ?? DEFAULT_DESTRUCTIVE;

  return {
    name: "Guard claimed directories",
    description:
      "Asks before a destructive git op (checkout/switch/reset/etc.) in a directory another live agent has claimed on the bulletin board. Fails open: never blocks on its own error.",
    handler: async (call: ToolCallish) => {
      try {
        if (call.tool !== "Bash") return deps.next();
        const command =
          typeof call.args?.command === "string" ? call.args.command : "";
        if (!command) return deps.next();

        const op = parseGitOp(command, destructive);
        if (!op) return deps.next();

        const cwd = call.context?.cwd || process.cwd();
        const target = canonicalDir(op.dir, cwd);

        const db = openBoard({ create: false });
        if (!db) return deps.next(); // no board yet → nothing claimed

        const conflicts = findConflicts(db, target, agentKey());
        db.close();
        if (conflicts.length === 0) return deps.next();

        return deps.ask(renderConflict(target, conflicts));
      } catch {
        // Fail open — a coordination tool must never wedge the agent.
        return deps.next();
      }
    },
  };
}

function renderConflict(target: string, conflicts: Bulletin[]): string {
  const short = target.replace(process.env.HOME ?? "~", "~");
  const lines = [`bulletin-board: ${short} is claimed by another agent.`];
  for (const c of conflicts) {
    const at = c.branch ? ` @ ${c.branch}` : "";
    const pid = c.pid ? ` (pid ${c.pid})` : "";
    lines.push(
      `  • ${c.display}${pid}${at} — claimed ${fmtAgo(c.created_at)}, expires ${fmtExpiry(c.expires_at)}`,
    );
    if (c.message) lines.push(`    "${c.message}"`);
  }
  lines.push(`Proceeding may clobber their work. Allow this git op anyway?`);
  return lines.join("\n");
}
