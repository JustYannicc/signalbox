import { KernelWebSocketResource } from "./webSocket/KernelWebSocketResource.ts";
import type { KernelDescriptorResource, KernelDescriptors } from "./KernelDescriptors.ts";
import { normalizeWebSocketRouteResponse } from "./webSocket/KernelWebSocketResponse.ts";
import {
  decodeWebSocketRequest,
  WS_ERRNO,
  MAX_REQUEST_BYTES,
  type KernelWebSocketHeader,
  type KernelWebSocketWireError,
} from "./webSocket/KernelWebSocketWire.ts";
import type { KernelWebSocketRoute } from "./webSocket/KernelWebSocketTypes.ts";

export type { KernelWebSocketHeader } from "./webSocket/KernelWebSocketWire.ts";
export type {
  KernelWebSocketRoute,
  KernelWebSocketRouteRequest,
  KernelWebSocketRouteResult,
  KernelWebSocketRouteResponse,
  KernelWebSocketResponseWithHeaders,
  KernelWebSocketWebSocket,
} from "./webSocket/KernelWebSocketTypes.ts";

export interface KernelWebSocketHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly descriptors: Pick<KernelDescriptors, "register" | "resource" | "close">;
  readonly route: KernelWebSocketRoute;
}

export interface KernelWebSocketImports {
  readonly ws_open: (requestPointer: number, requestLength: number, outFdPointer: number) => number;
  readonly ws_handshake: (
    fd: number,
    outputPointer: number,
    capacity: number,
    outRequiredPointer: number,
  ) => number;
  readonly ws_recv: (
    fd: number,
    outOpcodePointer: number,
    outputPointer: number,
    capacity: number,
    outRequiredPointer: number,
  ) => number;
  readonly ws_ready: (fd: number) => number;
  readonly ws_send: (fd: number, opcode: number, pointer: number, length: number) => number;
  readonly ws_flush: (fd: number) => number;
  readonly ws_close: (fd: number) => number;
  readonly ws_drop: (fd: number) => number;
}

/** Synchronous WASI errno imports for the request-scoped loopback WebSocket router. */
export class KernelWebSocketHost {
  readonly imports: KernelWebSocketImports;
  readonly #options: KernelWebSocketHostOptions;

