import { canonicalNodeBuiltin } from "../isolate/NodeBuiltinMap.ts";

export interface NodeNativeRuntimeProfile {
  readonly runtime: string;
  readonly workerdVersion: string;
  /** Workerd source revision for Node compatibility, never guest process.version. */
  readonly nodeCompatibilityRevision: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
}

export interface NodeNativeBuiltinRequest {
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

export interface NodeNativeBuiltinCapability {
  readonly status: "supported" | "conditional" | "unsupported";
  readonly evidence: string;
}

interface Declaration extends NodeNativeBuiltinCapability {
  readonly specifier: string;
  readonly memberPath: readonly string[];
}

const AUDITED_PROFILE = {
  runtime: "workerd",
  workerdVersion: "1.20261012.1",
  // This label pins the source revision; it is not a value reported by Workerd.
  nodeCompatibilityRevision: "workerd-nodejs-compat@1.20261012.1",
  compatibilityDate: "2026-10-01",
  compatibilityFlags: ["legacy_module_registry", "nodejs_compat"],
} as const;

// Keep each audited path and its rationale as one diffable source record.
const declarationData = String.raw`[
  {"specifier":"assert","memberPath":[],"status":"supported","evidence":"(callable module root): The Workerd assert module re-exports its native internal assert implementation; Cloudflare's Node compatibility table lists assertion testing as supported."},
  {"specifier":"async_hooks","memberPath":["AsyncLocalStorage"],"status":"supported","evidence":"AsyncLocalStorage construction creates the native async context storage used by Signalbox run/getStore. This declaration covers construction only; it does not declare enterWith or disable supported."},
  {"specifier":"async_hooks","memberPath":["AsyncResource"],"status":"conditional","evidence":"AsyncResource: Workerd binds and runs callbacks in the current async context, but triggerAsyncId options are unsupported and asyncId/triggerAsyncId return zero."},
  {"specifier":"buffer","memberPath":["Buffer","byteLength"],"status":"supported","evidence":"Buffer.byteLength: Workerd exports Buffer and the requested byteLength/concat/from/isBuffer/isUtf8 surface. Cloudflare documents Buffer support; its allocUnsafe behavior differs, but that is not one of these requested paths."},
  {"specifier":"buffer","memberPath":["Buffer","concat"],"status":"supported","evidence":"Buffer.concat: Workerd exports Buffer and the requested byteLength/concat/from/isBuffer/isUtf8 surface. Cloudflare documents Buffer support; its allocUnsafe behavior differs, but that is not one of these requested paths."},
  {"specifier":"buffer","memberPath":["Buffer","from"],"status":"supported","evidence":"Buffer.from: Workerd exports Buffer and the requested byteLength/concat/from/isBuffer/isUtf8 surface. Cloudflare documents Buffer support; its allocUnsafe behavior differs, but that is not one of these requested paths."},
  {"specifier":"buffer","memberPath":["Buffer","isBuffer"],"status":"supported","evidence":"Buffer.isBuffer: Workerd exports Buffer and the requested byteLength/concat/from/isBuffer/isUtf8 surface. Cloudflare documents Buffer support; its allocUnsafe behavior differs, but that is not one of these requested paths."},
  {"specifier":"buffer","memberPath":["isUtf8"],"status":"supported","evidence":"isUtf8: Workerd exports Buffer and the requested byteLength/concat/from/isBuffer/isUtf8 surface. Cloudflare documents Buffer support; its allocUnsafe behavior differs, but that is not one of these requested paths."},
  {"specifier":"crypto","memberPath":["X509Certificate"],"status":"conditional","evidence":"X509Certificate: Workerd provides X509Certificate parsing, but the crypto documentation excludes Ed448/X448 curves, so support depends on certificate key type."},
  {"specifier":"crypto","memberPath":["createCipheriv"],"status":"supported","evidence":"createCipheriv: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["createDecipheriv"],"status":"supported","evidence":"createDecipheriv: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["createHash"],"status":"supported","evidence":"createHash: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["createHmac"],"status":"supported","evidence":"createHmac: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["createPrivateKey"],"status":"conditional","evidence":"createPrivateKey: Workerd supports private-key parsing, except unsupported Ed448/X448 curves."},
  {"specifier":"crypto","memberPath":["createPublicKey"],"status":"conditional","evidence":"createPublicKey: Workerd supports public-key parsing, except unsupported Ed448/X448 curves."},
  {"specifier":"crypto","memberPath":["generateKeyPairSync"],"status":"conditional","evidence":"generateKeyPairSync: Cloudflare documents generateKeyPairSync but excludes DSA and DH key-pair generation; classify it conditional on the requested key type."},
  {"specifier":"crypto","memberPath":["randomBytes"],"status":"supported","evidence":"randomBytes: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["randomFillSync"],"status":"supported","evidence":"randomFillSync: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["randomInt"],"status":"supported","evidence":"randomInt: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["randomUUID"],"status":"supported","evidence":"randomUUID: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["sign"],"status":"conditional","evidence":"sign: Workerd supports signing, except unsupported Ed448/X448 curves."},
  {"specifier":"crypto","memberPath":["timingSafeEqual"],"status":"supported","evidence":"timingSafeEqual: Workerd exposes these Node crypto functions through its crypto module; Cloudflare documents Node crypto as supported with explicit algorithm/curve exceptions."},
  {"specifier":"crypto","memberPath":["verify"],"status":"conditional","evidence":"verify: Workerd supports verification, except unsupported Ed448/X448 curves."},
  {"specifier":"events","memberPath":["EventEmitter"],"status":"supported","evidence":"EventEmitter: Workerd's events module re-exports the native event implementation used by EventEmitter, once, and setMaxListeners."},
  {"specifier":"events","memberPath":["once"],"status":"supported","evidence":"once: Workerd's events module re-exports the native event implementation used by EventEmitter, once, and setMaxListeners."},
  {"specifier":"events","memberPath":["setMaxListeners"],"status":"supported","evidence":"setMaxListeners: Workerd's events module re-exports the native event implementation used by EventEmitter, once, and setMaxListeners."},
  {"specifier":"http","memberPath":["Agent"],"status":"conditional","evidence":"Agent: Cloudflare describes Agent as a stub: it has the expected shape but no connection pooling or keep-alive."},
  {"specifier":"http","memberPath":["createServer"],"status":"conditional","evidence":"createServer: Workerd enables server methods at compatibility date 2025-09-01 or later; this candidate uses 2026-10-01. Routing incoming Requests to the Node server still needs cloudflare:node httpServerHandler; that is not a base environment package here."},
  {"specifier":"http","memberPath":["request"],"status":"conditional","evidence":"request: This is implemented through global fetch, with unsupported options including lookup, createConnection and socketPath. The Node personality replaces global fetch with createHarnessModelTransport, so this path is not general Workerd egress in the production harness."},
  {"specifier":"http2","memberPath":["connect"],"status":"unsupported","evidence":"connect: Workerd's exported connect body directly throws ERR_METHOD_NOT_IMPLEMENTED. node:http2 is an importable non-functional stub."},
  {"specifier":"https","memberPath":["Agent"],"status":"conditional","evidence":"Agent: Same Agent stub as node:http: no connection pooling or keep-alive."},
  {"specifier":"https","memberPath":["createServer"],"status":"conditional","evidence":"createServer: Server method is date-enabled here but request routing needs cloudflare:node httpServerHandler. Workerd also does not honor TLS server options such as ca, cert, key, pfx or rejectUnauthorized."},
  {"specifier":"https","memberPath":["request"],"status":"conditional","evidence":"request: This is fetch-backed and global fetch is replaced by the harness model transport. Workerd does not honor many TLS client options including ca, cert, key and rejectUnauthorized."},
  {"specifier":"inspector","memberPath":["url"],"status":"unsupported","evidence":"url: Workerd's url() body returns undefined. The inspector module is a production stub; local-dev inspector support does not apply."},
  {"specifier":"net","memberPath":["BlockList"],"status":"supported","evidence":"BlockList: Workerd implements BlockList, IP predicates, outbound Socket/connect, and a server class. Outbound sockets use Cloudflare's sockets API. Server delivery depends on a Cloudflare connect handler; current public docs still call net.Server unsupported, so treat server calls as conditional."},
  {"specifier":"net","memberPath":["Socket"],"status":"conditional","evidence":"Socket: The constructor is real, but meaningful connectivity needs the Cloudflare sockets transport and platform-permitted egress."},
  {"specifier":"net","memberPath":["connect"],"status":"conditional","evidence":"connect: Workerd delegates to Cloudflare's internal sockets connect; this is conditional on platform egress and supported socket semantics."},
  {"specifier":"net","memberPath":["createConnection"],"status":"conditional","evidence":"createConnection: Alias of Workerd net.connect; it uses Cloudflare's sockets transport and is conditional on platform egress."},
  {"specifier":"net","memberPath":["createServer"],"status":"conditional","evidence":"createServer: The pinned source creates a Server and installs a local TCP handler, but its own comment routes inbound platform sockets through cloudflare:node connectHandler. Public docs still say net.Server is unsupported; no handler is injected by the default Node environment."},
  {"specifier":"net","memberPath":["isIP"],"status":"supported","evidence":"isIP: Workerd implements BlockList, IP predicates, outbound Socket/connect, and a server class. Outbound sockets use Cloudflare's sockets API. Server delivery depends on a Cloudflare connect handler; current public docs still call net.Server unsupported, so treat server calls as conditional."},
  {"specifier":"net","memberPath":["isIPv4"],"status":"supported","evidence":"isIPv4: Workerd implements BlockList, IP predicates, outbound Socket/connect, and a server class. Outbound sockets use Cloudflare's sockets API. Server delivery depends on a Cloudflare connect handler; current public docs still call net.Server unsupported, so treat server calls as conditional."},
  {"specifier":"net","memberPath":["isIPv6"],"status":"supported","evidence":"isIPv6: Workerd implements BlockList, IP predicates, outbound Socket/connect, and a server class. Outbound sockets use Cloudflare's sockets API. Server delivery depends on a Cloudflare connect handler; current public docs still call net.Server unsupported, so treat server calls as conditional."},
  {"specifier":"perf_hooks","memberPath":["monitorEventLoopDelay"],"status":"unsupported","evidence":"monitorEventLoopDelay: Workerd's implementation body throws ERR_METHOD_NOT_IMPLEMENTED."},
  {"specifier":"stream","memberPath":["PassThrough"],"status":"supported","evidence":"PassThrough: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["Readable"],"status":"supported","evidence":"Readable: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["Readable","from"],"status":"supported","evidence":"Readable.from: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["Readable","fromWeb"],"status":"supported","evidence":"Readable.fromWeb: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["Readable","toWeb"],"status":"supported","evidence":"Readable.toWeb: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["Transform"],"status":"supported","evidence":"Transform: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["finished"],"status":"supported","evidence":"finished: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["pipeline"],"status":"supported","evidence":"pipeline: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream","memberPath":["promises","pipeline"],"status":"supported","evidence":"promises.pipeline: Workerd's Node stream module is a real implementation backed by its Node stream internals and exposes the requested classes, conversion methods, finished/pipeline, and promises property."},
  {"specifier":"stream/consumers","memberPath":["text"],"status":"supported","evidence":"text: Workerd's consumers module implements text by asynchronously reading chunks and flushing a TextDecoder; the official streams example uses stream consumers."},
  {"specifier":"stream/promises","memberPath":["finished"],"status":"supported","evidence":"finished: Workerd's stream/promises module re-exports the native stream promise helpers."},
  {"specifier":"stream/promises","memberPath":["pipeline"],"status":"supported","evidence":"pipeline: Workerd's stream/promises module re-exports the native stream promise helpers."},
  {"specifier":"string_decoder","memberPath":["StringDecoder"],"status":"supported","evidence":"StringDecoder: Workerd's string_decoder module exports its native StringDecoder implementation."},
  {"specifier":"timers/promises","memberPath":["setImmediate"],"status":"supported","evidence":"setImmediate: Workerd's promise timer functions are implemented, but production timer values only advance with I/O; setTimeout delay should not be treated as elapsed wall-clock time. setImmediate is a next-turn yield."},
  {"specifier":"timers/promises","memberPath":["setTimeout"],"status":"conditional","evidence":"setTimeout: The function is implemented, but Workers timers do not guarantee Node-style wall-clock delay; in deployed Workers time only advances after I/O."},
  {"specifier":"tls","memberPath":["checkServerIdentity"],"status":"supported","evidence":"checkServerIdentity: Workerd exports its native certificate identity check; the API is listed as available by the TLS documentation."},
  {"specifier":"tls","memberPath":["connect"],"status":"conditional","evidence":"connect: Workerd supports outbound TLS over its socket API, subject to platform egress and TLS trust behavior. Signalbox's rootCertificates list is metadata, not a custom handshake trust store."},
  {"specifier":"tls","memberPath":["createSecureContext"],"status":"unsupported","evidence":"createSecureContext: The function returns an empty SecureContext placeholder; Workerd explicitly does not implement equivalent context customization and ignores minVersion/maxVersion."},
  {"specifier":"tls","memberPath":["rootCertificates","some"],"status":"supported","evidence":"rootCertificates.some: Signalbox supplies bundled rootCertificates metadata when Workerd has none. The array method call works, but the list is not Workerd's active TLS trust store."},
  {"specifier":"url","memberPath":["URL"],"status":"supported","evidence":"URL: Workerd exports the URL standard classes and its Node URL conversion, domain, and legacy parse helpers."},
  {"specifier":"url","memberPath":["domainToASCII"],"status":"supported","evidence":"domainToASCII: Workerd exports the URL standard classes and its Node URL conversion, domain, and legacy parse helpers."},
  {"specifier":"url","memberPath":["fileURLToPath"],"status":"supported","evidence":"fileURLToPath: Workerd exports the URL standard classes and its Node URL conversion, domain, and legacy parse helpers."},
  {"specifier":"url","memberPath":["parse"],"status":"supported","evidence":"parse: Workerd exports the URL standard classes and its Node URL conversion, domain, and legacy parse helpers."},
  {"specifier":"url","memberPath":["pathToFileURL"],"status":"supported","evidence":"pathToFileURL: Workerd exports the URL standard classes and its Node URL conversion, domain, and legacy parse helpers."},
  {"specifier":"util","memberPath":["TextEncoder"],"status":"supported","evidence":"TextEncoder: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["debuglog"],"status":"conditional","evidence":"debuglog: Workerd always enables debuglog and sends it to console rather than honoring Node's NODE_DEBUG environment switch."},
  {"specifier":"util","memberPath":["format"],"status":"supported","evidence":"format: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["getSystemErrorName"],"status":"unsupported","evidence":"getSystemErrorName: Workerd's implementation unconditionally throws that node:util getSystemErrorName is not implemented."},
  {"specifier":"util","memberPath":["inspect"],"status":"supported","evidence":"inspect: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["isDeepStrictEqual"],"status":"supported","evidence":"isDeepStrictEqual: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["promisify"],"status":"supported","evidence":"promisify: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["stripVTControlCharacters"],"status":"supported","evidence":"stripVTControlCharacters: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["types","isNativeError"],"status":"supported","evidence":"types.isNativeError: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util","memberPath":["types","isProxy"],"status":"supported","evidence":"types.isProxy: Pinned Workerd C++ includes Proxy in its type predicate set and implements isProxy through JsValue.isProxy; the Cloudflare docs caveat predates this installed source pin."},
  {"specifier":"util","memberPath":["types","isStringObject"],"status":"supported","evidence":"types.isStringObject: Workerd implements the requested format/inspect/promisify/type predicates. debuglog is always enabled and writes to console, while getSystemErrorName explicitly throws. Exact Workerd 1.20261012.1 source implements isProxy even though the older Cloudflare docs page says it is not implemented."},
  {"specifier":"util/types","memberPath":["isArrayBuffer"],"status":"supported","evidence":"isArrayBuffer: The exact installed Workerd source implements the requested type predicates, including isProxy; this supersedes the older docs page's isProxy caveat for this pinned package."},
  {"specifier":"util/types","memberPath":["isProxy"],"status":"supported","evidence":"isProxy: Pinned Workerd C++ includes Proxy in its type predicate set and implements isProxy through JsValue.isProxy; the Cloudflare docs caveat predates this installed source pin."},
  {"specifier":"util/types","memberPath":["isUint8Array"],"status":"supported","evidence":"isUint8Array: The exact installed Workerd source implements the requested type predicates, including isProxy; this supersedes the older docs page's isProxy caveat for this pinned package."},
  {"specifier":"v8","memberPath":["getHeapSpaceStatistics"],"status":"unsupported","evidence":"getHeapSpaceStatistics: Returns [] in Workerd, which is a placeholder rather than actual heap-space data."},
  {"specifier":"v8","memberPath":["getHeapStatistics"],"status":"unsupported","evidence":"getHeapStatistics: Returns zero for all heap statistics in Workerd, which is a placeholder rather than actual heap data."},
  {"specifier":"vm","memberPath":["Script"],"status":"unsupported","evidence":"Script: Construction accepts code but Workerd's Script.runInContext/runInThisContext throw; the class does not make VM execution available."},
  {"specifier":"vm","memberPath":["SourceTextModule"],"status":"unsupported","evidence":"SourceTextModule: The Workerd vm default export explicitly omits SourceTextModule and SyntheticModule; this requested member is missing."},
  {"specifier":"vm","memberPath":["SyntheticModule"],"status":"unsupported","evidence":"SyntheticModule: The Workerd vm default export explicitly omits SourceTextModule and SyntheticModule; this requested member is missing."},
  {"specifier":"vm","memberPath":["createContext"],"status":"unsupported","evidence":"createContext: Returns a marker object rather than a V8 context; later execution methods throw."},
  {"specifier":"vm","memberPath":["runInContext"],"status":"unsupported","evidence":"runInContext: Delegates to Workerd Script.runInContext, which throws ERR_METHOD_NOT_IMPLEMENTED."},
  {"specifier":"vm","memberPath":["runInThisContext"],"status":"unsupported","evidence":"runInThisContext: Delegates to Workerd Script.runInThisContext, which throws ERR_METHOD_NOT_IMPLEMENTED."},
  {"specifier":"zlib","memberPath":["createBrotliDecompress"],"status":"conditional","evidence":"createBrotliDecompress: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["createGunzip"],"status":"conditional","evidence":"createGunzip: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["createInflate"],"status":"conditional","evidence":"createInflate: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["createUnzip"],"status":"conditional","evidence":"createUnzip: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["createZstdDecompress"],"status":"conditional","evidence":"createZstdDecompress: Workerd has a concrete ZstdDecompress class/factory and its zlib util links ZSTD; the only gate is nodejs_zlib, automatically enabled for this compatibility date."},
  {"specifier":"zlib","memberPath":["deflateRawSync"],"status":"conditional","evidence":"deflateRawSync: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["deflateSync"],"status":"conditional","evidence":"deflateSync: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["gzipSync"],"status":"conditional","evidence":"gzipSync: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."},
  {"specifier":"zlib","memberPath":["inflateRawSync"],"status":"conditional","evidence":"inflateRawSync: Workerd implements the requested gzip/deflate/Brotli and Zstd operations. They are wrapped by a nodejs_zlib compatibility gate; the production compatibility date is after the automatic-enable date, so the gate is satisfied for this candidate."}
]`;
const declarations = JSON.parse(declarationData) as readonly Declaration[];

const sourceEvidenceNotice =
  " Pinned Workerd v1.20261012.1 source evidence (commit 5358e3d337336eaf696a48bc1563d808b10feba5); static evidence only, not a guest invocation or official qualification.";

function matchesAuditedProfile(profile: NodeNativeRuntimeProfile | undefined): boolean {
  if (
    profile === undefined ||
    profile.runtime !== AUDITED_PROFILE.runtime ||
    profile.workerdVersion !== AUDITED_PROFILE.workerdVersion ||
    profile.nodeCompatibilityRevision !== AUDITED_PROFILE.nodeCompatibilityRevision ||
    profile.compatibilityDate !== AUDITED_PROFILE.compatibilityDate ||
    profile.compatibilityFlags.length !== AUDITED_PROFILE.compatibilityFlags.length
  ) {
    return false;
  }

  const flags = new Set(profile.compatibilityFlags);
  return (
    flags.size === AUDITED_PROFILE.compatibilityFlags.length &&
    AUDITED_PROFILE.compatibilityFlags.every((flag) => flags.has(flag))
  );
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function selectedModule(
  modules: Readonly<Record<string, object>>,
  canonicalSpecifier: string,
): object | undefined {
  let found: object | undefined;
  try {
    for (const specifier of Object.keys(modules)) {
      if (canonicalNodeBuiltin(specifier) !== canonicalSpecifier) continue;
      const descriptor = Object.getOwnPropertyDescriptor(modules, specifier);
      if (!descriptor || !("value" in descriptor) || !isObject(descriptor.value)) return undefined;
      if (found !== undefined && found !== descriptor.value) return undefined;
      found = descriptor.value;
    }
  } catch {
    return undefined;
  }
  return found;
}

type PropertyRead =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "not-readable" };

function readWithoutInvokingGetters(target: object, name: string): PropertyRead {
  let current: object | null = target;
  const visited = new Set<object>();
  try {
    while (current !== null) {
      if (visited.has(current)) return { kind: "not-readable" };
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        return "value" in descriptor
          ? { kind: "value", value: descriptor.value }
          : { kind: "not-readable" };
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return { kind: "not-readable" };
  }
  return { kind: "not-readable" };
}

function resolveCallable(root: object, memberPath: readonly string[]): unknown | undefined {
  let value: unknown = root;
  for (const segment of memberPath) {
    if (!isObject(value)) return undefined;
    const property = readWithoutInvokingGetters(value, segment);
    if (property.kind !== "value") return undefined;
    value = property.value;
  }
  return typeof value === "function" ? value : undefined;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * Returns source-backed declarations only for the audited native Workerd profile and exact
 * default module/path identities. It never invokes exported functions or accessors.
 */
export function classifyNodeNativeBuiltinCapability(input: {
  readonly modules: Readonly<Record<string, object>>;
  readonly auditedDefaultModules: Readonly<Record<string, object>>;
  readonly request: NodeNativeBuiltinRequest;
  readonly runtimeProfile?: NodeNativeRuntimeProfile;
}): NodeNativeBuiltinCapability | undefined {
  const { modules, auditedDefaultModules, request, runtimeProfile } = input;
  const canonicalSpecifier = canonicalNodeBuiltin(request.specifier);
  if (canonicalSpecifier === undefined || !matchesAuditedProfile(runtimeProfile)) return undefined;

  const declaration = declarations.find(
    (candidate) =>
      candidate.specifier === canonicalSpecifier &&
      samePath(candidate.memberPath, request.memberPath),
  );
  if (!declaration) return undefined;

  const selected = selectedModule(modules, canonicalSpecifier);
  const auditedDefault = selectedModule(auditedDefaultModules, canonicalSpecifier);
  if (selected === undefined || selected !== auditedDefault) return undefined;

  const selectedCallable = resolveCallable(selected, request.memberPath);
  const defaultCallable = resolveCallable(auditedDefault, request.memberPath);
  if (selectedCallable === undefined || selectedCallable !== defaultCallable) return undefined;

  return {
    status: declaration.status,
    evidence: `${declaration.evidence}${sourceEvidenceNotice}`,
  };
}
