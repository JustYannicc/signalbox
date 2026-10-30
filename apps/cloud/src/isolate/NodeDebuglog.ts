import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

interface DebuglogProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly stderr: { write(text: string): unknown };
  emitWarning(message: string): unknown;
}

type DebugLogger = ((...args: unknown[]) => void) & { readonly enabled: boolean };

export function createNodeDebuglog(
  format: (...args: unknown[]) => string,
  currentProcess: () => DebuglogProcess,
) {
  const debuglog = (set: string, callback?: (logger: DebugLogger) => void) => {
    const process = currentProcess();
    const pattern = process.env.NODE_DEBUG;
    const expression = pattern
      ?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll(",", "$|^");
    const category = set.toUpperCase();
    const enabled =
      expression !== undefined &&
      expression !== "" &&
      new RegExp(`^${expression}$`, "i").test(category);
    let initialized = false;
    let inspected = false;

    function loggerFor(write: (...args: unknown[]) => void) {
      const logger = Object.assign(write, { enabled });
      Object.defineProperty(logger, "enabled", {
        get() {
          inspected = true;
          return enabled;
        },
      });
      return logger;
    }

    const output = loggerFor((...args: unknown[]) => {
      if (enabled) process.stderr.write(`${category} ${process.pid}: ${format(...args)}\n`);
    });
    return loggerFor((...args: unknown[]) => {
      if (inspected && !enabled) return;
      if (!initialized) {
        initialized = true;
        if (enabled && (category === "HTTP" || category === "HTTP2")) {
          process.emitWarning(
            `Setting NODE_DEBUG=${category.toLowerCase()} can expose sensitive data in logs.`,
          );
        }
        callback?.(output);
      }
      output(...args);
    });
  };
  return markNodeBuiltinCapability(debuglog, {
    status: "supported",
    evidence:
      "debuglog selects NODE_DEBUG categories from the current guest process, formats enabled messages to its stderr and calls the initialization callback lazily.",
  });
}
