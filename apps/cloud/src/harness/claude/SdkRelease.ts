import type { SdkSpawnOptions } from "./SdkTypes.ts";
import type { NodeBridge } from "../../isolate/NodeBridge.ts";
import type { NodeHarnessProcessInput } from "../NodeHarnessProcess.ts";
import { CLAUDE_HOST_CONFIG } from "../ClaudeHostConfig.ts";

type SdkLaunchInput = Pick<NodeHarnessProcessInput, "identity" | "bun"> & {
  readonly computer: {
    readonly files: Pick<NodeHarnessProcessInput["computer"]["files"], "chdir">;
  };
};

/** The SDK supplies its ordinary launch request before the unchanged CLI evaluates. */
export function applySdkLaunch(
  bridge: NodeBridge,
  input: SdkLaunchInput,
  request: SdkSpawnOptions,
) {
  if (request.command !== input.identity.execPath)
    throw new Error("The SDK requested a different CLI executable");
  const main = input.bun?.main;
  if (typeof main !== "string" || main.length === 0)
    throw new Error("The CLI requires an explicit script identity in bun.main");
  const process = bridge.require("process");
  const argv: unknown = Reflect.get(process, "argv");
  const env: unknown = Reflect.get(process, "env");
  if (!Array.isArray(argv) || typeof env !== "object" || env === null)
    throw new Error("The installed Node personality has no process context");
  argv.splice(0, argv.length, request.command, main, ...request.args);
  for (const key of Object.keys(env)) Reflect.deleteProperty(env, key);
  for (const [key, value] of Object.entries(request.env)) Reflect.set(env, key, value);
  for (const [key, value] of Object.entries(CLAUDE_HOST_CONFIG.env)) {
    if (value === null) Reflect.deleteProperty(env, key);
    else Reflect.set(env, key, value);
  }
  if (request.cwd !== undefined) input.computer.files.chdir(request.cwd);
}

export function abortableValue<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return {
    resolve,
    reject,
    wait(signal: AbortSignal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<A>((done, fail) => {
        const abort = () => fail(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void promise.then(done, fail).finally(() => signal.removeEventListener("abort", abort));
      });
    },
  };
}
