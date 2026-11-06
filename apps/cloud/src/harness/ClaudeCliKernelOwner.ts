// @effect-diagnostics cryptoRandomUUID:off - RPC operations exist outside Effect scopes.
import { RpcTarget } from "cloudflare:workers";
import type { createClaudeKernelResources } from "./ClaudeKernelResources.ts";
import type { ClaudeCliKernelPort, ClaudeCliMetadataPage } from "./ClaudeCliKernelPort.ts";
import type { ClaudeKernelInitialize } from "./ClaudeKernelSessionPort.ts";
import type { CliFileMetadata } from "./CliFileWorkingSet.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../kernel/KernelSyscallPort.ts";
import { createKernelSyscallHost } from "../kernel/KernelSyscallHost.ts";
import { createKernelProcessStreams } from "../kernel/KernelProcessStreams.ts";
import { KernelOpenFlags } from "../kernel/KernelOpenFlags.ts";
import { createClaudeCliFiles } from "./claude/CliFiles.ts";
import { createNodeComputerChildProcess } from "../isolate/NodeComputerProcess.ts";
import { NodeChildControl, createCliProcessLeases } from "./cliKernel/Children.ts";
import { kernelError } from "../kernel/KernelErrno.ts";
import { nodeProcessSignalError } from "../isolate/NodeProcessSignals.ts";

type OwnerResources = ReturnType<typeof createClaudeKernelResources>;
type Resources = Pick<
  OwnerResources,
  "processes" | "stdio" | "commands" | "compatibilityRevision"
> & {
  readonly storage: Pick<OwnerResources["storage"], "files">;
};

/** The canonical Computer filesystem and process table are never handed to the CLI Worker. */
export class ClaudeCliKernelOwner extends RpcTarget implements ClaudeCliKernelPort {
  readonly #resources;
  readonly #configuration;
  readonly #lifetime;
  readonly #active = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cancelled = new Map<string, unknown>();
  readonly #fds = new Set<number>();
  readonly #children = new Map<string, NodeChildControl>();
  readonly #sdkFiles;
  readonly #leases;
  readonly #metadataLimit;
  readonly rootDescriptor;
  #snapshot: { revision: number; entries: CliFileMetadata[] } | undefined;
  #closed: Promise<void> | undefined;

