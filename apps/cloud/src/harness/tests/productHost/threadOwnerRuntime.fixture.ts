import * as NodeAssert from "node:assert/strict";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import type { ProductClaudeHarnessHostOptions } from "../../ProductClaudeHarnessSessionHost.ts";
import type { ProductClaudeThreadMachine } from "../../../thread/ProductClaudeThreadHost.ts";
import { createClaudeCliFacetClass } from "../../ClaudeCliSession.ts";
import { workingSetPolicy } from "./workingSetPolicy.fixture.ts";
import { ClaudeKernelSession } from "../../ClaudeKernelSession.ts";
import { ComputerExecutionObject } from "../../../computer/ComputerExecutionObject.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { ClaudeCliProcessPort } from "../../ClaudeSdkHostProtocol.ts";

/** Controls platform loading; the ordinary thread entry still provisions and binds every owner. */
export function threadOwnerRuntimeFixture<G>(
  original: ProductClaudeHarnessHostOptions<G>,
  nativeFailure?: () => unknown,
  context?: DurableObjectState,
) {
  const loaded: { readonly name: string; readonly mainModule: string }[] = [];
  const dispatched: string[] = [];
  const retired: string[] = [];
  const sdkProcesses: ClaudeCliProcessPort[] = [];
  const checked: Promise<void>[] = [];
  const instances = new Map<string, unknown>();
  let kernel: ClaudeKernelSession | undefined;
  let canonical: KernelFileSystem | undefined;
  const programs = original.commands.loader;
  if (!("run" in programs)) throw new Error("The fixture requires its controlled child loader");
  const sdk = {
    async open(...args: Parameters<typeof original.native.sdkHost.open>) {
      sdkProcesses.push(args[2]);
      return await original.native.sdkHost.open(...args);
    },
  };
  const loader = {
    get(name: string, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      checked.push(
        Promise.resolve(getCode()).then((code) => {
          loaded.push({ name, mainModule: code.mainModule });
        }),
      );
      // `<machine>:<role>:<build>`, and the CLI's also `:<release>`
      const role = /:(kernel|cli|computer|sdk):/.exec(name)?.[1];
      return {
        getDurableObjectClass(entrypoint: string) {
          NodeAssert.equal(
            entrypoint,
            role === "kernel"
              ? "ClaudeKernelFacet"
              : role === "cli"
                ? "ClaudeCliFacet"
                : "ComputerExecutionObject",
          );
          return { role };
        },
        getEntrypoint() {
          NodeAssert.equal(role, "sdk");
          return sdk;
        },
        [Symbol.dispose]() {
          retired.push(name);
        },
      };
    },
    load() {
      throw new Error("Normal startup must use its stable owner identities");
    },
  } as unknown as WorkerLoader;
  const facets = {
    get(key: string, build: () => { readonly class: object }) {
      const previous = instances.get(key);
      if (previous !== undefined) return previous;
      const role = Reflect.get(build().class, "role");
      if (role === "kernel") {
        const current = new ClaudeKernelSession(() => ({
          files: {
            database: original.files.database,
            nowNs: original.files.nowNs,
            persistencePorts: original.files.persistencePorts,
          },
          native: () => ({
            nativeModules: original.native.process.nativeModules,
            loadPackages: original.native.process.loadPackages,
            loadRelease: original.native.process.loadRelease,
          }),
          machine: original.commands.machine,
          hydrate: async (input) => {
            canonical = input.files;
            await original.hydrate?.(input);
          },
          save: original.save,
          port: original.port,
        }));
        const capture = current.captureTranscripts.bind(current);
        current.captureTranscripts = async (...args) => {
          try {
            return await capture(...args);
          } catch (error) {
            const failure = nativeFailure?.();
            if (failure !== undefined)
              throw new AggregateError(
                [error, failure],
                "Controlled native CLI failed before checkpoint capture",
                { cause: error },
              );
            throw error;
          }
        };
        kernel = current;
        instances.set(key, current);
        return current;
      }
      if (role === "cli") {
        const Cli = createClaudeCliFacetClass(() => ({
          nativeModules: original.native.process.nativeModules,
          loadPackages: original.native.process.loadPackages,
          loadRelease: original.native.process.loadRelease,
        }));
        const current = new Cli(context ?? ({} as DurableObjectState), {});
        instances.set(key, current);
        return current;
      }
      NodeAssert.equal(role, "computer");
      const stored = new Map<string, unknown>();
      const current = new ComputerExecutionObject(
        context ??
          ({
            id: key,
            storage: {
              get: async <T>(name: string) => structuredClone(stored.get(name)) as T | undefined,
              put: async (name: string, value: unknown) => {
                stored.set(name, structuredClone(value));
              },
            },
          } as unknown as DurableObjectState),
        {
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
          CHILD_WORKERS: {
            run: (invocation, target) => {
              dispatched.push(invocation.command.executable);
              return programs.run(invocation, target);
            },
          },
        },
      );
      instances.set(key, current);
      return current;
    },
    abort(key: string) {
      NodeAssert.ok(instances.has(key));
    },
    delete(key: string) {
      NodeAssert.ok(instances.delete(key));
    },
  } as unknown as DurableObjectState["facets"];
  const code = (role: string): WorkerLoaderWorkerCode => ({
    compatibilityDate: "2026-10-01",
    mainModule: `${role}-owner.mjs`,
    modules: { [`${role}-owner.mjs`]: { js: `export const role = ${JSON.stringify(role)};` } },
    globalOutbound: null,
  });
  const host: ProductClaudeThreadMachine<G>["host"] = {
    threadId: original.threadId,
    release: original.release,
    releaseVariants: original.releaseVariants,
    programs: original.programs,
    machineInventory: original.machineInventory,
    files: {
      identity: original.files.identity,
      database: original.files.database,
      rootMetadata: original.files.rootMetadata,
      posix: original.files.posix,
      cwd: original.files.cwd,
      assetMode: original.files.assetMode,
    },
    modelTransport: original.modelTransport,
    executor: original.executor,
    admission: { limit: 2, path: ["/bin", "/usr/bin"] },
    runtime: {
      loader,
      facets,
      code: {
        kernel: code("kernel"),
        cli: code("cli"),
        computer: code("computer"),
        sdk: code("sdk"),
      },
      versions: {
        kernel: "kernel-build",
        cli: "cli-build",
        computer: "computer-build",
        sdk: "sdk-build",
      },
    },
    native: {
      workingSet: workingSetPolicy,
      process: {
        identity: original.native.process.identity,
        env: original.native.process.env,
        bun: original.native.process.bun,
        systemIdentity: systemIdentityForThread(
          original.threadId,
          original.commands.systemIdentity,
        ),
      },
    },
  };
  return {
    host,
    loaded,
    dispatched,
    retired,
    sdkProcesses,
    ready: () => Promise.all(checked),
    kernel: () => {
      if (kernel === undefined) throw new Error("Normal startup did not provision its kernel");
      return kernel;
    },
    files: () => {
      if (canonical === undefined)
        throw new Error("Normal startup did not prepare its kernel files");
      return canonical;
    },
    liveOwners: () => instances.size,
  };
}
