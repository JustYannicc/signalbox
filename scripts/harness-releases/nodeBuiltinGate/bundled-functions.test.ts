import { describe, expect, it } from "vite-plus/test";
import { assertPackagedBuiltinCoverage, scanBuiltinSource } from "../nodeBuiltinGate.ts";

const source = (text: string) => ({ name: "release.js", source: text });
const helpers = `
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[Object.getOwnPropertyNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __defProp = Object.defineProperty;
  var __getProtoOf = Object.getPrototypeOf;
  var __copyProps = (to, from, except, desc) => {
    if (from && (typeof from === "object" || typeof from === "function")) {
      for (let key of Object.getOwnPropertyNames(from)) {
        if (!Object.prototype.hasOwnProperty.call(to, key) && key !== except) {
          __defProp(to, key, {
            get: () => from[key],
            enumerable: !(desc = Object.getOwnPropertyDescriptor(from, key)) || desc.enumerable,
          });
        }
      }
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (
    target = mod != null ? Object.create(__getProtoOf(mod)) : {},
    __copyProps(
      isNodeMode || !mod || !mod.__esModule
        ? __defProp(target, "default", { value: mod, enumerable: true })
        : target,
      mod,
    )
  );
`;
const bridgeFacade = (
  builtin: string,
  requireBinding = `require_${builtin}`,
  namespaceBinding = `import_${builtin}`,
  commonJsHelper = "__commonJS",
  interopHelper = "__toESM",
) => `
  var ${requireBinding} = ${commonJsHelper}({
    "signalbox-layer:${builtin}"(exports2, module2) {
      var bridge = globalThis[Symbol.for("signalbox.nodeBridge.v1")];
      module2.exports = bridge.require("${builtin}");
    },
  });
  var ${namespaceBinding} = ${interopHelper}(${requireBinding}());
`;

const runtimeProfile = {
  systemIdentity: {},
  processIdentity: {},
  filesystem: { posixPolicy: false, setUmask: false },
  cpu: { execution: false, processAccounting: false },
};

