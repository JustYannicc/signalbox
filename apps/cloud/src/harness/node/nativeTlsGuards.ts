import {
  createUnsupportedNodeBuiltin,
  NodeBuiltinUnsupportedError,
} from "../../isolate/NodeBuiltinFailure.ts";

// The pinned Workerd transport cannot expose these TLS operations or measurements.
const unavailableMethods = [
  "disableRenegotiation",
  "renegotiate",
  "exportKeyingMaterial",
  "setMaxSendFragment",
  "setSession",
  "getPeerCertificate",
  "getCertificate",
  "getPeerX509Certificate",
  "getX509Certificate",
  "setKeyCert",
  "getCipher",
  "getSharedSigalgs",
  "getEphemeralKeyInfo",
  "getFinished",
  "getPeerFinished",
  "getProtocol",
  "getSession",
  "getTLSTicket",
  "isSessionReused",
  "enableTrace",
] as const;

export function guardWorkerdTlsOptions(builtin: string, options: readonly object[]) {
  for (const option of options) {
    for (const name of ["enableTrace", "isServer", "server", "requestCert", "requestOCSP"]) {
      if (Reflect.get(option, name))
        throw new NodeBuiltinUnsupportedError(`${builtin} option ${name}`);
    }
    for (const name of [
      "ALPNProtocols",
      "SNICallback",
      "secureContext",
      "pskCallback",
      "checkServerIdentity",
      "minDHSize",
    ]) {
      if (Reflect.get(option, name) !== undefined)
        throw new NodeBuiltinUnsupportedError(`${builtin} option ${name}`);
    }
    if (Reflect.get(option, "rejectUnauthorized") === false)
      throw new NodeBuiltinUnsupportedError(`${builtin} option rejectUnauthorized=false`);
  }
}

export function guardWorkerdTlsSocket(socket: unknown) {
  if (typeof socket !== "object" || socket === null)
    throw new TypeError("Workerd TLS did not return a socket");
  // Own methods cover sockets returned by native connect without mutating native prototypes.
  for (const member of unavailableMethods) {
    Object.defineProperty(socket, member, {
      value: createUnsupportedNodeBuiltin(
        `tls.TLSSocket.${member}`,
        `Workerd cannot implement tls.TLSSocket.${member}; this remains an open TLS transport obligation.`,
      ),
      configurable: true,
      writable: true,
    });
  }
  return socket;
}
