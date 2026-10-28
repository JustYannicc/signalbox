import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { invalidParams, object, RpcError, string } from "../CodexExecProtocol.ts";
import { fileUriToGuestPath } from "./ProcessesLaunch.ts";
import { expandSandboxDenyGlob, MAX_DENY_GLOB_MATCHES } from "./FileSystemSandboxGlob.ts";
import { compileSandboxDenyGlobPattern } from "./FileSystemSandboxGlobPattern.ts";
import {
  firstMissingSandboxPath,
  resolveSandboxPath,
  sandboxJoin,
  sandboxStat,
  sandboxGitdir,
  withinSandboxPath,
  writableSandboxSymlink,
} from "./FileSystemSandboxPaths.ts";

type Access = "read" | "write" | "deny";
type Entry = { path: string; access: Access; logical?: string };
type Context = {
  cwd: string;
  roots: readonly string[];
  home: string | undefined;
  temporary: readonly string[];
};
const precedence = { read: 0, write: 1, deny: 2 };
const depth = (path: string) => path.split("/").filter(Boolean).length;
const posixPath = (path: string) => {
  if (/^\/[a-z]:($|\/)/i.test(path))
    return invalidParams("Windows paths are unsupported by the POSIX filesystem");
  return path;
};
const uri = (value: unknown, field: string) => posixPath(fileUriToGuestPath(string(value, field)));
const optionalUri = (value: unknown, field: string) =>
  value == null ? undefined : uri(value, field);
const uris = (value: unknown, field: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalidParams(`${field} must be an array`);
  return value.map((item) => uri(item, field));
};

