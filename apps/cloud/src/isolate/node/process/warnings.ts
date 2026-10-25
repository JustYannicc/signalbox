import { createNodeConsole } from "../../NodeConsole.ts";
import type { NodeProcessHostContext } from "./context.ts";

type WarningConstructor = (...args: never[]) => unknown;
export interface NodeProcessWarningOptions {
  readonly type?: string;
  readonly code?: string;
  readonly ctor?: WarningConstructor;
  readonly detail?: string;
}
interface WarningHost {
  readonly pid: number;
  readonly argv0: string;
  readonly execArgv: readonly string[];
  readonly env: NodeProcessHostContext["env"];
  readonly stderr: NodeProcessHostContext["streams"]["stderr"];
  readonly nextTick: (callback: () => void) => void;
  readonly emit: (event: "warning", warning: Error) => boolean;
  readonly on: (event: "warning", listener: (warning: unknown) => void) => unknown;
}

/** A warning's default listener and deferred event both belong to the logical process. */
export function createProcessWarnings(host: WarningHost) {
  const console = createNodeConsole(host.stderr);
  let hintShown = false;
  host.on("warning", (warning) => {
    if (!(warning instanceof Error)) return;
    if (host.execArgv.includes("--no-warnings") || host.env.NODE_NO_WARNINGS === "1") return;
    const deprecation = warning.name === "DeprecationWarning";
    const trace =
      host.execArgv.includes("--trace-warnings") ||
      (deprecation && host.execArgv.includes("--trace-deprecation"));
    const code: unknown = Reflect.get(warning, "code");
    const detail: unknown = Reflect.get(warning, "detail");
    let message = `(node:${host.pid}) ${code ? `[${String(code)}] ` : ""}${trace && warning.stack ? warning.stack : warning.toString()}`;
    if (typeof detail === "string") message += `\n${detail}`;
    if (!trace && !hintShown) {
      hintShown = true;
      const executable =
        host.argv0
          .split("/")
          .at(-1)
          ?.replace(/\.exe$/, "") || "node";
      const flag = deprecation ? "--trace-deprecation" : "--trace-warnings";
      message += `\n(Use \`${executable} ${flag} ...\` to show where the warning was created)`;
    }
    console.error(message);
  });

  return function emitWarning(
    warning: string | Error,
    typeOrOptions?: string | NodeProcessWarningOptions | WarningConstructor,
    codeOrCtor?: string | WarningConstructor,
    constructor?: WarningConstructor,
  ): void {
    let type: unknown = typeOrOptions;
    let code: unknown = codeOrCtor;
    let ctor: unknown = constructor;
    let detail: string | undefined;
    if (
      typeOrOptions !== null &&
      typeof typeOrOptions === "object" &&
      !Array.isArray(typeOrOptions)
    ) {
      type = typeOrOptions.type || "Warning";
      code = typeOrOptions.code;
      ctor = typeOrOptions.ctor;
      if (typeof typeOrOptions.detail === "string") detail = typeOrOptions.detail;
    } else if (typeof typeOrOptions === "function") {
      type = "Warning";
      code = undefined;
      ctor = typeOrOptions;
    }
    if (type !== undefined && typeof type !== "string")
      throw new TypeError("Warning type must be a string");
    if (typeof code === "function") {
      ctor = code;
      code = undefined;
    } else if (code !== undefined && typeof code !== "string")
      throw new TypeError("Warning code must be a string");
    if (ctor !== undefined && typeof ctor !== "function")
      throw new TypeError("Warning ctor must be a function");
    if (typeof warning === "string") {
      warning = Object.assign(new Error(warning), {
        name: type || "Warning",
        ...(code === undefined ? {} : { code }),
        ...(detail === undefined ? {} : { detail }),
      });
      Error.captureStackTrace(warning, ctor ?? emitWarning);
    } else if (!(warning instanceof Error))
      throw new TypeError("Warning must be a string or Error");
    const emitted = warning;
    host.nextTick(() => host.emit("warning", emitted));
  };
}
