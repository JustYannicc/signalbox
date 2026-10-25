export function dnsError(code: string, syscall: string, hostname: string) {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), {
    code,
    errno: code,
    syscall,
    hostname,
  });
}

export function invalid(name: string, value: unknown): never {
  throw Object.assign(new TypeError(`Invalid ${name}: ${String(value)}`), {
    code: "ERR_INVALID_ARG_VALUE",
  });
}

export function unsupported(operation: string): never {
  throw dnsError("ENOTSUP", operation, "DNS-over-HTTPS does not provide this capability");
}

export function validateHostname(hostname: string) {
  if (typeof hostname !== "string") invalid("hostname", hostname);
  if (hostname.length === 0) throw dnsError("ENOTFOUND", "query", hostname);
}
