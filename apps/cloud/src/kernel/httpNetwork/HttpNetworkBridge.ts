import { hostname, port } from "./Address.ts";
import { HttpSocket } from "./HttpSocket.ts";
import { receiveHttp } from "./Receive.ts";
import { decodeUtf8, errno, fail, NET_ERRNO, range, readBytes, u32, writeU32 } from "./Memory.ts";
import {
  HTTP_LIMITS,
  type KernelHttpNetworkHostOptions,
  type KernelHttpNetworkImports,
} from "./Types.ts";

export class HttpNetworkBridge {
  readonly imports: KernelHttpNetworkImports;
  readonly #options: KernelHttpNetworkHostOptions;
  readonly #owned = new WeakSet<HttpSocket>();
  readonly #sockets = new Map<HttpSocket, number>();
  readonly #abort: () => void;
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(options: KernelHttpNetworkHostOptions) {
    this.#options = options;
    this.#abort = () => {
      for (const socket of this.#sockets.keys()) socket.abort();
    };
    options.signal.addEventListener("abort", this.#abort, { once: true });
    this.imports = Object.freeze({
      net_socket: (domain, type, protocol, outFd) =>
        this.#guard(() => this.#socket(domain, type, protocol, outFd)),
      net_connect: (fd, address, length) =>
        this.#guard(() => {
          const value = this.#text(address, length, 1024);
          this.#resource(fd).connect(value);
          return 0;
        }),
      net_send: (fd, buffer, length, flags, outSent) =>
        this.#guard(() => {
          const memory = this.#memory();
          range(memory, outSent, 4);
          range(memory, buffer, length);
          if (flags !== 0) fail(NET_ERRNO.NOTSUP);
          if (u32(length) > HTTP_LIMITS.requestWireBytes) fail(NET_ERRNO.MSGSIZE);
          const socket = this.#resource(fd);
          if (this.#memory() !== memory) fail(NET_ERRNO.FAULT);
          const bytes = readBytes(memory, buffer, length);
          writeU32(memory, outSent, 0);
          const sent = socket.send(bytes);
          writeU32(memory, outSent, sent);
          return 0;
        }),
      net_recv: (fd, buffer, length, flags, outReceived) =>
        this.#guard(() =>
          receiveHttp(
            this.#options,
            (value) => this.#resource(value),
            [fd, buffer, length, flags, outReceived],
            false,
          ),
        ),
      net_close: (fd) =>
        this.#guard(() => {
          this.#resource(fd);
          options.descriptors.close(u32(fd));
          return 0;
        }),
      net_getaddrinfo: (host, hostLength, service, serviceLength, family, address, addressLength) =>
        this.#guard(() => {
          this.#alive();
          const memory = this.#memory();
          range(memory, addressLength, 4);
          const hostValue = hostname(this.#text(host, hostLength, 253));
          const portValue = port(this.#text(service, serviceLength, 5));
          if (family !== 0 && family !== 4) fail(NET_ERRNO.NOTSUP);
          const encoded = new TextEncoder().encode(`${hostValue}:${portValue}`);
          if (this.#memory() !== memory) fail(NET_ERRNO.FAULT);
          const capacity = new DataView(memory.buffer).getUint32(u32(addressLength), true);
          if (capacity < encoded.length) {
            writeU32(memory, addressLength, encoded.length);
            return NET_ERRNO.MSGSIZE;
          }
          const offset = range(memory, address, encoded.length);
          new Uint8Array(memory.buffer, offset, encoded.length).set(encoded);
          writeU32(memory, addressLength, encoded.length);
          return 0;
        }),
      net_tls_connect: (fd, host, length) =>
        this.#guard(() => {
          this.#resource(fd).tlsConnect(this.#text(host, length, 253));
          return 0;
        }),
      net_setsockopt: (fd, level, option, value, length) =>
        this.#guard(() => {
          if (level !== 1 || option !== 20) fail(NET_ERRNO.NOTSUP);
          if (length !== 16) fail(NET_ERRNO.INVAL);
          this.#resource(fd).setReceiveTimeout(readBytes(this.#memory(), value, length));
          return 0;
        }),
      net_getsockname: (_fd, _address, _length) => NET_ERRNO.NOTSUP,
      net_getpeername: (_fd, _address, _length) => NET_ERRNO.NOTSUP,
      net_poll: (_fds, _count, _timeoutMs, _outReady) => NET_ERRNO.NOTSUP,
      net_bind: (_fd, _address, _length) => NET_ERRNO.NOTSUP,
      net_listen: (_fd, _backlog) => NET_ERRNO.NOTSUP,
      net_accept: (_fd, _outFd, _address, _length) => NET_ERRNO.NOTSUP,
      net_sendto: (_fd, _buffer, _length, _flags, _address, _addressLength, _outSent) =>
        NET_ERRNO.NOTSUP,
      net_recvfrom: (_fd, _buffer, _length, _flags, _outReceived, _address, _addressLength) =>
        NET_ERRNO.NOTSUP,
      net_validate_socket: (fd) =>
        this.#guard(() => {
          this.#resource(fd).assertOpen();
          return 0;
        }),
    } satisfies KernelHttpNetworkImports);
  }

  getImportObject(): { host_net: WebAssembly.ModuleImports } {
    const wasm = WebAssembly as unknown as {
      Suspending?: new (
        fn: (...args: number[]) => number | Promise<number>,
      ) => WebAssembly.ImportValue;
    };
    if (typeof wasm.Suspending !== "function") {
      throw new Error("Blocking HTTP sockets require WebAssembly JSPI.");
    }
    return {
      host_net: {
        ...this.imports,
        net_recv: new wasm.Suspending((...args) => {
          try {
            return receiveHttp(this.#options, (fd) => this.#resource(fd), args, true);
          } catch (error) {
            return errno(error);
          }
        }),
      },
    };
  }

  dispose(): Promise<void> {
    if (this.#disposal === undefined) {
      const completion = Promise.withResolvers<void>();
      this.#disposal = completion.promise;
      this.#disposed = true;
      void this.#dispose().then(completion.resolve, completion.reject);
    }
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#options.signal.removeEventListener("abort", this.#abort);
    const sockets = [...this.#sockets];
    const errors: unknown[] = [];
    for (const [socket, fd] of sockets) {
      socket.close();
      try {
        // The original fd may have closed while an alias kept this resource alive.
        if (this.#options.descriptors.resource(fd) === socket) this.#options.descriptors.close(fd);
      } catch (error) {
        if (errno(error) !== NET_ERRNO.BADF) errors.push(error);
      }
    }
    await Promise.all(sockets.map(([socket]) => socket.settled));
    if (errors.length > 0) throw new AggregateError(errors, "HTTP descriptor cleanup failed.");
  }

  #socket(domain: number, type: number, protocol: number, outFd: number): number {
    this.#alive();
    const memory = this.#memory();
    range(memory, outFd, 4);
    if (domain !== 1) fail(NET_ERRNO.AFNOSUPPORT);
    if (type !== 6 || protocol !== 0) fail(NET_ERRNO.NOTSUP);
    const socket = new HttpSocket(this.#options.fetch, () => {
      const forget = () => {
        this.#sockets.delete(socket);
      };
      void socket.settled.then(forget, forget);
    });
    this.#owned.add(socket);
    let fd: number | undefined;
    try {
      fd = this.#options.descriptors.register(socket);
      if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) fail(NET_ERRNO.IO);
      if (this.#options.descriptors.resource(fd) !== socket) fail(NET_ERRNO.IO);
      // Generic resource registrations default to NONBLOCK; POSIX sockets start blocking.
      this.#options.descriptors.table.get(fd).flags = 0;
      this.#alive();
      if (this.#memory() !== memory) fail(NET_ERRNO.FAULT);
      writeU32(memory, outFd, fd);
      this.#sockets.set(socket, fd);
      return 0;
    } catch (error) {
      socket.close();
      if (fd !== undefined) {
        try {
          if (this.#options.descriptors.resource(fd) === socket)
            this.#options.descriptors.close(fd);
        } catch {
          /* A failed allocation must not close a reused descriptor. */
        }
      }
      throw error;
    }
  }

  #resource(value: number): HttpSocket {
    const fd = u32(value);
    if (fd > 0x7fff_ffff) fail(NET_ERRNO.BADF);
    const resource = this.#options.descriptors.resource(fd);
    if (!(resource instanceof HttpSocket) || !this.#owned.has(resource)) fail(NET_ERRNO.NOTSOCK);
    return resource;
  }

  #memory(): WebAssembly.Memory {
    let memory: WebAssembly.Memory;
    try {
      memory = this.#options.memory();
    } catch {
      return fail(NET_ERRNO.IO);
    }
    if (!(memory instanceof WebAssembly.Memory)) fail(NET_ERRNO.IO);
    return memory;
  }

  #text(pointer: number, length: number, limit: number): string {
    const memory = this.#memory();
    range(memory, pointer, length);
    if (u32(length) > limit) fail(NET_ERRNO.MSGSIZE);
    return decodeUtf8(readBytes(memory, pointer, length));
  }

  #alive(): void {
    if (this.#disposed || this.#options.signal.aborted) fail(NET_ERRNO.CANCELED);
  }
  #guard(operation: () => number): number {
    try {
      return operation();
    } catch (error) {
      return errno(error);
    }
  }
}
