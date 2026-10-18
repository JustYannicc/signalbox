// @effect-diagnostics nodeBuiltinImport:off - The adapter patches the host Node response writer used by facet servers.
import * as NodeHttp from "node:http";

const PATCH_MARKER = Symbol.for("signalbox.nodeNetwork.responseHeaders.v1");

/** Workerd's native writer assumes ordinary objects; Node callers may pass null-prototype headers. */
export function patchResponseHeaders(response: object): void {
  if (Object.hasOwn(response, PATCH_MARKER)) return;
  const writeHead = Reflect.get(NodeHttp.ServerResponse.prototype, "writeHead");
  if (typeof writeHead !== "function")
    throw new TypeError("Native HTTP response writer is unavailable");
  const patched = function (this: object, ...args: unknown[]) {
    const status = args[0];
    const reason = args[1];
    const fields = typeof reason === "object" && reason !== null ? reason : args[2];
    if (
      typeof fields === "object" &&
      fields !== null &&
      !Array.isArray(fields) &&
      (Object.getPrototypeOf(fields) !== Object.prototype ||
        Object.hasOwn(fields, "hasOwnProperty"))
    ) {
      const setHeader = Reflect.get(this, "setHeader");
      if (typeof setHeader !== "function")
        throw new TypeError("Native HTTP response header setter is unavailable");
      for (const [name, value] of Object.entries(fields))
        Reflect.apply(setHeader, this, [name, value]);
      return Reflect.apply(
        writeHead,
        this,
        typeof reason === "string" ? [status, reason] : [status],
      );
    }
    return Reflect.apply(writeHead, this, args);
  };
  Object.defineProperty(response, "writeHead", {
    value: patched,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(response, PATCH_MARKER, { value: true });
}
