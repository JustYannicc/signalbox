import type { KernelCommand } from "../KernelCommandForwarder.ts";
import { invalidParams, object, startParams } from "../CodexExecProtocol.ts";

export interface PreparedProcessLaunch {
  readonly processId: string;
  readonly command: KernelCommand;
  readonly identity: string;
  readonly pipeStdin: boolean;
}

export interface ProcessLaunchEnvironment {
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly platformOs?: string;
}

const MAX_PROCESS_ID_CHARS = 256;
const MAX_ENV_ENTRIES = 2048;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_IDENTITY_BYTES = 512 * 1024;
const MAX_ENV_PATTERNS = 128;
const MAX_ENV_PATTERN_CHARS = 256;
const EXIT_ON_STDIN_CLOSE = "CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE";
const NON_INHERITABLE_ENV = new Set([
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
  "NODE_REPL_AUTH_TOKEN",
  "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
]);
const UNIX_CORE_ENV = new Set([
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "USER",
]);
const WINDOWS_CORE_ENV = new Set([
  "PATH",
  "PATHEXT",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "POWERSHELL",
  "PWSH",
]);

interface EnvironmentPolicy {
  readonly inherit: "all" | "none" | "core";
  readonly ignoreDefaultExcludes: boolean;
  readonly exclude: readonly string[];
  readonly set: Readonly<Record<string, string>>;
  readonly includeOnly: readonly string[];
}

export function prepareProcessLaunch(
  value: unknown,
  environment: ProcessLaunchEnvironment,
): PreparedProcessLaunch {
  const params = startParams(value);
  if (params.processId.length === 0 || params.processId.length > MAX_PROCESS_ID_CHARS) {
    return invalidParams(`processId must contain 1 to ${MAX_PROCESS_ID_CHARS} characters`);
  }
  if (params.tty) return invalidParams("tty process mode is unsupported");
  if (params.sandbox !== undefined)
    return invalidParams("process sandbox requests are unsupported");
  if (params.shellSnapshot !== undefined)
    return invalidParams("shell snapshot requests are unsupported");
  if (params.enforceManagedNetwork || params.managedNetwork !== undefined) {
    return invalidParams("managed network requests are unsupported");
  }
  if (params.networkProxy !== undefined)
    return invalidParams("network proxy requests are unsupported");

  const cwd = fileUriToGuestPath(params.cwd);
  const argv = [params.arg0 ?? params.argv[0]!, ...params.argv.slice(1)];
  if (argv.some((arg) => arg.includes("\0"))) return invalidParams("argv must not contain NUL");

  const policy =
    params.envPolicy === undefined ? undefined : parseEnvironmentPolicy(params.envPolicy);
  const env = makeEnvironment(environment, params.env, policy);
  const command: KernelCommand = Object.freeze({
    executable: params.argv[0]!,
    argv: Object.freeze(argv),
    cwd,
    env: Object.freeze(env),
  });
  const identity = JSON.stringify([
    command.executable,
    params.argv,
    params.arg0 ?? null,
    command.argv,
    cwd,
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
    params.pipeStdin,
  ]);
  if (new TextEncoder().encode(identity).byteLength > MAX_IDENTITY_BYTES) {
    return invalidParams("process launch identity exceeds the limit");
  }

  return { processId: params.processId, command, identity, pipeStdin: params.pipeStdin };
}

export function fileUriToGuestPath(uri: string) {
  if (uri.includes("\\")) return invalidParams("cwd file URI must not contain backslashes");
  if (uri.slice(0, 5).toLowerCase() !== "file:") {
    return invalidParams("cwd must be a valid file URI");
  }
  const remainder = uri.slice(5);
  if (remainder.includes("?") || remainder.includes("#")) {
    return invalidParams("cwd file URI has unsupported authority or suffix fields");
  }
  let rawPath = remainder;
  if (remainder.startsWith("//")) {
    const pathStart = remainder.indexOf("/", 2);
    const authority = pathStart < 0 ? remainder.slice(2) : remainder.slice(2, pathStart);
    if (authority !== "") return invalidParams("cwd file URI must not contain an authority");
    rawPath = pathStart < 0 ? "" : remainder.slice(pathStart);
  }
  if (!rawPath.startsWith("/")) {
    return invalidParams("cwd file URI must contain an absolute path");
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return invalidParams("cwd must be a valid file URI");
  }
  if (parsed.protocol !== "file:") return invalidParams("cwd must be a file URI");
  if (
    parsed.hostname !== "" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    return invalidParams("cwd file URI has unsupported authority or suffix fields");
  }
  if (/%2f|%5c/i.test(parsed.pathname)) {
    return invalidParams("cwd file URI must not encode path separators");
  }

  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return invalidParams("cwd file URI path cannot be represented without loss");
  }
  if (!path.startsWith("/") || path.includes("\0")) {
    return invalidParams("cwd file URI must contain an absolute path without NUL");
  }
  return path;
}

