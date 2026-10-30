import { describe, expect, it } from "vite-plus/test";
import { captureWorkerdBuiltinInventory } from "./workerdBuiltinInventory.ts";

describe("native builtin inventory", () => {
  it("keeps the 35 retained conditional paths explicit after runtime corrections", async () => {
    const paths = [
      "async_hooks.AsyncResource",
      "crypto.X509Certificate",
      "crypto.createPrivateKey",
      "crypto.createPublicKey",
      "crypto.generateKeyPairSync",
      "crypto.sign",
      "crypto.verify",
      "fs.createReadStream",
      "fs.createWriteStream",
      "fs.unwatchFile",
      "fs.watch",
      "fs.watchFile",
      "fs/promises.glob",
      "fs/promises.opendir",
      "http.Agent",
      "http.createServer",
      "http.request",
      "https.Agent",
      "https.request",
      "net.Socket",
      "net.connect",
      "net.createConnection",
      "net.createServer",
      "timers/promises.setTimeout",
      "tls.connect",
      "util.debuglog",
      "zlib.createBrotliDecompress",
      "zlib.createGunzip",
      "zlib.createInflate",
      "zlib.createUnzip",
      "zlib.createZstdDecompress",
      "zlib.deflateRawSync",
      "zlib.deflateSync",
      "zlib.gzipSync",
      "zlib.inflateRawSync",
    ];
    const unavailable = new Set([
      "http.Agent",
      "http.createServer",
      "https.Agent",
      "net.createServer",
    ]);
    const rows = paths.map((path) => {
      const [specifier, ...memberPath] = path.split(".");
      return { specifier: specifier!, memberPath };
    });
    const result = await captureWorkerdBuiltinInventory(rows);
    expect(rows).toHaveLength(35);
    expect(result).toMatchObject({
      functions: rows.map((row, index) => ({
        ...row,
        status: unavailable.has(paths[index]!)
          ? "unsupported"
          : paths[index] === "util.debuglog"
            ? "supported"
            : "conditional",
        ...(unavailable.has(paths[index]!)
          ? { failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" } }
          : {}),
      })),
    });
  });

  it("dispositions the retained unknown paths without upgrading limited or unavailable calls", async () => {
    const expected = {
      supported: [
        "http.METHODS.includes",
        "stream.Duplex",
        "tty.isatty",
        "path.basename",
        "path.dirname",
        "path.extname",
        "path.isAbsolute",
        "path.join",
        "path.normalize",
        "path.parse",
        "path.relative",
        "path.resolve",
        "path.posix.basename",
        "path.posix.dirname",
        "path.posix.isAbsolute",
        "path.posix.join",
        "path.posix.normalize",
        "path.posix.relative",
        "path.posix.resolve",
        "path.win32.basename",
        "path.win32.dirname",
        "path.win32.isAbsolute",
        "path.win32.join",
        "path.win32.normalize",
        "path.win32.parse",
        "path/posix.join",
        "path/win32.basename",
        "path/win32.dirname",
        "path/win32.isAbsolute",
        "path/win32.join",
        "process.stdin.pause",
        "process.stdin.resume",
        "process.stdin.unshift",
        "process.stdout.off",
      ],
      conditional: [
        "child_process.exec",
        "child_process.execFile",
        "child_process.spawn",
        "dns.lookup",
        "dns.promises.lookup",
        "dns/promises.Resolver",
        "dns/promises.lookup",
        "module.createRequire",
        "path.win32.relative",
        "path.win32.resolve",
        "path.win32.toNamespacedPath",
        "readline.createInterface",
        "tls.TLSSocket",
      ],
      unsupported: [
        "child_process.ChildProcess",
        "child_process.execFileSync",
        "child_process.execSync",
        "child_process.spawnSync",
        "tty.ReadStream",
        "vm.isContext",
      ],
    } as const;
    const rows = Object.entries(expected).flatMap(([status, paths]) =>
      paths.map((path) => {
        const [specifier, ...memberPath] = path.split(".");
        return { specifier: specifier!, memberPath, status };
      }),
    );
    expect(rows).toHaveLength(53);
    const result = await captureWorkerdBuiltinInventory(rows);
    expect(result).toMatchObject({
      functions: rows.map((row) => ({
        ...row,
        ...(row.status === "unsupported"
          ? {
              failure: {
                kind: "named-error",
                code: row.specifier === "vm" ? "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" : "ENOTSUP",
              },
            }
          : {}),
      })),
    });
  });

  it("inspects the Workerd personality instead of accepting Node's callable stubs", async () => {
    const result = await captureWorkerdBuiltinInventory([
      { specifier: "crypto", memberPath: ["createHash"] },
      { specifier: "http2", memberPath: ["connect"] },
      { specifier: "net", memberPath: ["connect"] },
      { specifier: "vm", memberPath: ["SourceTextModule"] },
      { specifier: "process", memberPath: ["umask"] },
    ]);
    expect(result).toMatchObject({
      functions: [
        { status: "supported" },
        {
          status: "unsupported",
          failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" },
        },
        { status: "conditional" },
        {
          status: "unsupported",
          failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" },
        },
        { status: "supported" },
      ],
      profile: {
        nativeRuntime: {
          runtime: "workerd",
          workerdVersion: "1.20261012.1",
          nodeCompatibilityRevision: "workerd-nodejs-compat@1.20261012.1",
        },
      },
      capture: {
        runtimeClosed: true,
        workerdBinarySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });
});
