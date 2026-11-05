import { createNodeReadline } from "../../isolate/NodeReadline.ts";
import { createNodeTty } from "../../isolate/NodeTty.ts";
import { createProcessWarnings } from "../../isolate/node/process/warnings.ts";
import { claudeSdkModelTransport } from "../ClaudeSdkIo.ts";
// @effect-diagnostics nodeBuiltinImport:off - The SDK host installs its own Node identity over Workers' native modules.
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import { installNodePersonality } from "../../isolate/NodeBootstrap.ts";
import { createNodeModule } from "../../isolate/NodeModule.ts";
import { createNodeOs } from "../../isolate/NodeOs.ts";
import { createNodeRuntimeCompatibility } from "../../isolate/NodeRuntimeCompatibility.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../NodeNativeModules.ts";
import { createHarnessModelTransport } from "../node/modelTransport.ts";
import type { ClaudeCliProcessPort, ClaudeSdkProcessContext } from "../ClaudeSdkHostProtocol.ts";
import { createClaudeSdkFiles } from "./files.ts";
import { reserveHarnessRealm } from "../node/personality.ts";
import {
  RELEASE_MODULE_OMITTED_SYMBOL,
  makeReleaseModuleOmittedFailure,
} from "../HarnessProcessLifetime.ts";
import type {
  ReleaseModuleOmittedEvent,
  ReleaseModuleOmittedFailure,
} from "../HarnessProcessLifetime.ts";

/** SDK-only compatibility state belongs to the host's separately loaded Worker. */
export function installClaudeSdkHostEnvironment(
  context: ClaudeSdkProcessContext,
  port: Pick<ClaudeCliProcessPort, "fs" | "model" | "cancelIo" | "report">,
) {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const lifetime = new AbortController();
  const transport = createHarnessModelTransport(claudeSdkModelTransport(port), lifetime.signal);
  const files = createClaudeSdkFiles(port);
  let omitted: ReleaseModuleOmittedFailure | undefined;
  const reports = new Set<Promise<void>>();
  const reportErrors: unknown[] = [];
  const reportOmission = (event: ReleaseModuleOmittedEvent) => {
    const failure = makeReleaseModuleOmittedFailure(event);
    omitted ??= failure;
    const pending = port
      .report({ type: "omission", event, failure })
      .catch((cause: unknown) => {
        reportErrors.push(cause);
      })
      .finally(() => reports.delete(pending));
    reports.add(pending);
  };
  const drainReports = async () => {
    while (reports.size > 0) await Promise.all(reports);
    if (reportErrors.length > 0)
      throw new AggregateError(reportErrors, "SDK release reports failed");
    if (omitted !== undefined) throw omitted;
  };
  const env = { ...context.environment };
  let bridge: NodeBridge;
  const unsupported = (name: string): never => {
    throw Object.assign(
      new Error(`The SDK host cannot execute ${name}; the CLI process capability owns execution`),
      { code: "ENOTSUP" },
    );
  };
  const process = Object.assign(new NodeEvents.EventEmitter(), {
    ...context.identity,
    env,
    argv: [...context.identity.argv],
    execArgv: [...(context.identity.execArgv ?? [])],
    versions: { ...context.identity.versions },
    cwd: () => context.cwd,
    chdir: () => unsupported("process.chdir"),
    nextTick: NodeProcess.nextTick,
    hrtime: NodeProcess.hrtime,
    uptime: NodeProcess.uptime,
    memoryUsage: NodeProcess.memoryUsage,
    stdout: NodeProcess.stdout,
    stderr: NodeProcess.stderr,
    stdin: NodeProcess.stdin,
    getuid: () => context.identity.user?.uid,
    getgid: () => context.identity.user?.gid,
    getBuiltinModule: (name: string) => {
      try {
        return bridge.require(name);
      } catch {
        return undefined;
      }
    },
    exit: (code = 0) => {
      throw Object.assign(new Error(`Claude SDK host exited with ${code}`), { code });
    },
  });
  Object.assign(process, { emitWarning: createProcessWarnings(process) });
  const posix = Object.assign({}, NodePath.posix, {
    resolve: (...paths: string[]) => NodePath.posix.resolve(context.cwd, ...paths),
    relative: (from: string, to: string) =>
      NodePath.posix.relative(
        NodePath.posix.resolve(context.cwd, from),
        NodePath.posix.resolve(context.cwd, to),
      ),
  });
  const path = Object.assign(posix, { posix, win32: NodePath.win32 });
  const compatibility = createNodeRuntimeCompatibility(DEFAULT_NODE_NATIVE_MODULES.worker_threads!);
  const readline = createNodeReadline();
  const modules = {
    ...DEFAULT_NODE_NATIVE_MODULES,
    process,
    readline,
    tty: createNodeTty(),
    fs: files.fs,
    "fs/promises": files.promises,
    path,
    "path/posix": posix,
    "path/win32": NodePath.win32,
    os: createNodeOs({ env, identity: context.identity }),
    child_process: Object.fromEntries(
      ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [
        name,
        () => unsupported(`child_process.${name}`),
      ]),
    ),
    module: createNodeModule({ require: (name) => bridge.require(name) }),
    worker_threads: compatibility.module,
  };
  const realm = reserveHarnessRealm();
  const installed = (() => {
    try {
      return installNodePersonality({ modules, globals: { process } });
    } catch (cause) {
      realm.release();
      throw cause;
    }
  })();
  bridge = installed.bridge;
  const previousReporter = Object.getOwnPropertyDescriptor(
    globalThis,
    RELEASE_MODULE_OMITTED_SYMBOL,
  );
  try {
    Object.defineProperty(globalThis, "fetch", {
      value: transport.fetch,
      configurable: true,
      writable: false,
      enumerable: previousFetch?.enumerable ?? true,
    });
    Object.defineProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL, {
      value: reportOmission,
      configurable: true,
      writable: false,
    });
    realm.commit();
  } catch (cause) {
    installed.restore();
    realm.release();
    if (previousFetch) Object.defineProperty(globalThis, "fetch", previousFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (previousReporter)
      Object.defineProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL, previousReporter);
    else Reflect.deleteProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL);
    throw cause;
  }
  let disposed = false;
  return {
    bridge,
    files,
    async assertCompatibility() {
      await compatibility.assert();
      await drainReports();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort(new Error("Claude SDK environment closed"));
      try {
        const settled = await Promise.allSettled([transport.drain(), drainReports()]);
        const failures = settled.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, "Claude SDK environment cleanup failed");
      } finally {
        installed.restore();
        realm.release();
        if (previousFetch) Object.defineProperty(globalThis, "fetch", previousFetch);
        else Reflect.deleteProperty(globalThis, "fetch");
      }
    },
  };
}