export function assertFileSystemSandboxAccess(
  files: KernelFileSystem,
  value: unknown,
  path: string,
  operation: "read" | "write",
) {
  if (value == null) return;
  posixPath(path);
  const sandbox = object(value);
  if (
    !["disabled", "restricted-token", "elevated", "mxc"].includes(
      string(sandbox.windowsSandboxLevel, "windowsSandboxLevel"),
    )
  ) {
    return invalidParams("Invalid windowsSandboxLevel");
  }
  if (sandbox.useLegacyLandlock !== undefined && typeof sandbox.useLegacyLandlock !== "boolean")
    return invalidParams("useLegacyLandlock must be a boolean");
  const policyContext = sandbox.policyContext == null ? undefined : object(sandbox.policyContext);
  const legacyCwd = optionalUri(sandbox.cwd, "sandbox.cwd");
  const suppliedCwd = optionalUri(policyContext?.cwd, "policyContext.cwd") ?? legacyCwd;
  const legacyRoots = uris(sandbox.workspaceRoots, "workspaceRoots");
  const context: Context = {
    cwd: suppliedCwd ?? files.cwd,
    roots: policyContext
      ? uris(policyContext.workspaceRoots, "policyContext.workspaceRoots")
      : legacyRoots,
    home: optionalUri(sandbox.userHomeDir, "userHomeDir"),
    temporary:
      sandbox.temporaryDirectories == null
        ? []
        : uris(sandbox.temporaryDirectories, "temporaryDirectories"),
  };
  const permissions = object(sandbox.permissions);
  const type = string(permissions.type, "permissions.type");
  if (type === "disabled") return;
  if (permissions.network !== "restricted" && permissions.network !== "enabled")
    return invalidParams("Invalid permissions.network");
  if (type === "external") return;
  if (type !== "managed") return invalidParams("Invalid permissions.type");
  // The embedded permission profile retains snake_case within a camelCase RPC.
  const policy = object(permissions.file_system);
  if (policy.type === "unrestricted") return;
  if (policy.type !== "restricted" || !Array.isArray(policy.entries))
    return invalidParams("Invalid restricted filesystem permissions");
  if (
    policy.glob_scan_max_depth != null &&
    (!Number.isSafeInteger(policy.glob_scan_max_depth) || Number(policy.glob_scan_max_depth) < 1)
  )
    return invalidParams("Invalid glob_scan_max_depth");
  if (
    suppliedCwd === undefined &&
    policy.entries.some((raw) => {
      const target = object(object(raw).path);
      return (
        (target.type === "special" &&
          ["project_roots", "current_working_directory"].includes(
            string(object(target.value).kind, "kind"),
          )) ||
        (target.type === "glob_pattern" && !string(target.pattern, "pattern").startsWith("/"))
      );
    })
  )
    return invalidParams("file system sandbox context with dynamic permissions requires cwd");
  const entries: Entry[] = [];
  const globMatches = new Set<string>();
  const globMatchers: RegExp[] = [];
  for (const raw of policy.entries) {
    const entry = object(raw);
    const access = parseAccess(entry.access);
    if (entry.missing_path_behavior != null && entry.missing_path_behavior !== "skip")
      return invalidParams("Invalid missing_path_behavior");
    const target = object(entry.path);
    if (target.type === "glob_pattern") {
      const pattern = string(target.pattern, "pattern");
      const materialized = materializeGlob(pattern, context, access);
      if (materialized === undefined) {
        entries.length = 0;
        globMatchers.length = 0;
        break;
      }
      for (const path of materialized.deniedRoots)
        entries.push({ path: resolveSandboxPath(files, path), logical: path, access: "deny" });
      if (access === "deny") {
        for (const pattern of materialized.patterns) {
          for (const path of expandSandboxDenyGlob(
            files,
            pattern,
            policy.glob_scan_max_depth == null ? undefined : Number(policy.glob_scan_max_depth),
          )) {
            if (globMatches.has(path)) continue;
            globMatches.add(path);
            if (globMatches.size > MAX_DENY_GLOB_MATCHES)
              throw new RpcError(-32600, "Filesystem deny globs matched more than 8192 paths");
            entries.push({ path: resolveSandboxPath(files, path), logical: path, access: "deny" });
          }
          globMatchers.push(compileSandboxDenyGlobPattern(pattern).matcher);
        }
      }
      continue;
    }
    const materialized = resolveEntry(target, context, access);
    if (materialized === undefined) {
      entries.length = 0;
      globMatchers.length = 0;
      break;
    }
    for (const rule of materialized) {
      const exists = sandboxStat(files, rule.path) !== undefined;
      if (!exists && (rule.access === "write" || entry.missing_path_behavior === "skip")) continue;
      const resolved = resolveSandboxPath(files, rule.path);
      entries.push({ path: resolved, logical: rule.path, access: rule.access });
      // Linux masks the first absent component of a denied/read-only carveout.
      if (!exists && rule.access !== "write") {
        const missing = firstMissingSandboxPath(files, resolved);
        if (missing) entries.push({ path: missing, access: rule.access });
      }
    }
  }
  // The native helper adds Minimal so its runtime can load under restricted reads.
  if (operation === "read")
    for (const root of [
      "/bin",
      "/sbin",
      "/usr",
      "/etc",
      "/lib",
      "/lib64",
      "/nix/store",
      "/run/current-system/sw",
    ]) {
      if (sandboxStat(files, root))
        entries.push({ path: resolveSandboxPath(files, root), access: "read" });
    }
  // A logical alias can match a deny glob even when expansion cannot walk its symlinked parent.
  if (globMatchers.some((matcher) => matcher.test(path))) deny();
  const resolved = resolveSandboxPath(files, path);
  const readsRestricted =
    entries.some((entry) => entry.access === "deny") ||
    !entries.some((entry) => entry.path === "/" && entry.access !== "deny");
  if (operation === "write" || readsRestricted) {
    addMetadataCarveouts(files, entries, context.cwd);
    assertStableCarveouts(files, entries);
  }
  const access =
    entries
      .filter((entry) => withinSandboxPath(entry.path, resolved))
      .sort(
        (left, right) =>
          depth(right.path) - depth(left.path) ||
          precedence[right.access] - precedence[left.access],
      )[0]?.access ?? "deny";
  if (access === "deny" || (operation === "write" && access !== "write")) deny();
}

function parseAccess(value: unknown): Access {
  if (value === "read" || value === "write" || value === "deny") return value;
  if (value === "none") return "deny";
  return invalidParams("Invalid filesystem access");
}

