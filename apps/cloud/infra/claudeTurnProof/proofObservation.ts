// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - request-owned guest diagnostics.
import * as NodeStream from "node:stream";
import * as NodeUtil from "node:util";

export function errorDetail(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: Reflect.get(error, "code"),
    ...(error.cause === undefined ? {} : { cause: errorDetail(error.cause) }),
  };
}

export interface GuestObservation {
  stdout: string;
  stderr: string;
  bunMissing: string[];
  builtinMissing: string[];
  errors: Record<string, unknown>[];
  milestones: string[];
  exitCode?: number;
  exitException?: Record<string, unknown>;
}

export function createGuestObservation() {
  const output: GuestObservation = {
    stdout: "",
    stderr: "",
    bunMissing: [],
    builtinMissing: [],
    errors: [],
    milestones: [],
  };
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let finished = false;
  const complete = (milestone: string, error?: unknown) => {
    output.milestones.push(milestone);
    if (error !== undefined) output.errors.push(errorDetail(error));
    if (!finished) {
      finished = true;
      finish();
    }
  };
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const stderr = new NodeStream.PassThrough();
  stdin.end();
  let pendingLine = "";
  stdout.on("data", (chunk) => {
    const text = String(chunk);
    output.stdout += text;
    const lines = (pendingLine + text).split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      try {
        if (JSON.parse(line).type === "result") complete("stdout-result");
      } catch {}
    }
  });
  stderr.on("data", (chunk) => {
    output.stderr += String(chunk);
  });
  const previousConsole = globalThis.console;
  globalThis.console = new Proxy(previousConsole, {
    get(target, key) {
      if (["log", "info", "debug", "warn", "error"].includes(String(key))) {
        return (...args: unknown[]) =>
          (key === "warn" || key === "error" ? stderr : stdout).write(
            `${NodeUtil.format(...args)}\n`,
          );
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const guestError = (milestone: string, error: unknown) => {
    if (error instanceof Error && error.name === "NodeProcessExitError") {
      const code: unknown = Reflect.get(error, "code");
      if (typeof code === "number") output.exitCode = code;
      output.exitException = errorDetail(error);
      complete("typed-process-exit");
    } else complete(milestone, error);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    guestError("unhandled-rejection", event.reason);
  };
  addEventListener("unhandledrejection", onRejection);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  return {
    output,
    done,
    complete,
    guestError,
    streams: { stdin, stdout, stderr },
    startDeadline() {
      deadline = setTimeout(
        () =>
          complete(
            "deadline",
            new Error("CLAUDE_BOOT_DEADLINE: no completion milestone within 20000ms"),
          ),
        20_000,
      );
    },
    restore() {
      if (deadline !== undefined) clearTimeout(deadline);
      removeEventListener("unhandledrejection", onRejection);
      globalThis.console = previousConsole;
    },
  };
}

export async function readAssetBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("ERR_DIAGNOSTIC_ASSET_BODY_MISSING");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("ERR_DIAGNOSTIC_ASSET_BODY_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
