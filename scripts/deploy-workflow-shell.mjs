import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const scriptExtension = /\.(?:cjs|mjs|js|[mc]?ts|tsx|sh|py|rb)$/i;
const commandBoundary = String.raw`(?:^|[\n;&|()\x60][ \t]*|\b(?:then|do|else|elif)[ \t]+)`;
const assignments = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&()]+)[ \t]+)*`;
const timeoutPrefix = String.raw`(?:timeout[ \t]+(?:--preserve-status[ \t]+)?[0-9]+(?:\.[0-9]+)?(?:[smhd])?[ \t]+)?`;
const environmentPrefix = String.raw`(?:env[ \t]+)?${assignments}(?:env[ \t]+)?`;
const commandPrefix = String.raw`${commandBoundary}(?:if[ \t]+)?!?[ \t]*${timeoutPrefix}${environmentPrefix}`;
const runnerPrefix = String.raw`(?:(?:npx[ \t]+|vp[ \t]+exec[ \t]+|(?:pnpm|npm|yarn)[ \t]+exec[ \t]+))?`;
const nodeOptions = String.raw`(?:--(?:import|require|loader|conditions|env-file|input-type|experimental-loader)(?:=[^\s;|&()]+|[ \t]+[^\s;|&()]+)|--[A-Za-z][A-Za-z0-9-]*(?:=[^\s;|&()]+)?|-[A-Za-z][A-Za-z0-9-]*(?:=[^\s;|&()]+)?)[ \t]+`;

// Recognized commands are node/tsx/bash/sh/source/./python/ruby and direct relative paths. Wrappers
// are env assignments, numeric timeout durations, npx, and vp/pnpm/npm/yarn exec without extra flags.
// This does not expand variables or eval, or interpret shell functions and runner-specific flags.

export function maskShellComments(source) {
  const characters = source.split("");
  let quote = null;
  let escaped = false;
  let inComment = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (inComment) {
      if (character === "\r" || character === "\n") {
        inComment = false;
      } else {
        characters[index] = " ";
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }

    if (character === "\\") escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /[\s;|&(){}\x60]/.test(characters[index - 1]))) {
      inComment = true;
      characters[index] = " ";
    }
  }

  return characters.join("");
}

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

export function findFileScriptCalls(source) {
  const interpreterPattern = new RegExp(
    `${commandPrefix}${runnerPrefix}(?:node|tsx|bash|sh|source|\\.|python3?|ruby)[ \\t]+(?:${nodeOptions})*(?:"([^"]+)"|'([^']+)'|(?!-)([^\\s;|&()\\x60]+))`,
    "g",
  );
  const calls = [];
  for (const match of source.matchAll(interpreterPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (scriptExtension.test(candidate)) {
      calls.push({ index: match.index, file: unquote(candidate) });
    }
  }

  const nodeLoadOptionPattern = new RegExp(
    `${commandPrefix}${runnerPrefix}node[ \\t]+(?:${nodeOptions})*?--(?:import|require|loader|experimental-loader)(?:=|[ \\t]+)(?:"([^"]+)"|'([^']+)'|([^\\s;|&()\\x60]+))`,
    "g",
  );
  for (const match of source.matchAll(nodeLoadOptionPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (scriptExtension.test(candidate)) {
      calls.push({ index: match.index, file: unquote(candidate) });
    }
  }

  const directPattern = new RegExp(
    `${commandPrefix}(?:"([^"]+)"|'([^']+)'|((?:\\.{1,2}/|/)[^\\s;|&()\\x60]+))`,
    "g",
  );
  for (const match of source.matchAll(directPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (scriptExtension.test(candidate)) {
      calls.push({ index: match.index, file: unquote(candidate) });
    }
  }
  return [...new Map(calls.map((call) => [`${call.index}:${call.file}`, call])).values()];
}

export function findRequiredCalls(source) {
  const packagePattern = new RegExp(
    `${commandPrefix}(?:vp|pnpm|npm|yarn)(?:[ \\t]+[^\\s;|&()]+)*?[ \\t]+run(?:-script)?\\b`,
    "g",
  );
  const localBinaryPattern = new RegExp(
    `${commandPrefix}((?:\\.{1,2}/)*node_modules/\\.bin/[A-Za-z0-9._-]+)`,
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
    ...findFileScriptCalls(source)
      .filter(({ file }) => requiredScripts.has(NodePath.posix.basename(file)))
      .map(({ index, file }) => ({
        index,
        kind: requiredScripts.get(NodePath.posix.basename(file)),
      })),
  ];
}

export function findFileGuards(source, workingDirectory) {
  const pattern =
    /\bif\s+(?:\[\[\s+-f\s+(?<double>"[^"]+"|'[^']+'|[^\s;]+)\s+\]\]|\[\s+-f\s+(?<single>"[^"]+"|'[^']+'|[^\s\]]+)\s+\]|test\s+-f\s+(?<test>"[^"]+"|'[^']+'|[^\s;]+))\s*;?\s*then\b(?<thenBody>[\s\S]*?)(?:\b(?:elif|else)\b[\s\S]*?)?\bfi\b/g;
  return [...source.matchAll(pattern)].map((match) => {
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

export function guardedByMatchingFile(guards, callIndex, file) {
  return guards.some(
    (guard) => guard.file === file && callIndex > guard.start && callIndex < guard.thenEnd,
  );
}