  constructor(options: KernelWebSocketHostOptions) {
    this.#options = options;
    const imports: KernelWebSocketImports = {
      ws_open: (requestPointer, requestLength, outFdPointer) =>
        this.#safely(() => this.#open(requestPointer, requestLength, outFdPointer)),
      ws_handshake: (fd, outputPointer, capacity, outRequiredPointer) =>
        this.#safely(() => this.#handshake(fd, outputPointer, capacity, outRequiredPointer)),
      ws_recv: (fd, outOpcodePointer, outputPointer, capacity, outRequiredPointer) =>
        this.#safely(() =>
          this.#receive(fd, outOpcodePointer, outputPointer, capacity, outRequiredPointer),
        ),
      ws_ready: (fd) => this.#safely(() => this.#ready(fd)),
      ws_send: (fd, opcode, pointer, length) =>
        this.#safely(() => this.#send(fd, opcode, pointer, length)),
      ws_flush: (fd) => this.#safely(() => this.#resource(fd).flush()),
      ws_close: (fd) => this.#safely(() => this.#resource(fd).closeGracefully()),
      ws_drop: (fd) => this.#safely(() => this.#drop(fd)),
    };
    this.imports = Object.freeze(imports);
  }

  getImportObject(): { signalbox_ws_v1: KernelWebSocketImports } {
    return { signalbox_ws_v1: this.imports };
  }

  #open(requestPointer: number, requestLength: number, outFdPointer: number): number {
    let memory: WebAssembly.Memory;
    try {
      memory = this.#options.memory();
    } catch {
      return WS_ERRNO.EIO;
    }
    const outputOffset = wasmU32(outFdPointer);
    if (!hasRange(memory, outputOffset, 4)) return WS_ERRNO.EFAULT;
    const inputOffset = wasmU32(requestPointer);
    const inputLength = wasmU32(requestLength);
    if (inputLength > MAX_REQUEST_BYTES) return WS_ERRNO.EMSGSIZE;
    if (!hasRange(memory, inputOffset, inputLength)) return WS_ERRNO.EFAULT;

    const request = decodeWebSocketRequest(
      new Uint8Array(memory.buffer, inputOffset, inputLength).slice(),
    );
    if (typeof request === "number") return request;

    const resource = new KernelWebSocketResource({
      maxFrameBytes: request.maxFrameBytes,
      maxQueueBytes: request.maxQueueBytes,
    });
    let fd: number;
    try {
      fd = this.#options.descriptors.register(resource);
      normalizeFd(fd);
    } catch (error) {
      resource.close();
      return descriptorErrno(error);
    }

    try {
      memory = this.#options.memory();
    } catch {
      try {
        this.#options.descriptors.close(fd);
      } catch {
        resource.close();
      }
      return WS_ERRNO.EIO;
    }
    if (!hasRange(memory, outputOffset, 4)) {
      try {
        this.#options.descriptors.close(fd);
      } catch {
        resource.close();
      }
      return WS_ERRNO.EFAULT;
    }
    new DataView(memory.buffer).setUint32(outputOffset, fd >>> 0, true);
    this.#route(resource, request.url, request.authority, request.headers);
    return 0;
  }

  #handshake(
    fd: number,
    outputPointer: number,
    capacity: number,
    outRequiredPointer: number,
  ): number {
    const memory = this.#options.memory();
    const requiredOffset = wasmU32(outRequiredPointer);
    if (!hasRange(memory, requiredOffset, 4)) return WS_ERRNO.EFAULT;
    const outputOffset = wasmU32(outputPointer);
    const outputCapacity = wasmU32(capacity);
    const resource = this.#resource(fd);
    const state = resource.handshakeState();
    if (state.status === "pending") return WS_ERRNO.EAGAIN;
    if (state.status === "error") return state.errno;
    if (state.status === "consumed") return WS_ERRNO.EINVAL;
    if (state.bytes.byteLength > outputCapacity) {
      writeU32(memory, requiredOffset, state.bytes.byteLength);
      return WS_ERRNO.ENOBUFS;
    }
    if (!hasRange(memory, outputOffset, state.bytes.byteLength)) return WS_ERRNO.EFAULT;
    const currentMemory = this.#options.memory();
    if (
      !hasRange(currentMemory, requiredOffset, 4) ||
      !hasRange(currentMemory, outputOffset, state.bytes.byteLength)
    ) {
      return WS_ERRNO.EFAULT;
    }
    new Uint8Array(currentMemory.buffer, outputOffset, state.bytes.byteLength).set(state.bytes);
    writeU32(currentMemory, requiredOffset, state.bytes.byteLength);
    resource.consumeHandshake();
    return 0;
  }

  #receive(
    fd: number,
    outOpcodePointer: number,
    outputPointer: number,
    capacity: number,
    outRequiredPointer: number,
  ): number {
    const memory = this.#options.memory();
    const opcodeOffset = wasmU32(outOpcodePointer);
    const requiredOffset = wasmU32(outRequiredPointer);
    if (!hasRange(memory, opcodeOffset, 4) || !hasRange(memory, requiredOffset, 4))
      return WS_ERRNO.EFAULT;
    const outputOffset = wasmU32(outputPointer);
    const outputCapacity = wasmU32(capacity);
    const resource = this.#resource(fd);
    const state = resource.receiveState();
    if (state.status === "pending") return WS_ERRNO.EAGAIN;
    if (state.status === "error") return state.errno;
    if (state.status === "eof") {
      const currentMemory = this.#options.memory();
      if (
        !hasRange(currentMemory, opcodeOffset, 4) ||
        !hasRange(currentMemory, requiredOffset, 4)
      ) {
        return WS_ERRNO.EFAULT;
      }
      writeU32(currentMemory, opcodeOffset, 0);
      writeU32(currentMemory, requiredOffset, 0);
      return 0;
    }
    const { frame } = state;
    if (frame.data.byteLength > outputCapacity) {
      const currentMemory = this.#options.memory();
      if (
        !hasRange(currentMemory, opcodeOffset, 4) ||
        !hasRange(currentMemory, requiredOffset, 4)
      ) {
        return WS_ERRNO.EFAULT;
      }
      writeU32(currentMemory, opcodeOffset, frame.opcode);
      writeU32(currentMemory, requiredOffset, frame.data.byteLength);
      return WS_ERRNO.ENOBUFS;
    }
    if (!hasRange(memory, outputOffset, frame.data.byteLength)) return WS_ERRNO.EFAULT;
    const currentMemory = this.#options.memory();
    if (
      !hasRange(currentMemory, opcodeOffset, 4) ||
      !hasRange(currentMemory, requiredOffset, 4) ||
      !hasRange(currentMemory, outputOffset, frame.data.byteLength)
    ) {
      return WS_ERRNO.EFAULT;
    }
    new Uint8Array(currentMemory.buffer, outputOffset, frame.data.byteLength).set(frame.data);
    writeU32(currentMemory, opcodeOffset, frame.opcode);
    writeU32(currentMemory, requiredOffset, frame.data.byteLength);
    resource.consumeFrame(frame);
    return 0;
  }

  #ready(fd: number): number {
    return this.#resource(fd).canSend();
  }

  #send(fd: number, opcode: number, pointer: number, length: number): number {
    const memory = this.#options.memory();
    const offset = wasmU32(pointer);
    const byteLength = wasmU32(length);
    if (!hasRange(memory, offset, byteLength)) return WS_ERRNO.EFAULT;
    const data = new Uint8Array(memory.buffer, offset, byteLength).slice();
    return this.#resource(fd).send(opcode, data);
  }

  #drop(fd: number): number {
    try {
      this.#options.descriptors.close(normalizeFd(fd));
      return 0;
    } catch (error) {
      return descriptorErrno(error);
    }
  }

  #resource(fd: number): KernelWebSocketResource {
    const resource: KernelDescriptorResource = this.#options.descriptors.resource(normalizeFd(fd));
    if (!(resource instanceof KernelWebSocketResource)) {
      throw errnoError(WS_ERRNO.EBADF);
    }
    return resource;
  }

  #route(
    resource: KernelWebSocketResource,
    url: URL,
    authority: string,
    headers: readonly KernelWebSocketHeader[],
  ): void {
    queueMicrotask(() => {
      if (resource.disposed) return;
      void Promise.resolve()
        .then(() => {
          const requestHeaders = new Headers();
          for (const [name, value] of headers) requestHeaders.append(name, value);
          const request = new Request(url.href, {
            method: "GET",
            headers: requestHeaders,
            signal: resource.signal,
          });
          return this.#options.route({
            request,
            headers,
            authority,
            signal: resource.signal,
          });
        })
        .then((response) => normalizeWebSocketRouteResponse(response, resource.signal))
        .then((response) => resource.accept(response))
        .catch((error: unknown) => resource.routeFailed(error));
    });
  }

  #safely(operation: () => number): number {
    try {
      return operation();
    } catch (error) {
      return descriptorErrno(error);
    }
  }
}

