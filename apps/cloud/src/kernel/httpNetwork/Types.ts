import type { KernelDescriptors } from "../KernelDescriptors.ts";

export interface KernelHttpNetworkHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly descriptors: Pick<
    KernelDescriptors,
    "register" | "resource" | "close" | "table" | "wakes"
  >;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly signal: AbortSignal;
}

export interface KernelHttpNetworkImports extends Readonly<
  Record<string, (...args: number[]) => number>
> {
  readonly net_socket: (domain: number, type: number, protocol: number, outFd: number) => number;
  readonly net_connect: (fd: number, address: number, length: number) => number;
  readonly net_send: (
    fd: number,
    buffer: number,
    length: number,
    flags: number,
    outSent: number,
  ) => number;
  readonly net_recv: (
    fd: number,
    buffer: number,
    length: number,
    flags: number,
    outReceived: number,
  ) => number;
  readonly net_close: (fd: number) => number;
  readonly net_getaddrinfo: (
    host: number,
    hostLength: number,
    port: number,
    portLength: number,
    family: number,
    address: number,
    addressLength: number,
  ) => number;
  readonly net_tls_connect: (fd: number, hostname: number, length: number) => number;
  readonly net_setsockopt: (
    fd: number,
    level: number,
    option: number,
    value: number,
    length: number,
  ) => number;
  readonly net_getsockname: (fd: number, address: number, length: number) => number;
  readonly net_getpeername: (fd: number, address: number, length: number) => number;
  readonly net_poll: (fds: number, count: number, timeoutMs: number, outReady: number) => number;
  readonly net_bind: (fd: number, address: number, length: number) => number;
  readonly net_listen: (fd: number, backlog: number) => number;
  readonly net_accept: (fd: number, outFd: number, address: number, length: number) => number;
  readonly net_sendto: (
    fd: number,
    buffer: number,
    length: number,
    flags: number,
    address: number,
    addressLength: number,
    outSent: number,
  ) => number;
  readonly net_recvfrom: (
    fd: number,
    buffer: number,
    length: number,
    flags: number,
    outReceived: number,
    address: number,
    addressLength: number,
  ) => number;
  readonly net_validate_socket: (fd: number) => number;
}

export const HTTP_LIMITS = {
  headerBytes: 64 * 1024,
  headerCount: 1024,
  requestBodyBytes: 16 * 1024 * 1024,
  requestWireBytes: 32 * 1024 * 1024,
  responseQueueBytes: 64 * 1024,
  responseSourceChunkBytes: 16 * 1024 * 1024,
  responseFrameBytes: 16 * 1024,
} as const;
