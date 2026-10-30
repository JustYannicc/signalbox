import { DEFAULT_NODE_NATIVE_MODULES } from "../../NodeNativeModules.ts";
import { getNodeBuiltinCapability } from "../../../isolate/NodeBuiltinCapabilities.ts";

export * from "../../../FixtureWorkerExports.ts";

export default {
  fetch() {
    const paths = [
      ["http2", "connect"],
      ["perf_hooks", "monitorEventLoopDelay"],
      ["tls", "createSecureContext"],
      ["tls", "setDefaultCACertificates"],
      ["util", "getSystemErrorName"],
      ["v8", "getHeapSpaceStatistics"],
      ["v8", "getHeapStatistics"],
      ["vm", "Script"],
      ["vm", "SourceTextModule"],
      ["vm", "SyntheticModule"],
      ["vm", "createContext"],
      ["vm", "runInContext"],
      ["vm", "runInThisContext"],
    ];
    return Response.json(
      paths.map(([specifier, member]) => {
        const module = DEFAULT_NODE_NATIVE_MODULES[specifier!]!;
        const callable: unknown = Reflect.get(module, member!);
        if (typeof callable !== "function") throw new TypeError(`Missing ${specifier}.${member}`);
        let caught: unknown;
        try {
          if (specifier === "vm" && /Module|Script/.test(member!))
            Reflect.construct(callable, [""]);
          else Reflect.apply(callable, module, []);
        } catch (error) {
          caught = error;
        }
        return {
          builtin: `${specifier}.${member}`,
          capability: getNodeBuiltinCapability(callable),
          threw: caught instanceof Error,
          code: caught instanceof Error ? Reflect.get(caught, "code") : undefined,
        };
      }),
    );
  },
};
