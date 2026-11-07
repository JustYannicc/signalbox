// @effect-diagnostics cryptoRandomUUID:off - Each isolate names itself to prove which isolate answered.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  createClaudeProductOwners,
  type ClaudeProductOwnerRuntime,
} from "../../../../src/harness/ClaudeProductOwners.ts";
import {
  CLAUDE_OWNER_COMPATIBILITY,
  claudeOwnerCode,
  claudeOwnerRuntime,
} from "./claudeOwnerCode.ts";

type Role = keyof ClaudeProductOwnerRuntime["code"];
interface Env {
  readonly LOADER: WorkerLoader;
  readonly HOST: DurableObjectNamespace<ClaudeThreadOwnersHost>;
  readonly PEER: DurableObjectNamespace<OwnerPeer>;
  readonly COMMANDS: Fetcher;
  readonly TAIL: Fetcher;
}
interface Realm {
  readonly realm: string;
  readonly env: readonly string[];
}

let isolate: string | undefined;
const realm = () => (isolate ??= crypto.randomUUID());
// Every owner reports its own isolate and the bindings that reached it.
const owner = (name: string, base: "DurableObject" | "WorkerEntrypoint") => `
import { ${base} } from "cloudflare:workers";
let isolate;
export class ${name} extends ${base} {
  realm() { return { realm: (isolate ??= crypto.randomUUID()), env: Object.keys(this.env).sort() }; }
  async peer() { return await this.env.PEER.name(); }
}`;
const roles: readonly Role[] = ["kernel", "cli", "computer", "sdk"];

export class OwnerPeer extends DurableObject {
  name() {
    return "peer";
  }
}
export class OwnerCommands extends WorkerEntrypoint {
  run() {
    return "commands";
  }
}
export class OwnerTail extends WorkerEntrypoint {
  override tail() {}
}

export class ClaudeThreadOwnersHost extends DurableObject<Env> {
  readonly calls: Record<Role, number> = { kernel: 0, cli: 0, computer: 0, sdk: 0 };
  readonly tails: Partial<Record<Role, number>> = {};

  /** Opens owners exactly as the qualifier's Claude thread does: its own loader and facets. */
  #runtime(): ClaudeProductOwnerRuntime {
    const code = claudeOwnerCode({
      compatibility: CLAUDE_OWNER_COMPATIBILITY,
      release: {
        plan: { release: { harness: "claude-code" } } as never,
        modules: async () => ({}),
      },
      sources: {
        kernel: () => owner("ClaudeKernelFacet", "DurableObject"),
        cli: () => owner("ClaudeCliFacet", "DurableObject"),
        computer: () => owner("ComputerExecutionObject", "DurableObject"),
        sdk: () => owner("ClaudeSdkHost", "WorkerEntrypoint"),
      },
      kernelEnv: { PEER: this.env.PEER.getByName("peer") },
      commands: this.env.COMMANDS,
    });
    const counted = Object.fromEntries(
      roles.map((role) => [
        role,
        async () => {
          this.calls[role]++;
          return await code[role]();
        },
      ]),
    ) as ClaudeProductOwnerRuntime["code"];
    const runtime = claudeOwnerRuntime({
      loader: this.env.LOADER,
      facets: this.ctx.facets,
      code: counted,
      versions: { kernel: "kernel-1", cli: "cli-1", computer: "computer-1", sdk: "sdk-1" },
      tail: this.env.TAIL,
    });
    // Records what each owner's loader callback produced, after the runtime added its tail.
    const loader: WorkerLoader = {
      get: (name, getCode) =>
        this.env.LOADER.get(name, async () => {
          const built = await getCode();
          const role = roles.find((candidate) => String(name).includes(`:${candidate}:`));
          if (role !== undefined) this.tails[role] = built.tails?.length ?? 0;
          return built;
        }),
      load: (code) => this.env.LOADER.load(code),
    };
    return { ...runtime, loader };
  }

  async provision() {
    const owners = createClaudeProductOwners(this.#runtime(), "machine-1", "release-1");
    try {
      const kernel = owners.kernel as unknown as {
        realm(): Promise<Realm>;
        peer(): Promise<string>;
      };
      const cli = owners.cliHost as unknown as { realm(): Promise<Realm> };
      const computer = owners.commands as unknown as { realm(): Promise<Realm> };
      const sdk = owners.sdkHost as unknown as { realm(): Promise<Realm> };
      return {
        host: realm(),
        owners: {
          kernel: await kernel.realm(),
          cli: await cli.realm(),
          computer: await computer.realm(),
          sdk: await sdk.realm(),
        },
        kernelPeer: await kernel.peer(),
        calls: this.calls,
        tails: this.tails,
      };
    } finally {
      owners.dispose();
    }
  }

  /** The shape the dynamic C facet used: owner facet stubs placed in another Worker's env. */
  async handOwnersToAnotherWorker() {
    const owners = createClaudeProductOwners(this.#runtime(), "machine-2", "release-1");
    try {
      const worker = this.env.LOADER.get("other-worker", () => ({
        ...CLAUDE_OWNER_COMPATIBILITY,
        mainModule: "other.mjs",
        modules: { "other.mjs": { js: owner("OtherHost", "DurableObject") } },
        env: { CLAUDE_KERNEL: owners.kernel },
        globalOutbound: null,
      }));
      const other = this.ctx.facets.get<DurableObject & { realm(): Promise<Realm> }>(
        "other-worker",
        () => ({ class: worker.getDurableObjectClass("OtherHost") }),
      );
      await other.realm();
      return { refused: false as const };
    } catch (error) {
      return {
        refused: true as const,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      owners.dispose();
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const host = env.HOST.getByName(new URL(request.url).pathname);
    if (new URL(request.url).pathname === "/crossing")
      return Response.json(await host.handOwnersToAnotherWorker());
    return Response.json(await host.provision());
  },
};
