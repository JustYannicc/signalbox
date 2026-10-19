export function isLocalHost(input: string): boolean {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost." ||
    host === "0.0.0.0"
  )
    return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    return parts.every((part) => part <= 255) && parts[0] === 127;
  }

  const unzoned = host.split("%", 1)[0] ?? host;
  if (
    unzoned === "::" ||
    unzoned === "0:0:0:0:0:0:0:0" ||
    unzoned === "::1" ||
    unzoned === "0:0:0:0:0:0:0:1"
  )
    return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(unzoned);
  return mapped ? isLocalHost(mapped[1]!) : false;
}

export function authorityHost(host: string): string {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped;
}

export function parsePort(value: unknown, defaultPort: number): number {
  const port = value === undefined || value === null || value === "" ? defaultPort : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw Object.assign(
      new RangeError(`Port must be an integer between 0 and 65535. Received ${String(value)}`),
      {
        code: "ERR_SOCKET_BAD_PORT",
      },
    );
  }
  return port;
}

export function parseSocketAddress(value: string | null | undefined): {
  address?: string;
  port?: number;
} {
  if (!value) return {};
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  const match = ipv6 ?? /^([^:]+):(\d+)$/.exec(value);
  return match ? { address: match[1]!, port: Number(match[2]!) } : { address: value };
}
