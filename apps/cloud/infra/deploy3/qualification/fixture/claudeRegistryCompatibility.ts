import type { NodeBridge } from "../../../../src/isolate/NodeBridge.ts";
import {
  claudePreparedModuleSpecifier,
  type ClaudePreparedPlan,
  createClaudePreparedImports,
} from "./claudePreparedModules.ts";

function object(value: unknown, description: string): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    throw new TypeError(`Registry compatibility needs ${description}`);
  return value;
}

function call(target: object, name: string, args: readonly unknown[] = []): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function")
    throw new TypeError(`Registry compatibility has no ${name} method`);
  return Reflect.apply(method, target, args);
}

function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(`CLAUDE_REGISTRY_COMPATIBILITY: ${description}`);
}

/** Runs while the normal Node personality owns globals and the real release is imported. */
export async function inspectClaudeRegistryCompatibility(input: {
  readonly cli: object;
  readonly bridge: NodeBridge;
  readonly plan: ClaudePreparedPlan;
  readonly signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const url = new URL(import.meta.url);
  check(url.protocol === "file:", "import.meta.url must be a file URL");
  const module = object(input.bridge.require("node:module"), "guest node:module");
  const fromPath = object(call(module, "createRequire", ["/signalbox/claude.js"]), "path require");
  const fromUrl = object(
    call(module, "createRequire", [new URL("file:///signalbox/claude.js")]),
    "file URL require",
  );
  const require = (owner: object, name: string): unknown => {
    if (typeof owner !== "function") throw new TypeError("createRequire did not return a function");
    return Reflect.apply(owner, undefined, [name]);
  };
  const builtinNames = [
    "fs",
    "fs/promises",
    "path",
    "url",
    "module",
    "process",
    "buffer",
    "events",
    "stream",
    "util",
    "crypto",
    "os",
    "tty",
    "readline",
    "child_process",
  ];
  for (const name of builtinNames) {
    const expected = input.bridge.require(`node:${name}`);
    check(require(fromPath, `node:${name}`) === expected, `${name} path require identity`);
    check(require(fromUrl, name) === expected, `${name} URL require identity`);
    check(call(fromPath, "resolve", [`node:${name}`]) === `node:${name}`, `${name} resolution`);
  }
  const path = object(require(fromPath, "node:path"), "guest path");
  const urls = object(require(fromPath, "node:url"), "guest URL");
  const filename = call(urls, "fileURLToPath", ["file:///signalbox/claude.js"]);
  check(filename === "/signalbox/claude.js", "guest __filename conversion");
  check(call(path, "dirname", [filename]) === "/signalbox", "guest __dirname conversion");
  check(
    call(path, "resolve", ["/signalbox", "./claude.js"]) === filename,
    "relative path resolution",
  );
  const fs = object(require(fromPath, "node:fs"), "guest filesystem");
  const stat = object(call(fs, "statSync", ["/workspace"]), "workspace stat");
  check(call(stat, "isDirectory") === true, "filesystem builtin operation");
  const guestCrypto = object(require(fromPath, "node:crypto"), "guest crypto");
  const hash = object(call(guestCrypto, "createHash", ["sha256"]), "SHA256 hash");
  call(hash, "update", ["registry-compatibility"]);
  const digest = call(hash, "digest", ["hex"]);
  check(
    digest === "7c89e74bfb79abf34329577bd0f108d18aab34734d47a928b0e16898b921e2f7",
    "crypto builtin operation",
  );

  const imported = await createClaudePreparedImports().loadRelease(input.plan, input.signal);
  const launch: unknown = Reflect.get(input.cli, input.plan.main.export);
  check(typeof launch === "function", "real launch export");
  check(
    Reflect.get(imported, input.plan.main.export) === launch,
    "dynamic import preserves module identity",
  );
  const functionSource = Function.prototype.toString.call(launch);
  check(
    functionSource.length > 0 && !functionSource.includes("[native code]"),
    "real function source text",
  );
  check(
    functionSource ===
      Function.prototype.toString.call(Reflect.get(imported, input.plan.main.export)),
    "fn.toString after dynamic import",
  );
  const nativePath = await import(/* @vite-ignore */ "node:path");
  check(
    nativePath.dirname("/signalbox/claude.js") === "/signalbox",
    "native builtin dynamic import",
  );
  const resolver: unknown = Reflect.get(import.meta, "resolve");
  if (typeof resolver !== "function")
    throw new Error("CLAUDE_REGISTRY_COMPATIBILITY: import.meta.resolve availability");
  const resolved: unknown = Reflect.apply(resolver, import.meta, [
    claudePreparedModuleSpecifier(input.plan.main.module),
  ]);
  check(
    typeof resolved === "string" && new URL(resolved).protocol === "file:",
    "relative ESM resolution",
  );
  input.signal.throwIfAborted();
  return {
    status: "passed" as const,
    importMetaUrl: url.href,
    resolvedRelease: resolved,
    createRequireGuestPath: "/signalbox/claude.js",
    filename,
    dirname: "/signalbox",
    builtins: builtinNames,
    dynamicImportSameLaunch: true,
    functionSourceCharacters: functionSource.length,
    functionSourceSha256: await globalThis.crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(functionSource))
      .then((bytes) =>
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    cliLaunchInvoked: false,
  };
}
