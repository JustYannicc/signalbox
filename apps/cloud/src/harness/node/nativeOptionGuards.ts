import { markNodeBuiltinCapability } from "../../isolate/NodeBuiltinCapabilities.ts";
import { NodeBuiltinUnsupportedError } from "../../isolate/NodeBuiltinFailure.ts";
import { overrideNativeModule } from "./nativeModuleOverrides.ts";
import { guardWorkerdCrypto } from "./nativeCryptoGuards.ts";
import { guardWorkerdTlsOptions, guardWorkerdTlsSocket } from "./nativeTlsGuards.ts";

const ignoredTlsOptions = [
  "ca",
  "cert",
  "key",
  "pfx",
  "passphrase",
  "crl",
  "ciphers",
  "sigalgs",
  "dhparam",
  "ecdhCurve",
  "minVersion",
  "maxVersion",
  "secureOptions",
  "session",
  "sessionIdContext",
  "clientCertEngine",
  "privateKeyEngine",
  "privateKeyIdentifier",
] as const;

function optionsIn(args: readonly unknown[]) {
  return args.filter((value): value is object => typeof value === "object" && value !== null);
}

function isNativeCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function rejectOptions(builtin: string, options: readonly object[], names: readonly string[]) {
  for (const option of options) {
    for (const name of names) {
      if (Reflect.get(option, name) !== undefined) {
        throw new NodeBuiltinUnsupportedError(`${builtin} option ${name}`);
      }
    }
  }
}

/** Only the default Workerd modules use these guards; supplied runtime modules keep their behavior. */
export function guardWorkerdNativeOptions(modules: Record<string, object>) {
  const replace = (specifier: string, member: string, value: unknown) => {
    const native = modules[specifier];
    if (!native) throw new TypeError(`Missing Workerd module: ${specifier}`);
    modules[specifier] = overrideNativeModule(native, { [member]: value });
  };

  for (const specifier of ["tls", "net"] as const) {
    const module = modules[specifier];
    if (!module) throw new TypeError(`Missing Workerd module: ${specifier}`);
    const members =
      specifier === "tls" ? ["connect", "TLSSocket"] : ["connect", "createConnection", "Socket"];
    const aliases = new Map<object, object>();
    for (const member of members) {
      const native: unknown = Reflect.get(module, member);
      if (!isNativeCallable(native)) throw new TypeError(`Missing ${specifier}.${member}`);
      const guard = (args: readonly unknown[]) => {
        const options = optionsIn(member === "TLSSocket" ? args.slice(1) : args);
        if (specifier === "tls") {
          rejectOptions(`${specifier}.${member}`, options, ignoredTlsOptions);
          guardWorkerdTlsOptions(`${specifier}.${member}`, options);
        }
        if (specifier === "net")
          rejectOptions(`${specifier}.${member}`, options, [
            "fd",
            "autoSelectFamily",
            "autoSelectFamilyAttemptTimeout",
          ]);
      };
      const existing = aliases.get(native);
      const guarded =
        existing ??
        markNodeBuiltinCapability(
          new Proxy(native, {
            apply(target, receiver, args) {
              guard(args);
              const result: unknown = Reflect.apply(target, receiver, args);
              return specifier === "tls" ? guardWorkerdTlsSocket(result) : result;
            },
            construct(target, args, newTarget) {
              guard(args);
              const result: object = Reflect.construct(target, args, newTarget);
              return specifier === "tls" ? guardWorkerdTlsSocket(result) : result;
            },
          }),
          {
            status: "conditional",
            evidence: `The Workerd ${specifier}.${member} client keeps native transport behavior and rejects ignored options with ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED. Connectivity still depends on the selected transport and platform.`,
          },
        );
      aliases.set(native, guarded);
      replace(specifier, member, guarded);
    }
  }

  const timers = modules["timers/promises"];
  if (!timers) throw new TypeError("Missing Workerd timers/promises");
  const nativeTimeout: unknown = Reflect.get(timers, "setTimeout");
  if (typeof nativeTimeout !== "function") throw new TypeError("Missing promise setTimeout");
  const setTimeout = markNodeBuiltinCapability(
    async (...args: unknown[]) => {
      const options = args[2];
      if (
        typeof options === "object" &&
        options !== null &&
        Reflect.get(options, "ref") === false
      ) {
        throw new NodeBuiltinUnsupportedError("timers/promises.setTimeout option ref=false");
      }
      return Reflect.apply(nativeTimeout, timers, args);
    },
    {
      status: "conditional",
      evidence:
        "Promise timers preserve native delays and cancellation. ref=false rejects with ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED because Workerd has no Node event-loop lifetime.",
    },
  );
  replace("timers/promises", "setTimeout", setTimeout);
  const legacyTimers = modules.timers;
  const nested: unknown = legacyTimers && Reflect.get(legacyTimers, "promises");
  if (nested !== undefined) replace("timers", "promises", modules["timers/promises"]);

  const crypto = modules.crypto;
  if (!crypto) throw new TypeError("Missing Workerd crypto");
  modules.crypto = guardWorkerdCrypto(crypto);
}