describe("bundled builtin function references", () => {
  it("keeps data properties on bundled builtins outside function coverage", () => {
    const scan = scanBuiltinSource(
      source(`${helpers}
      ${bridgeFacade("process", "require_process", "import_process")}
      ${bridgeFacade("path", "require_path", "import_path")}
      ${bridgeFacade("tls", "require_tls", "import_tls")}
      const name = import_process.default.env[key];
      name.startsWith("()");
      import_path.sep.toLowerCase();
      import_path.win32.sep.toLowerCase();
      import_tls.rootCertificates.some(check);
      import_process.default.cwd();
    `),
    );
    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["process", ["cwd"]]]);
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("follows the captured bridge facade through CommonJS and ESM interop", () => {
    const scan = scanBuiltinSource(
      source(
        `${helpers}${bridgeFacade("os", "require_os", "import_os22")}import_os22.default.release().split(".");`,
      ),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["os", ["release"]]]);
    expect(scan.functionAmbiguities).toEqual([]);

    const aliases = scanBuiltinSource(
      source(`${helpers}
        var wrapLayer = __commonJS;
        var exposeNamespace = __toESM;
        ${bridgeFacade("os", "loadOs", "osNamespace", "wrapLayer", "exposeNamespace")}
        osNamespace.default.release();
      `),
    );
    expect(
      aliases.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["os", ["release"]]]);
  });

  it("makes an unsupported facade call fail at the packaged gate", async () => {
    await expect(
      assertPackagedBuiltinCoverage(
        [
          source(
            `${helpers}${bridgeFacade("os", "require_os", "import_os22")}import_os22.default.release();`,
          ),
        ],
        {
          modules: ["os"],
          functions: [
            {
              specifier: "os",
              memberPath: ["release"],
              status: "unsupported",
              evidence: "fixture capability is explicitly unsupported",
            },
          ],
          profile: runtimeProfile,
        },
      ),
    ).rejects.toThrow("unsupported-functions=os.release");
  });

  it("keeps a facade call unknown when the inventory has no capability record", async () => {
    await expect(
      assertPackagedBuiltinCoverage(
        [
          source(
            `${helpers}${bridgeFacade("os", "require_os", "import_os22")}import_os22.default.release();`,
          ),
        ],
        { modules: ["os"], functions: [], profile: runtimeProfile },
      ),
    ).rejects.toThrow("unknown-functions=os.release");
  });

  it("resolves renamed helpers and facade bindings by structure and scope", () => {
    const renamedHelpers = helpers
      .replaceAll("__commonJS", "makeLayer")
      .replaceAll("__toESM", "toNamespace");
    const scan = scanBuiltinSource(
      source(
        `${renamedHelpers}${bridgeFacade("os", "loadOs", "osNamespace", "makeLayer", "toNamespace")}osNamespace.default.release();`,
      ),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["os", ["release"]]]);
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("tracks default, named, namespace, destructured, constructor and call/apply/bind uses", () => {
    const scan = scanBuiltinSource(
      source(`${helpers}
        ${bridgeFacade("os", "require_os", "import_os22")}
        ${bridgeFacade("url", "require_url", "import_url")}
        import_os22.default.release();
        const osNamespace = import_os22;
        osNamespace.default.loadavg();
        const defaultOs = import_os22.default;
        defaultOs.hostname();
        const { uptime: uptimeAlias } = import_os22.default;
        uptimeAlias();
        const { availableParallelism } = import_os22;
        availableParallelism();
        import_os22.default.release.call(import_os22.default);
        import_os22.default.platform.apply(import_os22.default, []);
        const boundArch = import_os22.default.arch.bind(import_os22.default);
        boundArch();
        new import_url.URL("https://signalbox.test");
      `),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([
      ["os", ["arch"]],
      ["os", ["availableParallelism"]],
      ["os", ["hostname"]],
      ["os", ["loadavg"]],
      ["os", ["platform"]],
      ["os", ["release"]],
      ["os", ["release"]],
      ["os", ["uptime"]],
      ["url", ["URL"]],
    ]);
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("keeps direct CommonJS exports and fs, os and path facades in function coverage", () => {
    const scan = scanBuiltinSource(
      source(`${helpers}
        ${bridgeFacade("os", "require_os", "import_os")}
        ${bridgeFacade("fs", "require_fs", "import_fs")}
        ${bridgeFacade("path", "require_path", "import_path")}
        const Gn58 = require_os();
        Gn58.release();
        import_os.default.hostname();
        import_fs.default.readFileSync("/tmp/file");
        import_path.default.join("/tmp", "file");
      `),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([
      ["fs", ["readFileSync"]],
      ["os", ["hostname"]],
      ["os", ["release"]],
      ["path", ["join"]],
    ]);
    expect(scan.requiredSpecifiers).toEqual(["fs", "os", "path"]);
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("keeps malformed, shadowed and reassigned facade flows uncertain", () => {
    const malformed = scanBuiltinSource(
      source(`
        var __commonJS = (callback) => callback;
        var __toESM = (module) => module;
        ${bridgeFacade("os", "require_os", "import_os22")}
        import_os22.default.release();
      `),
    );
    expect(malformed.requiredFunctions).toEqual([]);
    expect(malformed.functionAmbiguities.map(({ specifier }) => specifier)).toEqual(["os.release"]);

    const shadowed = scanBuiltinSource(
      source(`${helpers}${bridgeFacade("os", "require_os", "import_os22")}
        function unrelated(__commonJS, __toESM, require_os, import_os22) {
          import_os22.default.release();
          require_os().release();
        }
      `),
    );
    expect(shadowed.requiredFunctions).toEqual([]);
    expect(shadowed.functionAmbiguities).toEqual([]);

    const reassigned = scanBuiltinSource(
      source(`${helpers}${bridgeFacade("os", "require_os", "import_os22")}
        require_os = () => ({});
        import_os22.default.release();
      `),
    );
    expect(reassigned.requiredFunctions).toEqual([]);
    expect(reassigned.functionAmbiguities.map(({ specifier }) => specifier)).toEqual([
      "os.release",
    ]);

    const helperReassigned = scanBuiltinSource(
      source(`${helpers}
        var wrapLayer = __commonJS;
        wrapLayer = (callback) => callback;
        var require_os = wrapLayer({
          "signalbox-layer:os"(exports2, module2) {
            var bridge = globalThis[Symbol.for("signalbox.nodeBridge.v1")];
            module2.exports = bridge.require("os");
          },
        });
        var import_os22 = __toESM(require_os());
        import_os22.default.release();
      `),
    );
    expect(helperReassigned.requiredFunctions).toEqual([]);
    expect(helperReassigned.functionAmbiguities.map(({ specifier }) => specifier)).toEqual([
      "os.release",
    ]);
  });
});