function materializeGlob(pattern: string, context: Context, access: Access) {
  const prefix = "codex-project-roots://";
  if (pattern.startsWith(prefix)) {
    const subpath = pattern.slice(prefix.length);
    if (subpath.startsWith("~/") && access === "deny") return undefined;
    const invalid =
      subpath.startsWith("/") || subpath.split("/").some((part) => part === "." || part === "..");
    const usable = context.roots.filter((root) => !/[*?[\]{}]/.test(root));
    return {
      patterns: invalid ? [] : usable.map((root) => sandboxJoin(root, subpath)),
      deniedRoots:
        access === "write"
          ? []
          : invalid
            ? [...context.roots]
            : context.roots.filter((root) => !usable.includes(root)),
    };
  }
  const root = pattern.startsWith("~/") ? context.home : context.cwd;
  if (root === undefined)
    throw new RpcError(-32600, "Filesystem deny glob requires an executor home");
  return {
    patterns: [sandboxJoin(root, pattern.startsWith("~/") ? pattern.slice(2) : pattern)],
    deniedRoots: [],
  };
}

function resolveEntry(
  target: Record<string, unknown>,
  context: Context,
  access: Access,
): readonly Entry[] | undefined {
  const rules = (paths: readonly string[]) => paths.map((path) => ({ path, access }));
  if (target.type === "path") return rules([uri(target.path, "entry.path")]);
  if (target.type !== "special") return invalidParams("Invalid filesystem path type");
  const value = object(target.value);
  switch (value.kind) {
    case "root":
      return rules(["/"]);
    case "slash_tmp":
      return rules(["/tmp"]);
    case "tmpdir":
      return rules(context.temporary);
    case "project_roots":
    case "current_working_directory": {
      if (value.subpath == null) return rules(context.roots);
      const subpath = string(value.subpath, "subpath");
      // Legacy home-relative denials invalidate every grant when they cannot be scoped.
      if (subpath.startsWith("~/") && access === "deny") return undefined;
      const invalid =
        subpath.startsWith("/") || subpath.split("/").some((part) => part === "." || part === "..");
      if (invalid)
        return access === "write" ? [] : context.roots.map((path) => ({ path, access: "deny" }));
      return rules(context.roots.map((root) => sandboxJoin(root, subpath)));
    }
    case "unknown":
      string(value.path, "unknown.path");
      return [];
    case "minimal":
      return [];
    default:
      return invalidParams("Invalid filesystem special path");
  }
}

function addMetadataCarveouts(files: KernelFileSystem, entries: Entry[], cwd: string) {
  const writable = entries.filter((entry) => entry.access === "write");
  if (
    entries.some((entry) => entry.path === "/" && entry.access === "write") &&
    !entries.some((entry) => entry.access !== "write")
  )
    return;
  const canonicalCwd = resolveSandboxPath(files, cwd);
  for (const root of writable) {
    for (const name of [".git", ".agents", ".codex", ".aws"]) {
      const path = sandboxJoin(root.path, name);
      const stat = sandboxStat(files, path);
      const protect =
        name === ".git"
          ? stat?.type === "file" || stat?.type === "directory"
          : stat?.type === "directory" || (name === ".codex" && canonicalCwd === root.path);
      if (protect && !entries.some((entry) => entry.path === path)) {
        entries.push({ path: resolveSandboxPath(files, path), logical: path, access: "read" });
        if (name === ".git" && stat?.type === "file") {
          const gitdir = sandboxGitdir(files, path);
          if (gitdir && !entries.some((entry) => entry.path === gitdir))
            entries.push({ path: gitdir, access: "read" });
        }
      }
    }
  }
}

function assertStableCarveouts(files: KernelFileSystem, entries: readonly Entry[]) {
  const writable = entries.filter((entry) => entry.access === "write");
  const roots = writable.map((entry) => entry.path);
  for (const entry of entries) {
    if (entry.access === "write") continue;
    let logical = entry.logical ?? entry.path;
    for (const root of writable) {
      if (
        root.logical &&
        withinSandboxPath(root.logical, logical) &&
        !withinSandboxPath(root.path, logical)
      ) {
        logical = sandboxJoin(root.path, logical.slice(root.logical.length).replace(/^\//, ""));
        break;
      }
    }
    if (writableSandboxSymlink(files, logical, roots))
      throw new RpcError(-32600, "Filesystem sandbox carveout crosses a writable symbolic link");
  }
}

function deny(): never {
  throw new RpcError(-32600, "Permission denied (os error 13)");
}
