// @effect-diagnostics cryptoRandomUUID:off - Local operations use unique opaque identities.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ThreadId } from "@t3tools/contracts";
import { createProductClaudeKernelHost } from "../../ProductClaudeKernelHost.ts";
import { createClaudeProductOwners } from "../../ClaudeProductOwners.ts";
import { createAssetChildWorkerLoader } from "../../../computer/CompiledChildWorkerLoader.ts";
import { createSeededCommandProgramCodes } from "../../../../infra/childPrograms/runtime.ts";
import type { FullChildProgramSources } from "../../../../infra/childPrograms/prepare.ts";
import type { ProgramSeed } from "../../HarnessSessionHost.ts";
import type { ClaudeKernelInitialize } from "../../ClaudeKernelSessionPort.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import {
  claudeReleaseArtifact,
  claudeReleaseVariantsForArtifact,
} from "./releaseVariants.fixture.ts";
import { machineInventoryFixture } from "../../../computer/machineInventoryTesting.ts";
import { readRpcData, releaseRpcResult } from "../../../rpc/Resources.ts";

interface Materials {
  readonly sources: FullChildProgramSources;
  readonly seed: ProgramSeed["files"];
  readonly payloads: Readonly<Record<string, string>>;
  readonly sourceIdentity: string;
}
interface Env {
  readonly LOADER: WorkerLoader;
  readonly KERNEL_SOURCE: string;
  readonly COMPUTER_SOURCE: string;
  readonly MATERIALS: Materials;
  readonly HOST: DurableObjectNamespace<Host>;
}
const process = {
  identity: {
    version: "v24.21.0",
    versions: { node: "24.21.0", bun: "1.3.11" },
    platform: "linux",
    arch: "x64",
    type: "Linux",
    endianness: "LE",
    availableParallelism: 1,
    user: { username: "agent", uid: 1000, gid: 1000, shell: "/bin/bash" },
    homedir: "/home/agent",
    tmpdir: "/tmp",
    pid: 1,
    ppid: 0,
    execPath: "/runtime/claude",
    argv0: "claude",
    argv: ["claude"],
  },
  env: { HOME: "/home/agent", PATH: "/bin:/usr/bin", LC_ALL: "C" },
  bun: { main: "/release/cli", version: "1.3.11", revision: "test" },
} satisfies ClaudeKernelInitialize["process"];
export class ChildLoader extends WorkerEntrypoint<Env> {
  readonly #loader = createAssetChildWorkerLoader(this.env.LOADER, async (hash) => {
    const value = this.env.MATERIALS.payloads[hash];
    if (value === undefined) throw new Error("Missing pinned WASM");
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)).buffer;
  });
  run(...args: Parameters<ReturnType<typeof createAssetChildWorkerLoader>["run"]>) {
    return this.#loader.run(...args);
  }
}
export class Host extends DurableObject<Env> {
  #scope: Scope.Closeable | undefined;
  #host: Effect.Success<ReturnType<typeof createProductClaudeKernelHost>> | undefined;
  #owners: ReturnType<typeof createClaudeProductOwners> | undefined;
  async configure() {
    const materials = this.env.MATERIALS;
    const bytes = new Map(
      Object.entries(materials.payloads).map(([hash, value]) => [
        hash,
        Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
      ]),
    );
    const entrypoints = this.ctx.exports as { ChildLoader: LoopbackServiceStub<ChildLoader> };
    const loader = entrypoints.ChildLoader({});
    const code = (
      source: string,
      entry: string,
      env?: Record<string, unknown>,
    ): WorkerLoaderWorkerCode => ({
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: entry,
      modules: { [entry]: { js: source } },
      globalOutbound: null,
      ...(env === undefined ? {} : { env }),
    });
    this.#owners = createClaudeProductOwners(
      {
        loader: this.env.LOADER,
        facets: this.ctx.facets,
        code: {
          kernel: code(this.env.KERNEL_SOURCE, "kernel.js"),
          computer: code(this.env.COMPUTER_SOURCE, "computer.js", {
            CHILD_WORKERS: loader,
            RESIDENT_BYTE_LIMIT: "128000000",
          }),
          sdk: code(
            'import {WorkerEntrypoint} from "cloudflare:workers";export default class extends WorkerEntrypoint {}',
            "sdk.js",
          ),
        },
      },
      "argument-test",
    );
    const release = await claudeFixture();
    const artifact = claudeReleaseArtifact(release.options.identity, "command-test");
    this.#scope = await Effect.runPromise(Scope.make());
    this.#host = await Effect.runPromise(
      createProductClaudeKernelHost({
        threadId: ThreadId.make("rpc-argument-thread"),
        sessionKey: "command-session",
        release: release.options,
        releaseVariants: claudeReleaseVariantsForArtifact(artifact),
        programs: {
          codes: createSeededCommandProgramCodes(materials.sources),
          seed: {
            sourceIdentity: materials.sourceIdentity,
            files: materials.seed,
            async read(path, signal) {
              signal.throwIfAborted();
              const hash = materials.seed[path]?.sha256;
              const value = hash === undefined ? undefined : bytes.get(hash);
              if (value === undefined) throw new Error("Missing seed bytes");
              return value.slice();
            },
          },
        },
        machineInventory: machineInventoryFixture(),
        files: {
          identity: "command-files",
          database: this.ctx.storage,
          rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
          posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
          cwd: "/work",
          assetMode: 0o644,
        },
        kernel: this.#owners.kernel,
        commands: this.#owners.commands,
        admission: { limit: 4, path: ["/bin", "/usr/bin"] },
        native: { sdkHost: this.#owners.sdkHost, process },
        continuations: { publish: () => Effect.die(new Error("No provider turn allowed")) },
        modelTransport: async () => {
          throw new Error("No model requests allowed");
        },
        executor: {
          forward: async () => {
            throw new Error("No Executor calls allowed");
          },
        },
      }).pipe(Scope.provide(this.#scope)),
    );
    await Effect.runPromise(this.#host.seed("assets"));
    await Effect.runPromise(this.#host.seed("programs"));
    return { configured: true, kernel: await this.#owners.kernel.kernelIdentity() };
  }
  async run(command: string) {
    if (this.#owners === undefined) throw new Error("Configure must have returned before running");
    const body =
      "shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '" +
      command +
      "' < /dev/null && pwd -P >| /tmp/claude-test-cwd";
    const child = await this.#owners.kernel.exec(
      crypto.randomUUID(),
      {
        executable: "/bin/bash",
        argv: ["/bin/bash", "-c", "-l", body],
        cwd: "/work",
        env: process.env,
      },
      true,
    );
    try {
      const writer = child.stdin.getWriter();
      await writer.close();
      writer.releaseLock();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        readRpcData(child.control.exited()),
      ]);
      return { stdout, stderr, exit };
    } finally {
      await child.control.dispose();
      releaseRpcResult(child);
    }
  }
  async close() {
    const owners = this.#owners;
    if (owners === undefined || this.#scope === undefined)
      throw new Error("Owners were never configured");
    const before = await readRpcData(
      (owners.commands as typeof owners.commands & { resources(): Promise<unknown> }).resources(),
    );
    await this.#host?.dispose.pipe(Effect.runPromise);
    await Effect.runPromise(Scope.close(this.#scope, Exit.void));
    const kernel = await readRpcData(
      (owners.kernel as typeof owners.kernel & { resources(): Promise<unknown> }).resources(),
    );
    const computer = await readRpcData(
      (owners.commands as typeof owners.commands & { resources(): Promise<unknown> }).resources(),
    );
    const late = await owners.kernel
      .exec(
        "late",
        {
          executable: "/bin/bash",
          argv: ["/bin/bash", "-c", "echo late"],
          cwd: "/work",
          env: process.env,
        },
        true,
      )
      .then(
        () => false,
        () => true,
      );
    owners.dispose();
    this.#owners = undefined;
    this.#host = undefined;
    this.#scope = undefined;
    return { before, kernel, computer, lateRejected: late };
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const owner = env.HOST.getByName("host");
    const url = new URL(request.url);
    try {
      if (url.pathname === "/configure") return Response.json(await owner.configure());
      if (url.pathname === "/close") return Response.json(await owner.close());
      return Response.json(await owner.run(url.searchParams.get("command") ?? "echo hi"));
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    }
  },
};
