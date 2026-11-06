import {
  MAX_TRANSFER_BYTES,
  type KernelMemoryRegion,
  type KernelSyscallResponse,
} from "../../../kernel/KernelSyscallPort.ts";
import { kernelError, WASI_ERRNO_CODES } from "../../../kernel/KernelErrno.ts";
import { KernelProcessSignal } from "../../../kernel/KernelProcessSignal.ts";
import { NodeProcessExitError } from "../../NodeProcessExit.ts";

/** Only one call's arguments and output reservations exist here, never a guest memory image. */
export class SyscallFrame {
  readonly regions: KernelMemoryRegion[] = [];
  readonly #outputs = new Map<number, number>();
  #result: readonly KernelMemoryRegion[] = [];
  #cursor = 8;
  get memorySize() {
    return this.#cursor;
  }

  #allocate(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TRANSFER_BYTES)
      throw new RangeError("Invalid Node syscall argument length");
    const pointer = this.#cursor;
    this.#cursor += Math.ceil(length / 8) * 8;
    if (this.#cursor > MAX_TRANSFER_BYTES)
      throw new RangeError("Node syscall arguments exceed the transfer limit");
    return pointer;
  }
  input(bytes: Uint8Array) {
    const pointer = this.#allocate(bytes.byteLength);
    this.regions.push({ pointer, bytes, direction: "in" });
    return pointer;
  }
  path(path: string, relative = false) {
    const value = relative && path.startsWith("/") ? path.replace(/^\/+/, "") || "." : path;
    const bytes = new TextEncoder().encode(value);
    return { pointer: this.input(bytes), length: bytes.byteLength };
  }
  output(length: number) {
    const pointer = this.#allocate(length);
    this.regions.push({ pointer, bytes: new Uint8Array(0), direction: "out", length });
    this.#outputs.set(pointer, length);
    return pointer;
  }
  accept(response: KernelSyscallResponse) {
    if (response.kind === "exit") throw new NodeProcessExitError(response.code);
    if (response.kind === "signal") throw new KernelProcessSignal(response.signal);
    if (response.value !== 0)
      throw kernelError(WASI_ERRNO_CODES[response.value] ?? "EIO", `WASI error: ${response.value}`);
    let previousEnd = 0;
    for (const region of response.regions) {
      const reservation = [...this.#outputs].find(
        ([pointer, length]) =>
          region.pointer >= pointer && region.pointer + region.bytes.byteLength <= pointer + length,
      );
      if (reservation === undefined || region.pointer < previousEnd)
        throw new Error("Computer returned a range outside the syscall output reservation");
      previousEnd = region.pointer + region.bytes.byteLength;
    }
    this.#result = response.regions;
  }
  bytes(pointer: number, length: number) {
    const capacity = this.#outputs.get(pointer);
    if (capacity === undefined || length > capacity || length < 0)
      throw new RangeError("Invalid Node syscall output range");
    const bytes = new Uint8Array(length);
    for (const region of this.#result) {
      if (region.pointer < pointer || region.pointer >= pointer + length) continue;
      bytes.set(
        region.bytes.subarray(0, pointer + length - region.pointer),
        region.pointer - pointer,
      );
    }
    return bytes;
  }
  u32(pointer: number) {
    return new DataView(this.bytes(pointer, 4).buffer).getUint32(0, true);
  }
  u64(pointer: number) {
    return new DataView(this.bytes(pointer, 8).buffer).getBigUint64(0, true);
  }
}
