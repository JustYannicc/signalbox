import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const scriptExtension = /\.(?:cjs|mjs|js|tsx?|sh|py|rb)$/i;
const commandBoundary = String.raw`(?:^|[\n;&|()][ \t]*|\b(?:then|do|else)[ \t]+)`;
const assignments = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&()]+)[ \t]+)*`;

function unquote(value) {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
}

export function repoPath(value, base = ".") {
  if (typeof value !== "string") return null;
  const candidate = unquote(value.trim());
  if (
    candidate === "" ||
    candidate.startsWith("/") ||
    candidate.includes("$") ||
    candidate.includes("\\")
  )
    return null;
  const normalized = NodePath.posix
    .normalize(NodePath.posix.join(base, candidate))
    .replace(/^\.\//, "");
  return normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

export function findFileScriptCalls(run) {
  const source = run.replace(/^\s*#.*$/gm, "");
  const interpreterPattern = new RegExp(
    `${commandBoundary}(?:if[ \\t]+)?!?[ \\t]*${assignments}(?:env[ \\t]+)?(?:node|bash|sh|source|\\.|python3?|ruby)[ \\t]+(?:-[A-Za-z][A-Za-z0-9-]*(?:=[^\\s]+)?[ \\t]+)*(?:"([^"]+)"|'([^']+)'|([^\\s;|&()]+))`,
    "g",
  );
  const calls = [];
  for (const match of source.matchAll(interpreterPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (scriptExtension.test(candidate)) {
      calls.push({ index: match.index, file: unquote(candidate) });
    }
  }

  const directPattern = new RegExp(
    `${commandBoundary}(?:if[ \\t]+)?!?[ \\t]*${assignments}(?:"([^"]+)"|'([^']+)'|((?:\\.{1,2}/|/)[^\\s;|&()]+))`,
    "g",
  );
  for (const match of source.matchAll(directPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (scriptExtension.test(candidate)) {
      calls.push({ index: match.index, file: unquote(candidate) });
    }
  }
  return calls;
}

export function findRequiredCalls(run) {
  const source = run.replace(/^\s*#.*$/gm, "");
  const packagePattern = new RegExp(
    `${commandBoundary}(?:if[ \\t]+)?!?[ \\t]*${assignments}(?:vp|pnpm|npm|yarn)(?:[ \\t]+[^\\s;|&()]+)*?[ \\t]+run(?:-script)?\\b`,
    "g",
  );
  const localBinaryPattern = new RegExp(
    `${commandBoundary}(?:if[ \\t]+)?!?[ \\t]*${assignments}((?:\\.{1,2}/)*node_modules/\\.bin/[A-Za-z0-9._-]+)`,
    "g",
  );
  const requiredScripts = new Map([
    ["plan.sh", "plan validation"],
    ["merge-main.sh", "production source merge"],
    ["cloudflare-preview-domains.cjs", "preview domain verification"],
    ["wait-own-certificate.cjs", "preview certificate check"],
  ]);
  return [
    ...[...source.matchAll(packagePattern)].map((match) => ({
      index: match.index,
      kind: "package script",
    })),
    ...[...source.matchAll(localBinaryPattern)].map((match) => ({
      index: match.index,
      kind: "local binary",
    })),
    ...findFileScriptCalls(run)
      .filter(({ file }) => requiredScripts.has(NodePath.posix.basename(file)))
      .map(({ index, file }) => ({
        index,
        kind: requiredScripts.get(NodePath.posix.basename(file)),
      })),
  ];
}

export function findFileGuards(run, workingDirectory) {
  const pattern =
    /\bif\s+(?:\[\[\s+-f\s+(?<double>"[^"]+"|'[^']+'|[^\s;]+)\s+\]\]|\[\s+-f\s+(?<single>"[^"]+"|'[^']+'|[^\s\]]+)\s+\]|test\s+-f\s+(?<test>"[^"]+"|'[^']+'|[^\s;]+))\s*;?\s*then\b(?<thenBody>[\s\S]*?)(?:\belse\b(?<elseBody>[\s\S]*?))?\bfi\b/g;
  return [...run.matchAll(pattern)].map((match) => {
    const thenBody = match.groups.thenBody;
    const thenStart = match.index + match[0].indexOf(thenBody);
    return {
      file: repoPath(
        match.groups.double ?? match.groups.single ?? match.groups.test,
        workingDirectory,
      ),
      start: match.index,
      thenEnd: thenStart + thenBody.length,
      blockEnd: match.index + match[0].length,
    };
  });
}

function localDependencies(file, source) {
  const dependencies = new Set();
  const modulePattern = /\b(?:from\s*|require\s*\(\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(modulePattern)) {
    dependencies.add(
      NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), match[1])),
    );
  }

  if (file.endsWith(".sh")) {
    const scriptDirectory = source.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)="\$\([^\n]*dirname[^\n]*BASH_SOURCE[^\n]*$/m,
    )?.[1];
    if (scriptDirectory) {
      const reference = new RegExp(
        `\\$\\{?${scriptDirectory}\\}?/([^\\s"'\\x60;|&]+\\.(?:cjs|mjs|js|tsx?|sh|py|rb))`,
        "g",
      );
      for (const match of source.matchAll(reference)) {
        dependencies.add(
          NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), match[1])),
        );
      }
    }
  }
  return [...dependencies];
}

export function dependencyClosure(file, repoRoot) {
  const pending = [file];
  const visited = new Set();
  const failures = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const absolute = NodePath.join(repoRoot, current);
    if (!NodeFS.existsSync(absolute)) {
      failures.push(`trusted script dependency ${current} is missing from the checkout`);
      continue;
    }
    const source = NodeFS.readFileSync(absolute, "utf8");
    pending.push(
      ...localDependencies(current, source).filter((dependency) => !visited.has(dependency)),
    );
  }
  return { files: visited, failures };
}

export function guardedByMatchingFile(run, callIndex, file, workingDirectory) {
  return findFileGuards(run, workingDirectory).some(
    (guard) => guard.file === file && callIndex > guard.start && callIndex < guard.thenEnd,
  );
}
