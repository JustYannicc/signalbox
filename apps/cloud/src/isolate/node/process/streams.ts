import { markNodeBuiltinCapability } from "../../NodeBuiltinCapabilities.ts";
import type { NodeProcessStreams } from "./context.ts";

export type NodeProcessStdin = NodeProcessStreams["stdin"] & {
  readonly isTTY: boolean;
  ref(): NodeProcessStdin;
  unref(): NodeProcessStdin;
};

export interface NodeProcessRuntimeStreams extends Omit<NodeProcessStreams, "stdin"> {
  readonly stdin: NodeProcessStdin;
}

type Callable = (...args: unknown[]) => unknown;
type MethodPlan = {
  readonly stream: object;
  readonly name: string;
  readonly callable: Callable;
};

const installedMethods = new WeakMap<object, Set<string>>();

const streamMethods = [
  {
    stream: "stdin",
    names: ["off", "on", "read", "removeListener", "setEncoding", "ref", "unref"],
  },
  { stream: "stdout", names: ["end", "on", "once", "removeListener", "write"] },
  { stream: "stderr", names: ["on", "write"] },
] as const;

function makeMethodPlan(stream: object, streamName: string, name: string): MethodPlan {
  const method: unknown = Reflect.get(stream, name);
  if (typeof method !== "function" && name !== "ref" && name !== "unref") {
    throw new TypeError(`Node process ${streamName} is missing stream method ${name}`);
  }
  const callable: Callable =
    typeof method === "function" ? (...args) => Reflect.apply(method, stream, args) : () => stream;
  const evidence =
    name === "ref" || name === "unref"
      ? `HostProcess.stdin.${name} delegates to a native handle when present and is a no-op on the kernel pipe`
      : `HostProcess.${streamName}.${name} delegates to its per-process Node stream`;
  return {
    stream,
    name,
    callable: markNodeBuiltinCapability(callable, { status: "supported", evidence }),
  };
}

/** Own per-process callables so capability records never annotate shared Node prototypes. */
export function exposeNodeProcessStreams(streams: NodeProcessStreams): NodeProcessRuntimeStreams {
  const plans: MethodPlan[] = [];
  for (const { stream: streamName, names } of streamMethods) {
    const stream = streams[streamName];
    const installed = installedMethods.get(stream) ?? new Set<string>();
    for (const name of names) {
      if (installed.has(name)) continue;
      plans.push(makeMethodPlan(stream, streamName, name));
    }
  }

  for (const plan of plans) {
    Object.defineProperty(plan.stream, plan.name, {
      value: plan.callable,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    const installed = installedMethods.get(plan.stream) ?? new Set<string>();
    installed.add(plan.name);
    installedMethods.set(plan.stream, installed);
  }

  const stdinIsTTY = Reflect.get(streams.stdin, "isTTY");
  if (stdinIsTTY !== true && stdinIsTTY !== false) {
    Object.defineProperty(streams.stdin, "isTTY", {
      value: false,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  if (
    Reflect.get(streams.stdin, "isTTY") === false &&
    typeof Reflect.get(streams.stdin, "setRawMode") === "function"
  ) {
    throw new TypeError("A non-TTY process stdin cannot expose setRawMode");
  }

  return streams as NodeProcessRuntimeStreams;
}