  constructor(
    resources: Resources,
    configuration: Pick<ClaudeKernelInitialize, "process">,
    lifetime: AbortSignal,
    metadataLimit: number,
  ) {
    super();
    this.#resources = resources;
    this.#configuration = configuration;
    this.#lifetime = lifetime;
    this.#metadataLimit = metadataLimit;
    this.#sdkFiles = createClaudeCliFiles(resources.storage.files);
    this.#leases = createCliProcessLeases(resources.processes);
    this.rootDescriptor = resources.storage.files.open(
      "/",
      KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
    );
    this.#fds.add(this.rootDescriptor);
  }
  #run<T>(id: string, run: (signal: AbortSignal) => Promise<T>) {
    const pending = (async () => {
      this.#lifetime.throwIfAborted();
      if (this.#closed !== undefined || !id || this.#active.has(id))
        throw new Error("CLI kernel operation is closed or duplicate");
      const controller = new AbortController();
      this.#active.set(id, controller);
      if (this.#cancelled.has(id)) {
        controller.abort(this.#cancelled.get(id));
        this.#cancelled.delete(id);
      }
      const signal = AbortSignal.any([this.#lifetime, controller.signal]);
      try {
        signal.throwIfAborted();
        return await run(signal);
      } finally {
        this.#active.delete(id);
      }
    })();
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  call(request: KernelSyscallRequest) {
    return this.#run(request.operationId ?? crypto.randomUUID(), async (signal) => {
      const host = createKernelSyscallHost({
        filesystem: this.#resources.storage.files,
        args: this.#configuration.process.identity.argv,
        env: Object.fromEntries(
          Object.entries(this.#configuration.process.env).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value]],
          ),
        ),
        signal,
        nimbusMetadata: true,
        sigpipe: "epipe",
      });
      try {
        const result = await host.call(request);
        if (result.kind === "return" && result.value === 0 && request.name === "fd_close")
          this.#fds.delete(Number(request.args[0]));
        if (result.kind === "return" && result.value === 0 && request.name === "path_open") {
          const pointer = Number(request.args[8]);
          const region = result.regions.find(
            (item) =>
              pointer >= item.pointer && pointer + 4 <= item.pointer + item.bytes.byteLength,
          );
          if (region === undefined) throw new Error("Kernel open omitted its descriptor result");
          const fd = new DataView(
            region.bytes.buffer,
            region.bytes.byteOffset + pointer - region.pointer,
            4,
          ).getUint32(0, true);
          this.#fds.add(fd);
        }
        if (result.kind === "return" && result.value === 0 && request.name === "fd_renumber") {
          this.#fds.delete(Number(request.args[0]));
          this.#fds.add(Number(request.args[1]));
        }
        return result;
      } finally {
        host.close();
      }
    });
  }
  async cancel(id: string, reason?: unknown) {
    const active = this.#active.get(id);
    if (active !== undefined) active.abort(reason);
    else if (this.#children.has(id)) await this.#children.get(id)!.dispose();
    else if (this.#cancelled.size < 64) this.#cancelled.set(id, reason);
  }
  #revision() {
    this.#lifetime.throwIfAborted();
    const revision = this.#resources.compatibilityRevision();
    if (revision === undefined) throw new Error("Computer filesystem has no revision counter");
    return revision;
  }
  metadata(cursor: number, revision?: number): Promise<ClaudeCliMetadataPage> {
    return this.#run(crypto.randomUUID(), async (signal) => {
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new RangeError("Invalid CLI metadata cursor");
      const current = this.#revision();
      if (revision !== undefined && revision !== current) throw kernelError("ESTALE");
      if (cursor === 0) {
        const entries: CliFileMetadata[] = [];
        const filesystem = this.#resources.storage.files;
        const visit = async (path: string) => {
          signal.throwIfAborted();
          const stat = await filesystem.lstatAsync(path, signal);
          if (entries.length >= this.#metadataLimit) throw kernelError("E2BIG");
          entries.push({
            path,
            stat,
            ...(stat.type === "symlink" ? { target: filesystem.readlink(path) } : {}),
          });
          if (stat.type === "directory")
            for (const name of await filesystem.readdirAsync(path, signal))
              await visit(`${path === "/" ? "" : path}/${name}`);
        };
        await visit("/");
        if (this.#revision() !== current) throw kernelError("ESTALE");
        this.#snapshot = { revision: current, entries };
      }
      const snapshot = this.#snapshot;
      if (
        snapshot === undefined ||
        snapshot.revision !== current ||
        cursor > snapshot.entries.length
      )
        throw kernelError("ESTALE");
      const end = Math.min(snapshot.entries.length, cursor + 64);
      return {
        revision: current,
        entries: snapshot.entries.slice(cursor, end),
        next: end === snapshot.entries.length ? null : end,
      };
    });
  }
  prefetch(path: string, offset: number, length: number, revision: number) {
    return this.#run(crypto.randomUUID(), async (signal) => {
      if (revision !== this.#revision()) throw kernelError("ESTALE");
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > KERNEL_SYSCALL_MAX_IO_BYTES
      )
        throw new RangeError("Invalid CLI prefetch range");
      const filesystem = this.#resources.storage.files;
      const fd = await filesystem.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, signal);
      try {
        const target = new Uint8Array(length);
        const count = await filesystem.readAsync(fd, target, BigInt(offset), signal);
        if (revision !== this.#revision()) throw kernelError("ESTALE");
        return target.subarray(0, count);
      } finally {
        filesystem.close(fd);
      }
    });
  }
  async leaseDescriptors(count: number) {
    if (!Number.isSafeInteger(count) || count < 0 || count > 64 || this.#fds.size + count > 256)
      throw kernelError("EMFILE");
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const fd = this.#resources.storage.files.open(
        "/",
        KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY,
      );
      this.#fds.add(fd);
      ids.push(fd);
    }
    return ids;
  }
  async leaseProcesses(count: number) {
    return this.#leases.reserve(count);
  }
  async signalProcess(selector: number, signal: number) {
    this.#lifetime.throwIfAborted();
    const result = this.#resources.processes.signalPid(undefined, selector, signal);
    if (result.status !== "ok") throw nodeProcessSignalError(result);
  }
  async processState(cwd: string, umask: number | undefined) {
    const files = this.#resources.storage.files;
    if (files.cwd !== cwd) files.chdir(cwd);
    if (umask !== undefined && umask !== files.posixPolicy?.umask) files.setUmask(umask);
  }
  sdkFiles(id: string, operation: string, args: readonly unknown[]) {
    return this.#run(id, (signal) => this.#sdkFiles.call(operation, args, signal));
  }
  spawn(
    id: string,
    lease: Parameters<ClaudeCliKernelPort["spawn"]>[1],
    input: Parameters<ClaudeCliKernelPort["spawn"]>[2],
  ) {
    return this.#run(id, async (signal) => {
      this.#leases.assertAvailable(lease);
      const resources = this.#resources;
      const childProcess = createNodeComputerChildProcess(
        resources.commands().host,
        {
          filesystem: resources.storage.files,
          env: input.env,
          signal,
          parent: lease,
        },
        { exec: resources.commands().exec },
      );
      const child = childProcess.spawn(input.spawnfile, input.argv.slice(1), {
        ...(input.argv[0] === undefined ? {} : { argv0: input.argv[0] }),
        cwd: input.cwd,
        env: input.env,
        stdio: input.stdio,
        detached: input.detached,
        timeout: input.timeout,
        killSignal: input.killSignal,
        signal,
      });
      const control = new NodeChildControl(child, this.#leases, lease, () =>
        this.#children.delete(id),
      );
      this.#children.set(id, control);
      try {
        await control.admitted();
      } catch (cause) {
        await control.dispose();
        throw cause;
      }
      return control.streams();
    });
  }
  io() {
    const streams = createKernelProcessStreams(this.#resources.storage.files, {
      signal: this.#lifetime,
    });
    return {
      ...streams,
      sdkStdin: this.#resources.stdio.stdin,
      sdkStdout: this.#resources.stdio.stdout,
      sdkStderr: this.#resources.stdio.stderr,
    };
  }
  async finish() {
    this.#resources.stdio.finish();
  }
  dispose() {
    return (this.#closed ??= (async () => {
      for (const active of this.#active.values())
        active.abort(new Error("CLI kernel capability closed"));
      while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
      const results = await Promise.allSettled(
        [...this.#children.values()].map((child) => child.dispose()),
      );
      await this.#leases.close();
      await this.#sdkFiles.close();
      for (const fd of this.#fds)
        if (this.#resources.storage.files.descriptors.has(fd))
          this.#resources.storage.files.close(fd);
      this.#fds.clear();
      this.#snapshot = undefined;
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "CLI kernel capabilities could not close");
    })());
  }
}
