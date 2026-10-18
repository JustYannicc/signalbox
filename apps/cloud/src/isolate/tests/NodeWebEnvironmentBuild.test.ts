// @effect-diagnostics nodeBuiltinImport:off - exercises the actual prepared Node package sources.
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import {
  buildNodeWebEnvironment,
  serializeNodeWebEnvironmentPackageModules,
  type NodeWebEnvironmentBuild,
} from "../NodeWebEnvironmentBuild.ts";
import { createNodeEnvironmentResolver } from "../NodeEnvironment.ts";
import { createNodeModule } from "../NodeModule.ts";

const cloudRequire = NodeModule.createRequire(new URL("../../../package.json", import.meta.url));
const packageEntries = Object.freeze({
  ws: cloudRequire.resolve("ws"),
  "node-fetch": cloudRequire.resolve("node-fetch"),
});

let environment: NodeWebEnvironmentBuild;
let wsModule: Record<string, unknown>;
let fetchModule: Record<string, unknown>;
let jscModule: Record<string, unknown>;

beforeAll(async () => {
  environment = await buildNodeWebEnvironment(packageEntries);
  [wsModule, fetchModule, jscModule] = await Promise.all([
    importPrepared("ws", environment.environmentPackageModules.ws),
    importPrepared("node-fetch", environment.environmentPackageModules["node-fetch"]),
    importPrepared("bun:jsc", environment.environmentPackageModules["bun:jsc"]),
  ]);
});

