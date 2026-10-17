import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const TEST = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function readWorkspaces(files) {
  return files
    .filter((file) =>
      /^(?:(?:apps|packages|infra)\/[^/]+|scripts|oxlint-plugin-t3code)\/package\.json$/.test(file),
    )
    .map((file) => ({
      directory: NodePath.posix.dirname(file),
      ...JSON.parse(NodeFS.readFileSync(file, "utf8")),
    }));
}

// Match export keys by Node's specificity order, including explicit private exceptions.
function exportTarget(exports, subpath) {
  if (exports === null || exports === undefined) return undefined;
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (Array.isArray(exports))
    return exports.map((value) => exportTarget(value, subpath)).find(Boolean);
  const keys = Object.keys(exports);
  if (keys.every((key) => !key.startsWith("."))) {
    for (const condition of ["types", "import", "node", "default"]) {
      const target = exportTarget(exports[condition], subpath);
      if (target) return target;
    }
    return undefined;
  }
  if (Object.hasOwn(exports, subpath)) return exportTarget(exports[subpath], ".");
  const patterns = keys
    .filter((key) => key.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const key of patterns) {
    const [prefix, suffix] = key.split("*");
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const target = exportTarget(exports[key], ".");
      return target?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
}

export function workspaceTarget(workspace, specifier) {
  const subpath = specifier === workspace.name ? "." : `.${specifier.slice(workspace.name.length)}`;
  if (
    subpath
      .slice(2)
      .split("/")
      .some((part) => [".", "..", "node_modules"].includes(part)) ||
    /%2e|%2f|%5c|\\/i.test(subpath)
  )
    return undefined;
  const target = exportTarget(workspace.exports, subpath);
  return target?.startsWith("./") && !target.slice(2).split("/").includes("..")
    ? target
    : undefined;
}

export function workspaceViolations(modules, workspaces) {
  const owner = (file) =>
    workspaces.find((workspace) => file.startsWith(`${workspace.directory}/`));
  const violations = [];
  for (const source of modules) {
    const fromWorkspace = owner(source.source);
    for (const dependency of source.dependencies) {
      const specifier = dependency.module;
      const targetWorkspace = workspaces.find(
        (workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`),
      );
      const resolvedWorkspace =
        owner(dependency.resolved) ??
        (specifier.startsWith(".")
          ? owner(
              NodePath.posix.normalize(
                NodePath.posix.join(NodePath.posix.dirname(source.source), specifier),
              ),
            )
          : undefined);
      let rule;
      const client = /^(?:apps\/(?:web|desktop|mobile|cli)|packages\/client-runtime)\/src\//.test(
        source.source,
      );
      if (
        client &&
        !source.source.includes("/adapters/") &&
        (/^(?:cloudflare:|@cloudflare\/|@effect\/sql-sqlite-do|convex(?:\/|$)|@workos-inc\/|@boat-sdk\/)/.test(
          specifier,
        ) ||
          dependency.resolved.startsWith("apps/cloud/"))
      ) {
        rule = "clients-use-contracts";
      } else if (
        specifier.startsWith(".") &&
        resolvedWorkspace &&
        resolvedWorkspace !== fromWorkspace
      ) {
        rule = "workspace-relative-reach-in";
      } else if (targetWorkspace && !workspaceTarget(targetWorkspace, specifier)) {
        rule = "workspace-exports";
      } else if (
        fromWorkspace &&
        TEST.test(source.source) &&
        resolvedWorkspace === fromWorkspace &&
        !TEST.test(dependency.resolved)
      ) {
        const relative = `./${NodePath.posix.relative(fromWorkspace.directory, dependency.resolved)}`;
        const keys =
          typeof fromWorkspace.exports === "object" &&
          Object.keys(fromWorkspace.exports ?? {}).some((key) => key.startsWith("."))
            ? Object.keys(fromWorkspace.exports)
            : ["."];
        const publicFile = keys.some((key) => {
          const target = workspaceTarget(
            fromWorkspace,
            `${fromWorkspace.name}${key === "." ? "" : key.slice(1)}`,
          );
          if (!target) return false;
          const pattern = target
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
          return new RegExp(`^${pattern}$`).test(relative);
        });
        // Apps without exports have their own internal test conventions; cloud has depth rules.
        if (fromWorkspace.exports && !publicFile) rule = "workspace-tests-through-exports";
      }
      if (rule)
        violations.push({ from: source.source, to: dependency.resolved, rule: { name: rule } });
    }
  }
  return violations;
}

// Analyzer-only aliases let a root-only tooling install inspect every workspace.
// Export validation above still checks the original specifier, including denied subpaths.
export function workspaceAliases(workspaces) {
  const aliases = {};
  for (const workspace of workspaces) {
    const exports = workspace.exports;
    if (!exports) continue;
    const keys =
      typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.keys(exports)
        : ["."];
    for (const key of keys) {
      const specifier = `${workspace.name}${key === "." ? "" : key.slice(1)}`;
      const target = workspaceTarget(workspace, specifier);
      if (target)
        aliases[`${specifier}${key.includes("*") ? "" : "$"}`] = NodePath.resolve(
          workspace.directory,
          target,
        );
    }
  }
  return aliases;
}
