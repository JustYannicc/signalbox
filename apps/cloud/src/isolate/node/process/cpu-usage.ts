import { unsupportedNodeOperation } from "./NodeError.ts";

interface CpuUsage {
  readonly user: number;
  readonly system: number;
}

export function createCpuUsage(
  snapshot: () => { readonly userNs: bigint; readonly systemNs: bigint } | undefined,
) {
  return (previous?: CpuUsage | null): CpuUsage => {
    const prior = readPrevious(previous);
    const counters = snapshot();
    if (counters === undefined) return unsupportedNodeOperation("process.cpuUsage");
    const user = Number(counters.userNs / 1_000n);
    const system = Number(counters.systemNs / 1_000n);
    return {
      user: user - (prior?.user ?? 0),
      system: system - (prior?.system ?? 0),
    };
  };
}

function readPrevious(previous: unknown): CpuUsage | undefined {
  if (!previous) return undefined;
  if (typeof previous !== "object" && typeof previous !== "function") {
    throw Object.assign(new TypeError('The "previous" argument must be an object'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  const read = (name: "user" | "system") => {
    const value: unknown = Reflect.get(previous, name);
    if (typeof value !== "number") {
      throw Object.assign(new TypeError(`The "previous.${name}" property must be a number`), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new RangeError(`The "previous.${name}" property must be non-negative`), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    return value;
  };
  return { user: read("user"), system: read("system") };
}