describe("Node web environment package build", () => {
  it("prepares the exact package map with pinned real package provenance", () => {
    expect(Object.keys(environment.environmentPackageModules)).toEqual([
      "ws",
      "node-fetch",
      "bun:jsc",
    ]);
    expect(environment.provenance.schemaVersion).toBe(1);
    expect(environment.provenance.moduleMapBytes).toBe(
      NodeBuffer.Buffer.byteLength(
        serializeNodeWebEnvironmentPackageModules(environment.environmentPackageModules),
      ),
    );
    expect(environment.provenance.moduleMapSha256).toBe(
      digest(serializeNodeWebEnvironmentPackageModules(environment.environmentPackageModules)),
    );

    expect(environment.provenance.modules.ws).toMatchObject({
      specifier: "ws",
      entryPath: "index.js",
      packageVersion: "8.22.0",
      license: "MIT",
      buildDefines: {
        "process.env.WS_NO_BUFFER_UTIL": true,
        "process.env.WS_NO_UTF_8_VALIDATE": true,
      },
    });
    expect(environment.provenance.modules["node-fetch"]).toMatchObject({
      specifier: "node-fetch",
      entryPath: "lib/index.js",
      packageVersion: "2.7.0",
      license: "MIT",
    });
    expect(environment.provenance.modules["node-fetch"].packageClosure).toEqual(
      expect.arrayContaining([
        { name: "node-fetch", version: "2.7.0", license: "MIT", licenseFile: "LICENSE.md", licenseSha256: expect.any(String) },
        { name: "whatwg-url", version: "5.0.0", license: "MIT", licenseFile: expect.any(String), licenseSha256: expect.any(String) },
        { name: "tr46", version: "0.0.3", license: "MIT", licenseFile: null, licenseSha256: null },
        { name: "webidl-conversions", version: "3.0.1", license: "BSD-2-Clause", licenseFile: expect.any(String), licenseSha256: expect.any(String) },
        { name: "punycode", version: "2.3.1", license: "MIT", licenseFile: "LICENSE-MIT.txt", licenseSha256: expect.any(String) },
        { name: "encoding", version: "0.1.13", license: "MIT", licenseFile: expect.any(String), licenseSha256: expect.any(String) },
        { name: "iconv-lite", version: "0.6.3", license: "MIT", licenseFile: expect.any(String), licenseSha256: expect.any(String) },
        { name: "safer-buffer", version: "2.1.2", license: "MIT", licenseFile: expect.any(String), licenseSha256: expect.any(String) },
      ]),
    );
    expect(environment.provenance.modules["node-fetch"].nativeImports).not.toContain(
      "node:punycode",
    );

    for (const module of Object.values(environment.provenance.modules)) {
      expect(module.outputBytes).toBe(
        NodeBuffer.Buffer.byteLength(environment.environmentPackageModules[module.specifier]),
      );
      expect(module.outputSha256).toBe(digest(environment.environmentPackageModules[module.specifier]));
      for (const sourceFile of module.sourceFiles) expect(sourceFile.sha256).toMatch(/^[0-9a-f]{64}$/u);
      for (const packageLicense of module.packageClosure) {
        if (packageLicense.licenseFile) {
          expect(packageLicense.licenseSha256).toMatch(/^[0-9a-f]{64}$/u);
        } else {
          expect(packageLicense.licenseSha256).toBeNull();
        }
      }
      for (const importedBuiltin of module.nativeImports) {
        expect(importedBuiltin).toMatch(/^node:/u);
      }
    }
    for (const source of Object.values(environment.environmentPackageModules)) {
      expect(source).not.toContain("Dynamic require of");
    }
  });

  it("keeps ws optional native addons out while preserving real ESM exports", () => {
    const WebSocket = wsModule.default;
    expect(typeof WebSocket).toBe("function");
    expect(wsModule.WebSocket).toBe(WebSocket);
    for (const name of [
      "WebSocketServer",
      "createWebSocketStream",
      "extension",
      "PerMessageDeflate",
      "Receiver",
      "Sender",
      "subprotocol",
    ]) {
      expect(
        wsModule[name] !== null &&
          (typeof wsModule[name] === "object" || typeof wsModule[name] === "function"),
      ).toBe(true);
      expect(wsModule[name]).toBe(Reflect.get(WebSocket as object, name));
    }
    expect(typeof wsModule.WebSocketServer).toBe("function");
    expect(Reflect.get(WebSocket as object, "Server")).toBe(wsModule.WebSocketServer);
    expect(environment.environmentPackageModules.ws).not.toContain("bufferutil");
    expect(environment.environmentPackageModules.ws).not.toContain("utf-8-validate");
  });

  it("preserves node-fetch 2.7 CJS default import behavior and Response bytes", async () => {
    const fetch = fetchModule.default;
    expect(typeof fetch).toBe("function");
    expect(fetchModule.Response).toBe(Reflect.get(fetch as object, "Response"));
    expect(fetchModule.Headers).toBe(Reflect.get(fetch as object, "Headers"));
    expect(fetchModule.Request).toBe(Reflect.get(fetch as object, "Request"));
    expect(fetchModule.AbortError).toBe(Reflect.get(fetch as object, "AbortError"));
    expect(fetchModule.FetchError).toBe(Reflect.get(fetch as object, "FetchError"));

    const Response = fetchModule.Response as new (...args: unknown[]) => {
      readonly status: number;
      readonly headers: { get(name: string): string | null };
      arrayBuffer(): Promise<ArrayBuffer>;
    };
    const response = new Response(NodeBuffer.Buffer.from([0, 255, 1, 2]), {
      status: 206,
      headers: { "content-type": "application/octet-stream" },
    });
    const body = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(Array.from(body)).toEqual([0, 255, 1, 2]);

    const Request = fetchModule.Request as new (input: string) => { readonly url: string };
    expect(new Request("https://münich.example/").url).toBe(
      "https://xn--mnich-kva.example/",
    );
    expect(new Request("https://𝒜.example/").url).toBe("https://a.example/");
  });

  it("maps package CJS requires to the same prepared exports before release loading", () => {
    const resolver = createNodeEnvironmentResolver({
      packages: {
        ws: moduleObject(wsModule.default),
        "node-fetch": moduleObject(fetchModule.default),
        "bun:jsc": jscModule,
      },
      addons: [],
    });
    const module = createNodeModule(
      { require: (specifier) => { throw new Error(`Unexpected builtin request: ${specifier}`); } },
      resolver,
    );
    const require = module.createRequire("/signalbox/release.js");

    expect(require("ws")).toBe(wsModule.default);
    expect(require("node-fetch")).toBe(fetchModule.default);
    expect(require("bun:jsc")).toBe(jscModule);
  });

  it("resolves the pinned npm punycode entry instead of the deprecated Node core module", () => {
    const punycodeEntry = cloudRequire.resolve("punycode/");
    const punycode = cloudRequire("punycode/") as {
      readonly toASCII: (value: string) => string;
      readonly toUnicode: (value: string) => string;
      readonly ucs2: {
        decode(value: string): number[];
        encode(value: readonly number[]): string;
      };
    };

    expect(punycodeEntry).toMatch(/punycode(?:\.js)?$/u);
    expect(punycode.toASCII("münich.example")).toBe("xn--mnich-kva.example");
    expect(punycode.toUnicode("xn--mnich-kva.example")).toBe("münich.example");
    expect(punycode.ucs2.encode(punycode.ucs2.decode("𝒜😀"))).toBe("𝒜😀");
  });

  it("round-trips binary bytes through the real ws Sender and Receiver", async () => {
    const WebSocket = wsModule.default as Record<string, unknown>;
    const Sender = Reflect.get(WebSocket, "Sender") as {
      frame(
        data: NodeBuffer.Buffer,
        options: {
          readonly fin: boolean;
          readonly mask: boolean;
          readonly generateMask: (mask: NodeBuffer.Buffer) => void;
          readonly maskBuffer: NodeBuffer.Buffer;
          readonly opcode: number;
          readonly readOnly: boolean;
          readonly rsv1: boolean;
        },
      ): readonly NodeBuffer.Buffer[];
    };
    const Receiver = Reflect.get(WebSocket, "Receiver") as new (options: {
      readonly isServer: boolean;
    }) => {
      on(event: "message", listener: (data: NodeBuffer.Buffer, isBinary: boolean) => void): void;
      once(event: "error", listener: (error: unknown) => void): void;
      end(frame: NodeBuffer.Buffer): void;
    };
    const payload = NodeBuffer.Buffer.from([0, 255, 3, 128, 42]);
    const maskBuffer = NodeBuffer.Buffer.alloc(4);
    const frame = NodeBuffer.Buffer.concat(
      Sender.frame(payload, {
        fin: true,
        mask: true,
        generateMask: (mask) => mask.set([17, 34, 51, 68]),
        maskBuffer,
        opcode: 2,
        readOnly: true,
        rsv1: false,
      }),
    );
    const receiver = new Receiver({ isServer: true });
    const message = new Promise<{ readonly data: NodeBuffer.Buffer; readonly isBinary: boolean }>(
      (resolve, reject) => {
        receiver.on("message", (data, isBinary) => resolve({ data, isBinary }));
        receiver.once("error", reject);
      },
    );
    receiver.end(frame);

    const result = await message;
    expect(result.isBinary).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it("imports bun:jsc safely and fails only when the V8-incompatible members are called", () => {
    expect(typeof jscModule.edenGC).toBe("function");
    expect(typeof jscModule.heapStats).toBe("function");
    const BunJscUnavailableError = jscModule.BunJscUnavailableError as new (...args: never[]) => Error & {
      readonly code: string;
      readonly runtime: string;
      readonly member: string;
    };

    for (const [member, invoke] of [
      ["edenGC", () => Reflect.apply(jscModule.edenGC as Function, jscModule, [])],
      ["heapStats", () => Reflect.apply(jscModule.heapStats as Function, jscModule, [])],
    ] as const) {
      let error: unknown;
      try {
        invoke();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BunJscUnavailableError);
      expect(error).toMatchObject({
        code: "ERR_BUN_JSC_UNAVAILABLE",
        runtime: "v8",
        member,
      });
    }
  });
});

async function importPrepared(name: string, source: string): Promise<Record<string, unknown>> {
  const base64 = NodeBuffer.Buffer.from(source).toString("base64");
  const namespace: unknown = await import(/* @vite-ignore */ `data:text/javascript;base64,${base64}`);
  if (typeof namespace === "function" && name === "node-fetch") {
    // Vite unwraps this CJS-shaped graph to its default; the real function carries these aliases.
    const aliases = Object.fromEntries(
      ["AbortError", "FetchError", "Headers", "Request", "Response"].map((key) => [
        key,
        Reflect.get(namespace, key),
      ]),
    );
    return Object.assign({ default: namespace }, aliases);
  }
  if (typeof namespace !== "object" || namespace === null) {
    throw new TypeError(`Prepared package ${name} did not return an ESM namespace (got ${typeof namespace})`);
  }
  return namespace as Record<string, unknown>;
}

function moduleObject(value: unknown): object {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError("Prepared package default export must be an object or function");
  }
  return value;
}

function digest(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}
