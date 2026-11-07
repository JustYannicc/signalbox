import { DurableObject } from "cloudflare:workers";
import {
  createClaudeProductOwners,
  type ClaudeOwnerCodeFactory,
  type ClaudeProductOwnerRuntime,
} from "../../ClaudeProductOwners.ts";

type Role = keyof ClaudeProductOwnerRuntime["code"];
type ModuleEntry = { readonly name: string; readonly type: "js" | "text" | "json" };
interface Env {
  readonly LOADER: WorkerLoader;
  readonly MODULES: Fetcher;
  readonly PROBE: DurableObjectNamespace<OwnerHeapProbe>;
}

const ENTRIES: Record<Role, { readonly file: string; readonly source: string }> = {
  kernel: {
    file: "claude-kernel-entry.mjs",
    source: `import { DurableObject } from "cloudflare:workers"; export class ClaudeKernelFacet extends DurableObject { ping() { return "kernel"; } }`,
  },
  cli: {
    file: "claude-cli-entry.mjs",
    source: `import { DurableObject } from "cloudflare:workers"; export class ClaudeCliFacet extends DurableObject { ping() { return "cli"; } }`,
  },
  computer: {
    file: "computer-execution-entry.mjs",
    source: `import { DurableObject } from "cloudflare:workers"; export class ComputerExecutionObject extends DurableObject { ping() { return "computer"; } }`,
  },
  sdk: {
    file: "claude-sdk-host-entry.mjs",
    source: `import { WorkerEntrypoint } from "cloudflare:workers"; export default class extends WorkerEntrypoint { ping() { return "sdk"; } }`,
  },
};

type Pingable = { ping(): Promise<string> };

/** Provisions all four owners from factories that read their modules only when the loader asks. */
export class OwnerHeapProbe extends DurableObject<Env> {
  readonly #calls: Record<Role, number> = { kernel: 0, cli: 0, computer: 0, sdk: 0 };
  #live: ReturnType<typeof createClaudeProductOwners> | undefined;

  #factory(role: Role): ClaudeOwnerCodeFactory {
    return async () => {
      this.#calls[role]++;
      const entry = ENTRIES[role];
      const modules: WorkerLoaderWorkerCode["modules"] = { [entry.file]: { js: entry.source } };
      // Only the CLI carries the release; it is never imported, as in production startup.
      if (role === "cli") {
        const manifest = await (
          await this.env.MODULES.fetch("http://modules/manifest.json")
        ).json<readonly ModuleEntry[]>();
        for (const module of manifest) {
          const text = await (
            await this.env.MODULES.fetch(`http://modules/${encodeURI(module.name)}`)
          ).text();
          modules[module.name] =
            module.type === "json" ? { json: JSON.parse(text) } : { [module.type]: text };
        }
      }
      return {
        compatibilityDate: "2026-10-19",
        compatibilityFlags: ["nodejs_compat", "new_module_registry"],
        mainModule: entry.file,
        modules,
        globalOutbound: null,
      };
    };
  }

  async provision() {
    const runtime: ClaudeProductOwnerRuntime = {
      loader: this.env.LOADER,
      facets: this.ctx.facets,
      code: {
        kernel: this.#factory("kernel"),
        cli: this.#factory("cli"),
        computer: this.#factory("computer"),
        sdk: this.#factory("sdk"),
      },
      versions: { kernel: "k", cli: "c", computer: "x", sdk: "s" },
    };
    const pinged: string[] = [];
    // Two provisions while the first is still live: the second must reuse the loaded Workers.
    const rounds = [0, 1].map(() => createClaudeProductOwners(runtime, "heap-probe", "release"));
    for (const owners of rounds)
      for (const owner of [owners.kernel, owners.cliHost, owners.commands, owners.sdkHost])
        pinged.push(await (owner as unknown as Pingable).ping());
    // Both rounds share the same facets; the last one retires them when the test is done.
    this.#live = rounds.at(-1);
    // The harness runs this isolate with --expose-gc.
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    gc?.();
    return { calls: this.#calls, pinged, collected: gc !== undefined };
  }

  retire() {
    this.#live?.dispose();
    this.#live = undefined;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const probe = env.PROBE.getByName("probe");
    if (new URL(request.url).pathname === "/retire") return Response.json(await probe.retire());
    return Response.json(await probe.provision());
  },
};
