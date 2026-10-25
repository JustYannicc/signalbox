export type NetworkError = Error & {
  readonly code: string;
  readonly address?: string;
  readonly port?: number;
  readonly syscall?: string;
};

export function networkError(
  code: string,
  message: string,
  details: Pick<NetworkError, "address" | "port" | "syscall"> = {},
): NetworkError {
  return Object.assign(new Error(message), { code, ...details });
}

export function addressInUse(address: string, port: number): NetworkError {
  return networkError(
    "EADDRINUSE",
    `listen EADDRINUSE: address already in use ${address}:${port}`,
    {
      address,
      port,
      syscall: "listen",
    },
  );
}

export function connectionRefused(address: string, port: number): NetworkError {
  return networkError("ECONNREFUSED", `connect ECONNREFUSED ${address}:${port}`, {
    address,
    port,
    syscall: "connect",
  });
}

export function unsupportedNetworkOperation(operation: string): NetworkError {
  return networkError("ENOTSUP", `${operation} is not supported by this Node network bridge`);
}

export function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";
}
