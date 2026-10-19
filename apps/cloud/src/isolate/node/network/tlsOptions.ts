const TLS_HANDSHAKE_OPTIONS = [
  "key",
  "cert",
  "pfx",
  "ca",
  "passphrase",
  "secureOptions",
  "requestCert",
  "rejectUnauthorized",
  "ALPNProtocols",
  "SNICallback",
  "secureContext",
  "minVersion",
  "maxVersion",
  "ciphers",
] as const;

export function hasTlsHandshakeOptions(value: object): boolean {
  return TLS_HANDSHAKE_OPTIONS.some((name) => Object.hasOwn(value, name));
}
