// @effect-diagnostics nodeBuiltinImport:off - Guest path semantics use the same POSIX builtin as Node.
import * as NodePath from "node:path";

export interface CliSyncRoots {
  readonly cwd: string;
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly configDir: string;
}

/** What the policy asks of the view: a path's type through symlinks and, once held, its text. */
export interface CliSyncReadSource {
  type(path: string): string | undefined;
  text(path: string): string | undefined;
  children(path: string): readonly string[];
}

const MANAGED = "/etc/claude-code";

/**
 * The files the official CLI reads synchronously: its configuration and settings at each scope,
 * and the git metadata it reads to find its repository. A synchronous call can't wait for
 * Computer, so the view fetches these ahead of a read and nothing else. Git's own files name the
 * next ones (a gitfile its git directory, HEAD its branch), so callers apply this until it settles.
 */
export function cliSyncReads(roots: CliSyncRoots, view: CliSyncReadSource) {
  const { cwd, home, configDir } = roots;
  const managedSettings = `${MANAGED}/managed-settings.d`;
  return [
    ...new Set(
      [
        // The global config sits in home, or in CLAUDE_CONFIG_DIR when that is set.
        `${home}/.claude.json`,
        `${configDir}/.claude.json`,
        `${configDir}/settings.json`,
        `${configDir}/settings.local.json`,
        `${configDir}/plugins/installed_plugins.json`,
        `${cwd}/.claude/settings.json`,
        `${cwd}/.claude/settings.local.json`,
        `${cwd}/.mcp.json`,
        `${MANAGED}/managed-settings.json`,
        `${MANAGED}/managed-mcp.json`,
        ...view
          .children(managedSettings)
          .filter((name) => name.endsWith(".json"))
          .map((name) => `${managedSettings}/${name}`),
        ...gitMetadata(cwd, view),
      ].map((path) => NodePath.posix.normalize(path)),
    ),
  ];
}

/** Git's own discovery: the nearest `.git` at or above the working directory. */
function gitMetadata(cwd: string, view: CliSyncReadSource): string[] {
  for (let directory = cwd; ; directory = NodePath.posix.dirname(directory)) {
    const marker = NodePath.posix.join(directory, ".git");
    const type = view.type(marker);
    if (type === "directory") return repository(marker, view);
    if (type === "file") {
      const target = /^gitdir: (.+)$/m.exec(view.text(marker) ?? "")?.[1]?.trim();
      return [
        marker,
        ...(target === undefined
          ? []
          : repository(NodePath.posix.resolve(directory, target), view)),
      ];
    }
    if (directory === "/") return [];
  }
}

function repository(gitDirectory: string, view: CliSyncReadSource) {
  // A worktree's own directory holds its HEAD; branches and config live in the common one.
  const commondir = view.text(`${gitDirectory}/commondir`)?.trim();
  const common = commondir ? NodePath.posix.resolve(gitDirectory, commondir) : gitDirectory;
  const branch = /^ref:\s*(refs\/\S+)/.exec(view.text(`${gitDirectory}/HEAD`) ?? "")?.[1];
  return [
    `${gitDirectory}/HEAD`,
    `${gitDirectory}/commondir`,
    `${gitDirectory}/config`,
    `${common}/config`,
    `${common}/packed-refs`,
    ...(branch === undefined ? [] : [`${common}/${branch}`]),
  ];
}
