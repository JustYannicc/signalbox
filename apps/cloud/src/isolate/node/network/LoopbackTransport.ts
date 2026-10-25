export interface DuplexTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly close?: () => void | Promise<void>;
  readonly localAddress?: string | null;
  readonly localPort?: number;
  readonly remoteAddress?: string | null;
  readonly remotePort?: number;
}

export function createLoopbackTransportPair(options: {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}): readonly [DuplexTransport, DuplexTransport] {
  const clientToServer = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  const serverToClient = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
  return [
    {
      readable: serverToClient.readable,
      writable: clientToServer.writable,
      localAddress: options.localAddress,
      localPort: options.localPort,
      remoteAddress: options.remoteAddress,
      remotePort: options.remotePort,
    },
    {
      readable: clientToServer.readable,
      writable: serverToClient.writable,
      localAddress: options.remoteAddress,
      localPort: options.remotePort,
      remoteAddress: options.localAddress,
      remotePort: options.localPort,
    },
  ];
}
