import type { NodeGitRoute } from "./types.ts";
import { parseGitGlobalOptions } from "./global-options.ts";

const NETWORK_COMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

/** Pick the Git implementation before it performs filesystem or transport work. */
export function selectNodeGitRoute(argv: readonly string[]): NodeGitRoute {
  const { command, commandArgs, cwd, unsupportedOption } = parseGitGlobalOptions(argv);
  if (command === undefined || !NETWORK_COMMANDS.has(command)) return { kind: "local" };
  if (unsupportedOption !== undefined) {
    return reject(
      `git ${command} global option is not supported by the HTTP adapter: ${unsupportedOption}`,
    );
  }
  if (command === "pull" || command === "push" || command === "ls-remote") {
    // Push remains refused because it needs streaming request bodies.
    return {
      kind: "reject",
      exitCode: 129,
      message: `git ${command} is not supported by the HTTP adapter`,
    };
  }

  return command === "clone"
    ? selectCloneRoute(commandArgs, cwd)
    : selectFetchRoute(commandArgs, cwd);
}

function selectCloneRoute(args: readonly string[], cwd: readonly string[]): NodeGitRoute {
  let depth: number | undefined;
  let ref: string | undefined;
  let singleBranch: boolean | undefined;
  let noCheckout = false;
  let noTags = false;
  let quiet = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }
    if (arg === "--single-branch") {
      singleBranch = true;
      continue;
    }
    if (arg === "--no-checkout") {
      noCheckout = true;
      continue;
    }
    if (arg === "--no-tags") {
      noTags = true;
      continue;
    }
    const depthValue = optionValue(args, index, "--depth");
    if (depthValue !== undefined) {
      const parsed = positiveInteger(depthValue.value);
      if (parsed === undefined) return reject("git clone requires a positive integer for --depth");
      depth = parsed;
      index = depthValue.index;
      continue;
    }
    const branchValue = optionValue(args, index, "--branch", "-b");
    if (branchValue !== undefined) {
      if (branchValue.value.length === 0) return reject("git clone requires a branch name");
      ref = branchValue.value;
      index = branchValue.index;
      continue;
    }
    if (arg.startsWith("-")) return reject(`git clone option is not supported: ${arg}`);
    positional.push(arg);
  }

  if (positional.length < 1 || positional.length > 2) {
    return reject("usage: git clone [--depth N] [--branch NAME] [--single-branch] URL [DIRECTORY]");
  }
  const url = validateNodeGitHttpUrl(positional[0]!);
  if (typeof url !== "string") return url;
  const dir = positional[1] ?? repositoryDirectory(url);
  if (dir.length === 0) return reject("git clone requires a destination directory");
  return {
    kind: "clone",
    cwd,
    url,
    dir,
    ...(depth === undefined ? {} : { depth }),
    ...(ref === undefined ? {} : { ref }),
    ...(singleBranch === undefined && depth === undefined
      ? {}
      : { singleBranch: singleBranch ?? true }),
    noCheckout,
    noTags,
    quiet,
  };
}

function selectFetchRoute(args: readonly string[], cwd: readonly string[]): NodeGitRoute {
  let depth: number | undefined;
  let tags = false;
  let prune = false;
  let singleBranch = false;
  let quiet = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }
    if (arg === "--tags") {
      tags = true;
      continue;
    }
    if (arg === "--no-tags") {
      tags = false;
      continue;
    }
    if (arg === "--prune") {
      prune = true;
      continue;
    }
    if (arg === "--single-branch") {
      singleBranch = true;
      continue;
    }
    const depthValue = optionValue(args, index, "--depth");
    if (depthValue !== undefined) {
      const parsed = positiveInteger(depthValue.value);
      if (parsed === undefined) return reject("git fetch requires a positive integer for --depth");
      depth = parsed;
      index = depthValue.index;
      continue;
    }
    if (arg.startsWith("-")) return reject(`git fetch option is not supported: ${arg}`);
    positional.push(arg);
  }

  if (positional.length > 1) {
    return reject("git fetch refspecs are not supported by the HTTP adapter");
  }
  const remote = positional[0];
  if (remote === undefined) {
    return {
      kind: "fetch",
      cwd,
      ...(depth === undefined ? {} : { depth }),
      tags,
      prune,
      singleBranch,
      quiet,
    };
  }
  if (remote.includes("://")) {
    const url = validateNodeGitHttpUrl(remote);
    if (typeof url !== "string") return url;
    return {
      kind: "fetch",
      cwd,
      url,
      ...(depth === undefined ? {} : { depth }),
      tags,
      prune,
      singleBranch,
      quiet,
    };
  }
  return {
    kind: "fetch",
    cwd,
    remote,
    ...(depth === undefined ? {} : { depth }),
    tags,
    prune,
    singleBranch,
    quiet,
  };
}

function optionValue(
  args: readonly string[],
  index: number,
  ...names: readonly string[]
): { readonly value: string; readonly index: number } | undefined {
  const arg = args[index]!;
  for (const name of names) {
    if (arg === name) {
      const value = args[index + 1];
      return value === undefined ? { value: "", index: index + 1 } : { value, index: index + 1 };
    }
    if (name.startsWith("--") && arg.startsWith(`${name}=`)) {
      return { value: arg.slice(name.length + 1), index };
    }
  }
  return undefined;
}

function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

type NodeGitRejectRoute = Extract<NodeGitRoute, { readonly kind: "reject" }>;

export function validateNodeGitHttpUrl(value: string): string | NodeGitRejectRoute {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return reject("only HTTP and HTTPS Git remotes are supported");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      return reject(
        "supply Git credentials through the caller's auth callback, not the remote URL",
      );
    }
    return value;
  } catch {
    return reject("Git HTTP remotes must be absolute HTTP or HTTPS URLs");
  }
}

function repositoryDirectory(url: string): string {
  const path = new URL(url).pathname.split("/").findLast(Boolean) ?? "";
  return path.endsWith(".git") ? path.slice(0, -4) : path;
}

function reject(message: string): NodeGitRejectRoute {
  return { kind: "reject", exitCode: 129, message };
}