function parseEnvironmentPolicy(value: Record<string, unknown>): EnvironmentPolicy {
  const inherit = value.inherit;
  if (inherit !== "all" && inherit !== "none" && inherit !== "core") {
    return invalidParams("envPolicy.inherit must be all, core, or none");
  }
  if (typeof value.ignoreDefaultExcludes !== "boolean") {
    return invalidParams("envPolicy.ignoreDefaultExcludes must be a boolean");
  }
  return {
    inherit,
    ignoreDefaultExcludes: value.ignoreDefaultExcludes,
    exclude: patterns(value.exclude, "envPolicy.exclude"),
    set: stringMap(value.set, "envPolicy.set"),
    includeOnly: patterns(value.includeOnly, "envPolicy.includeOnly"),
  };
}

function patterns(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string")) {
    return invalidParams(`${field} must be an array of strings`);
  }
  if (
    value.length > MAX_ENV_PATTERNS ||
    value.some((pattern) => pattern.length > MAX_ENV_PATTERN_CHARS)
  ) {
    return invalidParams(`${field} exceeds the pattern limit`);
  }
  return value as string[];
}

function stringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  const entries = Object.entries(object(value));
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    return invalidParams(`${field} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function makeEnvironment(
  options: ProcessLaunchEnvironment,
  explicit: Readonly<Record<string, string>>,
  policy: EnvironmentPolicy | undefined,
) {
  const base = Object.entries(options.baseEnv);
  const explicitEntries = Object.entries(explicit);
  if (base.length > MAX_ENV_ENTRIES || explicitEntries.length > MAX_ENV_ENTRIES) {
    return invalidParams("process environment exceeds the entry limit");
  }
  validateEnvironmentEntries(base, "base environment");
  validateEnvironmentEntries(explicitEntries, "env");

  const env = new Map<string, string>();
  if (policy) {
    const isWindows = options.platformOs?.toLowerCase().startsWith("win");
    if (policy.inherit === "core" && options.platformOs === undefined) {
      return invalidParams("envPolicy inherit:core needs the executor platform");
    }
    const inherited =
      policy.inherit === "none"
        ? []
        : policy.inherit === "all"
          ? base
          : base.filter(([name]) =>
              (isWindows ? WINDOWS_CORE_ENV : UNIX_CORE_ENV).has(name.toUpperCase()),
            );
    for (const [name, entry] of inherited) env.set(name, entry);

    if (!policy.ignoreDefaultExcludes) {
      removeMatching(env, (name) =>
        ["*KEY*", "*SECRET*", "*TOKEN*"].some((pattern) => globMatches(pattern, name)),
      );
    }
    removeMatching(env, (name) => policy.exclude.some((pattern) => globMatches(pattern, name)));
    for (const [name, entry] of Object.entries(policy.set)) {
      if (isWindows)
        removeMatching(env, (existing) => existing.toLowerCase() === name.toLowerCase());
      env.set(name, entry);
    }
    if (policy.includeOnly.length > 0) {
      removeMatching(
        env,
        (name) => !policy.includeOnly.some((pattern) => globMatches(pattern, name)),
      );
    }
    if (isWindows && ![...env.keys()].some((name) => name.toUpperCase() === "PATHEXT")) {
      env.set("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    }
  }

  for (const [name, entry] of explicitEntries) env.set(name, entry);
  removeMatching(
    env,
    (name) =>
      name.toUpperCase() === EXIT_ON_STDIN_CLOSE || NON_INHERITABLE_ENV.has(name.toUpperCase()),
  );
  const result = Object.fromEntries(env);
  validateEnvironmentEntries(Object.entries(result), "process environment");
  const encoder = new TextEncoder();
  const totalBytes = Object.entries(result).reduce(
    (sum, [name, entry]) =>
      sum + encoder.encode(name).byteLength + encoder.encode(entry).byteLength,
    0,
  );
  if (Object.keys(result).length > MAX_ENV_ENTRIES || totalBytes > MAX_ENV_BYTES) {
    return invalidParams("process environment exceeds the size limit");
  }
  return result;
}

function validateEnvironmentEntries(
  entries: readonly (readonly [string, string])[],
  field: string,
) {
  if (
    entries.some(
      ([name, value]) =>
        name.length === 0 || name.includes("=") || name.includes("\0") || value.includes("\0"),
    )
  ) {
    return invalidParams(`${field} contains an invalid variable`);
  }
}

function removeMatching(env: Map<string, string>, shouldRemove: (name: string) => boolean) {
  for (const name of env.keys()) if (shouldRemove(name)) env.delete(name);
}

function globMatches(pattern: string, value: string) {
  const source = pattern.toLowerCase();
  const target = value.toLowerCase();
  let p = 0;
  let t = 0;
  let star = -1;
  let afterStar = -1;
  while (t < target.length) {
    if (p < source.length && (source[p] === "?" || source[p] === target[t])) {
      p++;
      t++;
    } else if (source[p] === "*") {
      star = p++;
      afterStar = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++afterStar;
    } else {
      return false;
    }
  }
  while (source[p] === "*") p++;
  return p === source.length;
}
