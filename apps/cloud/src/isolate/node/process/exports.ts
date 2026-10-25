import { markNodeBuiltinCapability } from "../../NodeBuiltinCapabilities.ts";
import type { NodeProcessHostContext } from "./context.ts";

const eventEmitterMethods = [
  "addListener",
  "emit",
  "eventNames",
  "getMaxListeners",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "removeAllListeners",
  "removeListener",
  "setMaxListeners",
] as const;

function exposeOwnBoundMethods(target: object, names: readonly string[]): void {
  const boundByMethod = new Map<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();
  for (const name of names) {
    const method: unknown = Reflect.get(target, name);
    if (typeof method !== "function")
      throw new TypeError(`Node process method is unavailable: ${name}`);
    const callable = method as (...args: unknown[]) => unknown;
    let bound = boundByMethod.get(callable);
    if (!bound) {
      bound = (...args: unknown[]) => Reflect.apply(callable, target, args);
      boundByMethod.set(callable, bound);
    }
    // Node's own process methods are plain writable properties. graceful-fs replaces cwd and
    // chdir, and signal-exit replaces emit; a read-only method throws in their strict-mode code.
    Object.defineProperty(target, name, {
      value: bound,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}

function exposeOwnAccessors(target: object, prototype: object, names: readonly string[]): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor) throw new TypeError(`Node process property is unavailable: ${name}`);
    Object.defineProperty(target, name, { ...descriptor, configurable: false, enumerable: true });
  }
}

export function exposeProcessExports(target: object, host: NodeProcessHostContext): void {
  exposeOwnBoundMethods(target, [
    ...eventEmitterMethods,
    "cwd",
    "chdir",
    "nextTick",
    "emitWarning",
    "exit",
    "reallyExit",
    "execve",
    "getBuiltinModule",
    "kill",
    "getuid",
    "getgid",
    "geteuid",
    "getegid",
    "getgroups",
  ]);
  exposeOwnAccessors(target, Object.getPrototypeOf(target), ["exitCode", "state"]);
  for (const name of eventEmitterMethods) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: "supported",
      evidence: "HostProcess binds native events.EventEmitter methods to the logical process",
    });
  }
  for (const name of [
    "cwd",
    "chdir",
    "nextTick",
    "emitWarning",
    "exit",
    "reallyExit",
    "uptime",
    "hrtime",
  ]) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: "supported",
      evidence: `HostProcess.${name} uses the owned filesystem, scheduler and lifecycle`,
    });
  }
  markNodeBuiltinCapability(Reflect.get(target, "getBuiltinModule"), {
    status: "supported",
    evidence:
      "HostProcess.getBuiltinModule resolves the active personality bridge and returns undefined when a builtin is unavailable",
  });
  markNodeBuiltinCapability(Reflect.get(target, "execve"), {
    status: "platform-pruned",
    evidence:
      "KernelProcessTable has no current-image replacement operation; process.execve reports ENOSYS",
  });
  markNodeBuiltinCapability(Reflect.get(Reflect.get(target, "hrtime"), "bigint"), {
    status: "supported",
    evidence: "HostProcess.hrtime.bigint uses the captured monotonic clock",
  });
  for (const name of ["cpuUsage", "resourceUsage"] as const) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: "supported",
      evidence: `HostProcess.${name} uses kernel CPU accounting when available and a modeled fallback otherwise`,
    });
  }
  for (const name of ["memoryUsage", "availableMemory", "constrainedMemory"] as const) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: "supported",
      evidence: `HostProcess.${name} uses modeled values from the shared machine profile`,
    });
  }
  const memoryUsage = Reflect.get(target, "memoryUsage");
  if (typeof memoryUsage === "function") {
    markNodeBuiltinCapability(Reflect.get(memoryUsage, "rss"), {
      status: "supported",
      evidence: "HostProcess.memoryUsage.rss uses the shared modeled machine profile",
    });
  }
  for (const [name, available] of [
    ["kill", host.processes !== undefined],
    ["umask", host.filesystem.posixPolicy !== undefined && host.filesystem.setUmask !== undefined],
  ] as const) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: available ? "supported" : "conditional",
      evidence: `HostProcess.${name} requires its explicit kernel host capability`,
    });
  }
  for (const name of ["getuid", "getgid", "geteuid", "getegid", "getgroups"] as const) {
    markNodeBuiltinCapability(Reflect.get(target, name), {
      status: host.filesystem.posixPolicy === undefined ? "conditional" : "supported",
      evidence: `HostProcess.${name} reads KernelFileSystem.posixPolicy.credentials`,
    });
  }
}
