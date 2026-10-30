// @effect-diagnostics nodeBuiltinImport:off - Exercise the real default modules under Workerd.
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeBuffer from "node:buffer";
import type * as NodeCrypto from "node:crypto";
import type * as NodeZlib from "node:zlib";
import { DEFAULT_NODE_NATIVE_MODULES } from "../../NodeNativeModules.ts";
import { getNodeBuiltinCapability } from "../../../isolate/NodeBuiltinCapabilities.ts";

export * from "../../../FixtureWorkerExports.ts";

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/tls") {
      const tls = DEFAULT_NODE_NATIVE_MODULES.tls!;
      const Socket = Reflect.get(DEFAULT_NODE_NATIVE_MODULES.net!, "Socket");
      const TLSSocket = Reflect.get(tls, "TLSSocket");
      const connect = Reflect.get(tls, "connect");
      const codes: string[] = [];
      const identities: boolean[] = [];
      const servernames: string[] = [];
      for (const create of [
        (socket: object) => new TLSSocket(socket),
        (socket: object) => connect({ socket, rejectUnauthorized: true, enableTrace: false }),
      ]) {
        const plain = new Socket();
        const socket = create(plain);
        try {
          identities.push(socket instanceof TLSSocket && socket instanceof Socket);
          socket.setServername("fixture.test");
          servernames.push(socket.servername);
          for (const [member, args] of [
            ["setSession", [NodeBuffer.Buffer.from("session")]],
            ["getSession", []],
            ["getTLSTicket", []],
            ["isSessionReused", []],
            ["getCipher", []],
            ["getSharedSigalgs", []],
            ["getEphemeralKeyInfo", []],
            ["getFinished", []],
            ["getPeerFinished", []],
            ["getProtocol", []],
            ["getPeerCertificate", []],
            ["getCertificate", []],
            ["getPeerX509Certificate", []],
            ["getX509Certificate", []],
            ["setKeyCert", [{}]],
            ["exportKeyingMaterial", [16, "fixture"]],
            ["setMaxSendFragment", [512]],
            ["renegotiate", [{}, () => {}]],
            ["disableRenegotiation", []],
            ["enableTrace", []],
          ] as const) {
            try {
              socket[member](...args);
              codes.push("DID_NOT_THROW");
            } catch (error) {
              codes.push(String(Reflect.get(error as object, "code")));
            }
          }
        } finally {
          socket.destroy();
          plain.destroy();
        }
      }
      for (const option of [
        { ALPNProtocols: ["h2"] },
        { enableTrace: true },
        { isServer: true },
        { server: {} },
        { requestCert: true },
        { requestOCSP: true },
        { rejectUnauthorized: false },
        { SNICallback() {} },
        { secureContext: {} },
        { pskCallback() {} },
        { checkServerIdentity() {} },
        { minDHSize: 1024 },
      ]) {
        for (const create of [
          (socket: object) => new TLSSocket(socket, option),
          (socket: object) => connect({ socket, ...option }),
        ]) {
          const plain = new Socket();
          try {
            const socket = create(plain);
            socket.destroy();
            codes.push("DID_NOT_THROW");
          } catch (error) {
            codes.push(String(Reflect.get(error as object, "code")));
          } finally {
            plain.destroy();
          }
        }
      }
      return Response.json({ codes, identities, servernames });
    }
    if (path === "/dsa") {
      const keys: unknown = await request.json();
      if (typeof keys !== "object" || keys === null) throw new TypeError("Missing test keys");
      const module = DEFAULT_NODE_NATIVE_MODULES.crypto!;
      const call = (member: string, ...args: unknown[]) =>
        Reflect.apply(Reflect.get(module, member), module, args);
      const privateKey = call("createPrivateKey", Reflect.get(keys, "privateKey"));
      const publicKey = call("createPublicKey", Reflect.get(keys, "publicKey"));
      const codes: string[] = [];
      for (const [operation, args] of [
        ["sign", ["sha256", new Uint8Array(), privateKey]],
        ["verify", ["sha256", new Uint8Array(), publicKey, new Uint8Array()]],
      ] as const) {
        try {
          call(operation, ...args);
          codes.push("DID_NOT_THROW");
        } catch (error) {
          codes.push(String(Reflect.get(error as object, "code")));
        }
        codes.push(
          await new Promise<string>((resolve) =>
            call(operation, ...args, (error: object) =>
              resolve(String(Reflect.get(error, "code"))),
            ),
          ),
        );
      }
      return Response.json({ codes });
    }
    if (path === "/crypto-zlib") {
      const crypto = DEFAULT_NODE_NATIVE_MODULES.crypto as typeof NodeCrypto;
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const data = NodeBuffer.Buffer.from("guest bytes\n");
      const importedPrivate = crypto.createPrivateKey(
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      const importedPublic = crypto.createPublicKey(
        publicKey.export({ type: "spki", format: "pem" }),
      );
      const signature = crypto.sign(null, data, importedPrivate);
      const verified = crypto.verify(null, data, importedPublic, signature);
      const Root = crypto.X509Certificate;
      const roots = Reflect.get(DEFAULT_NODE_NATIVE_MODULES.tls!, "rootCertificates");
      const certificate = new Root(roots[0]);
      const zlib = DEFAULT_NODE_NATIVE_MODULES.zlib as typeof NodeZlib;
      const inflated = zlib.inflateRawSync(zlib.deflateRawSync(data)).toString();
      const deflated = zlib.inflateSync(zlib.deflateSync(data)).toString();
      const streams: string[] = [];
      for (const [decompress, compress] of [
        ["createGunzip", "gzipSync"],
        ["createInflate", "deflateSync"],
        ["createUnzip", "gzipSync"],
        ["createBrotliDecompress", "brotliCompressSync"],
        ["createZstdDecompress", "zstdCompressSync"],
      ] as const) {
        const stream = zlib[decompress]();
        const output = NodeStreamConsumers.buffer(stream);
        stream.end(zlib[compress](data));
        streams.push((await output).toString());
      }
      return Response.json({
        verified,
        certificateAuthority: certificate.ca,
        inflated,
        deflated,
        streams,
      });
    }
    if (path === "/client") {
      const previousFetch = globalThis.fetch;
      const observed: Array<{ url: string; method: string; body: string }> = [];
      globalThis.fetch = async (input, options) => {
        const outbound = new Request(input, options);
        observed.push({ url: outbound.url, method: outbound.method, body: await outbound.text() });
        return new Response("fetch-backed response");
      };
      try {
        const http = DEFAULT_NODE_NATIVE_MODULES.http!;
        const body = await new Promise<string>((resolve, reject) => {
          const child = Reflect.get(http, "request")(
            "http://model.test/messages",
            { method: "POST" },
            (response: Parameters<typeof NodeStreamConsumers.text>[0]) => {
              void NodeStreamConsumers.text(response).then(resolve, reject);
            },
          );
          child.on("error", reject);
          child.end("request body");
        });
        return Response.json({ observed, body });
      } finally {
        globalThis.fetch = previousFetch;
      }
    }
    if (path === "/async-resource") {
      const hooks = DEFAULT_NODE_NATIVE_MODULES.async_hooks!;
      const Storage = Reflect.get(hooks, "AsyncLocalStorage");
      const Resource = Reflect.get(hooks, "AsyncResource");
      const storage = new Storage();
      const resource = storage.run("captured", () => new Resource("guest"));
      const bound = resource.bind((suffix: string) => `${storage.getStore()}:${suffix}`);
      const value = storage.run("other", () => bound("bound"));
      const scoped = resource.runInAsyncScope(() => storage.getStore(), null);
      const staticBound = storage.run("static", () => Resource.bind(() => storage.getStore()));
      const errors: string[] = [];
      for (const invoke of [
        () => resource.asyncId(),
        () => resource.triggerAsyncId(),
        () => resource.emitDestroy(),
        () => Reflect.get(bound, "asyncResource").asyncId(),
        () => Reflect.get(staticBound, "asyncResource").emitDestroy(),
        () => new Resource("guest", { triggerAsyncId: 1 }),
        () => new Resource("guest", { requireManualDestroy: true }),
      ]) {
        try {
          invoke();
          errors.push("DID_NOT_THROW");
        } catch (error) {
          errors.push(String(Reflect.get(error as object, "code")));
        }
      }
      return Response.json({
        value,
        scoped,
        staticValue: staticBound(),
        errors,
        status: getNodeBuiltinCapability(Resource)?.status,
      });
    }
    if (path === "/timers") {
      const timeout = Reflect.get(DEFAULT_NODE_NATIVE_MODULES["timers/promises"]!, "setTimeout");
      const signal = new AbortController();
      signal.abort("cancelled");
      const results: string[] = [];
      for (const options of [{ ref: false }, { signal: signal.signal }]) {
        try {
          await timeout(10_000, "unused", options);
          results.push("DID_NOT_REJECT");
        } catch (error) {
          results.push(String(Reflect.get(error as object, "code")));
        }
      }
      return Response.json({ results });
    }
    const cases = [
      ["crypto", "generateKeyPairSync", ["dh", { primeLength: 512 }]],
      ["tls", "connect", [{ host: "example.test", port: 443, ca: "custom" }]],
      ["tls", "connect", [443, "example.test", { key: "custom" }]],
      ["tls", "TLSSocket", [undefined, { cert: "custom" }]],
      ["https", "request", ["https://example.test", { ca: "custom" }]],
      ["https", "request", [{ host: "example.test", rejectUnauthorized: false }]],
      ["https", "get", ["https://example.test", { checkServerIdentity() {} }]],
      ["http", "request", [{ host: "example.test", agent: { addRequest() {} } }]],
      ["http", "request", ["http://example.test", { insecureHTTPParser: true }]],
      ["net", "Socket", [{ fd: 3 }]],
      ["net", "connect", [{ host: "example.test", port: 80, autoSelectFamily: true }]],
      [
        "net",
        "createConnection",
        [{ host: "example.test", port: 80, autoSelectFamilyAttemptTimeout: 100 }],
      ],
    ] as const;
    return Response.json(
      cases.map(([specifier, member, args]) => {
        const module = DEFAULT_NODE_NATIVE_MODULES[specifier]!;
        const callable: unknown = Reflect.get(module, member);
        if (typeof callable !== "function") throw new Error(`Missing ${specifier}.${member}`);
        try {
          if (member === "TLSSocket" || member === "Socket") Reflect.construct(callable, [...args]);
          else Reflect.apply(callable, module, args);
          return { path: `${specifier}.${member}`, code: "DID_NOT_THROW" };
        } catch (error) {
          return { path: `${specifier}.${member}`, code: Reflect.get(error as object, "code") };
        }
      }),
    );
  },
};
