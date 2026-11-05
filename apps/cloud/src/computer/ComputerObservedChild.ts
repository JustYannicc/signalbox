import { RpcTarget } from "cloudflare:workers";
import type { KernelChildHostPort } from "../kernel/KernelChildDispatchPort.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelBashWorkerPort } from "../kernel/KernelBashDispatchPort.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

/** The execution owner charges bounded syscall requests before forwarding them to the kernel. */
export class ComputerObservedChild extends RpcTarget implements KernelChildHostPort {
  readonly #port: ChildHostRef<KernelChildHostPort>;
  readonly #lease;
  constructor(port: KernelChildHostPort, lease: ChildHostLease) {
    super();
    this.#port = lease.hold(port);
    this.#lease = lease;
  }
  async call(input: Parameters<KernelChildHostPort["call"]>[0]) {
    this.#lease.observe(input.memorySize);
    return await this.#port.get().call(input);
  }
  async callBusybox(input: Parameters<KernelChildHostPort["callBusybox"]>[0]) {
    this.#lease.observe(input.memorySize);
    return await this.#port.get().callBusybox(input);
  }
  async callCoreutils(input: Parameters<KernelChildHostPort["callCoreutils"]>[0]) {
    this.#lease.observe(input.memorySize);
    return await this.#port.get().callCoreutils(input);
  }
  async callGit(input: Parameters<KernelChildHostPort["callGit"]>[0]) {
    this.#lease.observe(input.memorySize);
    return await this.#port.get().callGit(input);
  }
}

export class ComputerObservedBash extends RpcTarget implements KernelBashWorkerPort {
  readonly #port: ChildHostRef<KernelBashWorkerPort>;
  readonly #lease;
  constructor(port: KernelBashWorkerPort, lease: ChildHostLease) {
    super();
    this.#port = lease.hold(port);
    this.#lease = lease;
  }
  async metadata() {
    return await this.#port.get().metadata();
  }
  async forkSnapshot() {
    return await this.#port.get().forkSnapshot();
  }
  async runFork(source: KernelBashForkSource) {
    return await this.#port.get().runFork(source);
  }
  async startOperation(input: Parameters<NonNullable<KernelBashPort["startOperation"]>>[0]) {
    const port = this.#port.get();
    if (port.startOperation === undefined)
      throw new Error("Bash operation placement is unavailable");
    return await port.startOperation(input);
  }
  async park(source: KernelBashForkSource, id?: string) {
    const port = this.#port.get();
    if (port.park === undefined) throw new Error("Bash parking is unavailable");
    await port.park(source, id);
  }
  async placeFork(source: KernelBashForkSource) {
    const port = this.#port.get();
    if (port.placeFork === undefined) throw new Error("Bash fork placement is unavailable");
    await port.placeFork(source);
  }
  async observeResident(bytes: number) {
    this.#lease.observe(bytes);
  }
  async call(input: Parameters<KernelBashPort["call"]>[0]) {
    this.#lease.observe(input.residentWasmBytes ?? input.memorySize);
    return await this.#port.get().call(input);
  }
  async callBash(input: Parameters<KernelBashPort["callBash"]>[0]) {
    this.#lease.observe(input.residentWasmBytes ?? input.memorySize);
    return await this.#port.get().callBash(input);
  }
  async fork() {
    const result = await this.#port.get().fork();
    if (result.kind !== "fork") return result;
    return { ...result, port: new ComputerObservedBashFork(result.port, this.#lease) };
  }
  async wait(pid: number, options: number) {
    return await this.#port.get().wait(pid, options);
  }
  async exec(input: Parameters<KernelBashPort["exec"]>[0]) {
    return await this.#port.get().exec(input);
  }
  async complete(input: Parameters<KernelBashPort["complete"]>[0]) {
    await this.#port.get().complete(input);
    this.#lease.drop(this.#port);
  }
}

class ComputerObservedBashFork extends RpcTarget implements KernelBashPort {
  readonly #port: ChildHostRef<KernelBashPort>;
  readonly #lease;
  constructor(port: KernelBashPort, lease: ChildHostLease) {
    super();
    this.#port = lease.hold(port);
    this.#lease = lease;
  }
  async runFork(source: KernelBashForkSource) {
    return await this.#port.get().runFork(source);
  }
  async startOperation(input: Parameters<NonNullable<KernelBashPort["startOperation"]>>[0]) {
    const port = this.#port.get();
    if (port.startOperation === undefined)
      throw new Error("Bash operation placement is unavailable");
    return await port.startOperation(input);
  }
  async park(source: KernelBashForkSource, id?: string) {
    const port = this.#port.get();
    if (port.park === undefined) throw new Error("Bash parking is unavailable");
    await port.park(source, id);
  }
  async placeFork(source: KernelBashForkSource) {
    const port = this.#port.get();
    if (port.placeFork === undefined) throw new Error("Bash fork placement is unavailable");
    await port.placeFork(source);
  }
  async observeResident(bytes: number) {
    this.#lease.observe(bytes);
  }
  async call(input: Parameters<KernelBashPort["call"]>[0]) {
    this.#lease.observe(input.residentWasmBytes ?? input.memorySize);
    return await this.#port.get().call(input);
  }
  async callBash(input: Parameters<KernelBashPort["callBash"]>[0]) {
    this.#lease.observe(input.residentWasmBytes ?? input.memorySize);
    return await this.#port.get().callBash(input);
  }
  async fork(): ReturnType<KernelBashPort["fork"]> {
    const result = await this.#port.get().fork();
    return result.kind === "fork"
      ? { ...result, port: new ComputerObservedBashFork(result.port, this.#lease) }
      : result;
  }
  async wait(pid: number, options: number) {
    return await this.#port.get().wait(pid, options);
  }
  async exec(input: Parameters<KernelBashPort["exec"]>[0]) {
    return await this.#port.get().exec(input);
  }
  async complete(input: Parameters<KernelBashPort["complete"]>[0]) {
    await this.#port.get().complete(input);
    this.#lease.drop(this.#port);
  }
}
