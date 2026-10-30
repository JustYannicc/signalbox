// @effect-diagnostics nodeBuiltinImport:off - Exercise the native stream exports used by the Node personality.
import { DEFAULT_NODE_NATIVE_MODULES } from "../../NodeNativeModules.ts";
import { getNodeBuiltinCapability } from "../../../isolate/NodeBuiltinCapabilities.ts";
import * as NodeStream from "node:stream";
import * as NodeStreamConsumers from "node:stream/consumers";
import { createNodePath } from "../../../isolate/NodePath.ts";

export * from "../../../FixtureWorkerExports.ts";

export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/debuglog") {
      const util = DEFAULT_NODE_NATIVE_MODULES.util!;
      const debuglog = Reflect.get(util, "debuglog");
      const lines: string[] = [];
      const originalWrite = process.stderr.write;
      const originalDebug = process.env.NODE_DEBUG;
      process.stderr.write = (text: string | Uint8Array) => {
        lines.push(String(text));
        return true;
      };
      process.env.NODE_DEBUG = "guest*,literal.dot";
      try {
        debuglog("other")("hidden");
        debuglog("guest-io")("read %d bytes", 7);
        debuglog("literal.dot")("included");
        debuglog("literalXdot")("hidden");
        return Response.json({
          lines,
          pid: process.pid,
          capability: getNodeBuiltinCapability(debuglog),
        });
      } finally {
        process.stderr.write = originalWrite;
        if (originalDebug === undefined) delete process.env.NODE_DEBUG;
        else process.env.NODE_DEBUG = originalDebug;
      }
    }
    if (new URL(request.url).pathname === "/native-behavior") {
      const methods = Reflect.get(DEFAULT_NODE_NATIVE_MODULES.http!, "METHODS");
      if (Reflect.get(DEFAULT_NODE_NATIVE_MODULES.stream!, "Duplex") !== NodeStream.Duplex) {
        throw new Error("The tested Duplex is not the public runtime export");
      }
      const duplex = new NodeStream.Duplex({
        read() {},
        write(chunk, _encoding, done) {
          this.push(chunk);
          done();
        },
        final(done) {
          this.push(null);
          done();
        },
      });
      const output = NodeStreamConsumers.buffer(duplex);
      duplex.end("native duplex bytes");
      const path = createNodePath({ cwd: "/session", chdir() {} });
      const pathBehavior = ["posix", "win32"].map((flavor) => {
        const module = flavor === "posix" ? path.posix : path.win32;
        const sample = flavor === "posix" ? "/a/../b/report.txt" : "C:\\a\\..\\b\\report.txt";
        return {
          flavor,
          basename: module.basename(sample, ".txt"),
          dirname: module.dirname(sample),
          extname: module.extname(sample),
          absolute: module.isAbsolute(sample),
          relative: module.isAbsolute("relative"),
          join: module.join("a", "..", "b"),
          normalize: module.normalize(sample),
          parse: module.parse(sample),
        };
      });
      return Response.json({
        hasGet: methods.includes("GET"),
        hasInventedMethod: methods.includes("SIGNALBOX_INVALID_METHOD"),
        duplex: (await output).toString(),
        pathBehavior,
        resolved: path.resolve("src"),
        relative: path.relative("a", "b"),
      });
    }
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
      ["vm", "isContext"],
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