function wasmU32(value: number): number {
  return value >>> 0;
}

function normalizeFd(fd: number): number {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) throw errnoError(WS_ERRNO.EBADF);
  return fd;
}

function hasRange(memory: WebAssembly.Memory, offset: number, length: number): boolean {
  return offset <= memory.buffer.byteLength && length <= memory.buffer.byteLength - offset;
}

function writeU32(memory: WebAssembly.Memory, offset: number, value: number): void {
  new DataView(memory.buffer).setUint32(offset, value >>> 0, true);
}

function errnoError(errno: number): Error & { readonly errno: number } {
  return Object.assign(new Error("Kernel WebSocket operation failed"), { errno });
}

function descriptorErrno(error: unknown): KernelWebSocketWireError {
  if (typeof error === "object" && error !== null) {
    if ("errno" in error && typeof error.errno === "number") {
      return error.errno as KernelWebSocketWireError;
    }
    if ("code" in error && typeof error.code === "string") {
      switch (error.code) {
        case "EBADF":
          return WS_ERRNO.EBADF;
        case "EINVAL":
          return WS_ERRNO.EINVAL;
        case "EMFILE":
          return WS_ERRNO.ENOBUFS;
        case "ENOBUFS":
          return WS_ERRNO.ENOBUFS;
        case "ENOTSUP":
          return WS_ERRNO.ENOTSUP;
        case "EPIPE":
          return WS_ERRNO.EPIPE;
        case "EMSGSIZE":
          return WS_ERRNO.EMSGSIZE;
        default:
          return WS_ERRNO.EIO;
      }
    }
  }
  return WS_ERRNO.EIO;
}
