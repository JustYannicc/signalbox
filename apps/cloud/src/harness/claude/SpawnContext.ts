import type { NodeBridge } from "../../isolate/NodeBridge.ts";

const REDACTED = "[REDACTED]";
const MAX_BYTES = 32_768;
const MAX_VALUE_BYTES = 1_024;
const sensitive =
  /(?:token|secret|password|passwd|credential|authorization|bearer|api[-_]?key|cookie|private[-_]?key|header)/i;
const safeEnv =
  /^(?:HOME|PATH|PWD|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+|TERM|SHELL|USER|LOGNAME|NODE_ENV|ANTHROPIC_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+|MCP_[A-Z0-9_]+|API_TIMEOUT_MS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/;
const encoder = new TextEncoder();
const requiredEnv = new Set([
  "HOME",
  "PATH",
  "LANG",
  "LANGUAGE",
  "ANTHROPIC_MODEL",
  "LC_ALL",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
]);

export interface ClaudeSpawnContext {
  readonly type: "harness.cli-spawn-context";
  readonly cwd: string;
  readonly model?: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly limits: {
    readonly maxBytes: number;
    readonly valueBytes: number;
    readonly argvCount: number;
    readonly envCount: number;
    readonly truncated: boolean;
  };
}

/** Reads the installed personality after SDK mapping; never records seed launch options. */
export function captureClaudeSpawnContext(bridge: NodeBridge): ClaudeSpawnContext {
  const process = bridge.require("process");
  const argv: unknown = Reflect.get(process, "argv");
  const env: unknown = Reflect.get(process, "env");
  const cwd: unknown = Reflect.get(process, "cwd");
  if (!Array.isArray(argv) || typeof env !== "object" || env === null || typeof cwd !== "function")
    throw new Error("CLI spawn context is unavailable");
  const environment = Object.entries(env);
  // Unknown env values stay private, including credentials with nonstandard names.
  const secrets = environment
    .flatMap(([key, value]) =>
      (!safeEnv.test(key) || sensitive.test(key)) && typeof value === "string" && value.length >= 4
        ? [value]
        : [],
    )
    .sort((a, b) => b.length - a.length);
  const scrub = (value: string) => {
    let result = value;
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
    return result
      .replace(/(Bearer\s+)[^\s"']+/gi, `$1${REDACTED}`)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, `$1${REDACTED}@`)
      .replace(/([?&#][^=&#\s]+=)[^&#\s]+/g, `$1${REDACTED}`);
  };
  const structured = (value: unknown, depth = 0): unknown => {
    if (depth > 12) return REDACTED;
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map((entry) => structured(entry, depth + 1));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitive.test(key) ? REDACTED : structured(entry, depth + 1),
      ]),
    );
  };
  let truncated = false;
  const bounded = (value: string) => {
    const size = (text: string) => encoder.encode(JSON.stringify(text)).length;
    const head = value.slice(0, MAX_VALUE_BYTES);
    if (head.length === value.length && size(head) <= MAX_VALUE_BYTES) return value;
    truncated = true;
    let low = 0;
    let high = head.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(head.slice(0, middle)) <= MAX_VALUE_BYTES) low = middle;
      else high = middle - 1;
    }
    return head.slice(0, low);
  };
  let redactNext = false;
  const args = argv.slice(0, 256).map((value: unknown) => {
    if (typeof value !== "string") return REDACTED;
    const wasSensitive = redactNext;
    redactNext = false;
    if (wasSensitive) return REDACTED;
    const equals = value.indexOf("=");
    const flag = equals < 0 ? value : value.slice(0, equals);
    if (value.startsWith("-") && sensitive.test(flag)) {
      if (equals < 0) {
        redactNext = true;
        return bounded(flag);
      }
      return bounded(`${flag}=${REDACTED}`);
    }
    const argument = equals >= 0 && value.startsWith("-") ? value.slice(equals + 1) : value;
    const first = argument.trimStart()[0];
    if (first === "[" || first === "{") {
      if (argument.length > 16_384) {
        truncated = true;
        return REDACTED;
      }
      try {
        const sanitized = JSON.stringify(structured(JSON.parse(argument)));
        return bounded(argument === value ? sanitized : `${flag}=${sanitized}`);
      } catch {
        return REDACTED;
      }
    }
    return bounded(scrub(value));
  });
  // Comparison fields survive both entry-count and serialized-payload limits.
  const selectedEnv = [
    ...environment.filter(([key]) => requiredEnv.has(key)),
    ...environment.filter(([key]) => !requiredEnv.has(key)),
  ];
  const values = Object.fromEntries(
    selectedEnv
      .slice(0, 128)
      .map(([key, value]) => [
        bounded(key),
        safeEnv.test(key) && !sensitive.test(key) && typeof value === "string"
          ? bounded(scrub(value))
          : REDACTED,
      ]),
  );
  let model: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const value: unknown = argv[index];
    if (value === "--model" && typeof argv[index + 1] === "string") model = argv[index + 1];
    else if (typeof value === "string" && value.startsWith("--model=")) model = value.slice(8);
  }
  const directory: unknown = Reflect.apply(cwd, process, []);
  const result = {
    type: "harness.cli-spawn-context" as const,
    cwd: bounded(scrub(typeof directory === "string" ? directory : REDACTED)),
    ...(model === undefined ? {} : { model: bounded(scrub(model)) }),
    argv: args,
    env: values,
    limits: {
      maxBytes: MAX_BYTES,
      valueBytes: MAX_VALUE_BYTES,
      argvCount: argv.length,
      envCount: environment.length,
      truncated: truncated || argv.length > 256 || environment.length > 128,
    },
  };
  // Eighteen required env fields plus cwd/model, each capped to 1 KiB, fit below 32 KiB.
  while (encoder.encode(JSON.stringify(result)).length > MAX_BYTES) {
    result.limits.truncated = true;
    const key = Object.keys(values).findLast((entry) => !requiredEnv.has(entry));
    if (key !== undefined) delete values[key];
    else args.pop();
  }
  return result;
}

export type ClaudeSpawnDiagnostic =
  | ClaudeSpawnContext
  | {
      readonly type: "harness.cli-spawn-context";
      readonly unavailable: true;
    };

/** Capture failure stays visible without letting diagnostics prevent CLI startup. */
export function captureClaudeSpawnDiagnostic(bridge: NodeBridge): ClaudeSpawnDiagnostic {
  try {
    return captureClaudeSpawnContext(bridge);
  } catch {
    return { type: "harness.cli-spawn-context", unavailable: true };
  }
}
