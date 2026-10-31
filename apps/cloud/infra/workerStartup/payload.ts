// @effect-diagnostics nodeBuiltinImport:off - Hashing and serializing a deployment payload runs in the standalone Node build adapter.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { BundleOutput } from "alchemy/Bundle/Bundle";

export interface StartupCompatibility {
  readonly date: string;
  readonly flags: readonly string[];
}

export const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function moduleType(name: string) {
  switch (NodePath.extname(name)) {
    case ".js":
    case ".mjs":
      return "application/javascript+module";
    case ".wasm":
      return "application/wasm";
    case ".json":
      return "application/json";
    case ".txt":
    case ".html":
    case ".sql":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    default:
      throw new Error(`WORKER_STARTUP_UNSUPPORTED_MODULE: ${name}`);
  }
}

export function startupPayload(bundle: BundleOutput, compatibility: StartupCompatibility) {
  const names = new Set<string>();
  const modules = bundle.files.map((file) => {
    if (
      !file.path ||
      NodePath.posix.isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      names.has(file.path)
    )
      throw new Error("WORKER_STARTUP_INVALID_MODULE_NAME");
    names.add(file.path);
    const content = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
    return {
      name: file.path,
      type: moduleType(file.path),
      bytes: content.byteLength,
      sha256: sha256(content),
    };
  });
  const entry = modules[0];
  if (!entry || entry.type !== "application/javascript+module")
    throw new Error("WORKER_STARTUP_ESM_ENTRY_REQUIRED");
  const identity = {
    mainModule: entry.name,
    compatibilityDate: compatibility.date,
    compatibilityFlags: [...compatibility.flags],
    modules: modules.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
  return { ...identity, sha256: sha256(JSON.stringify(identity)) };
}

/** The exact prebuilt modules go to Wrangler without another compiler pass. */
export async function serializeStartupPayload(
  bundle: BundleOutput,
  compatibility: StartupCompatibility,
) {
  const payload = startupPayload(bundle, compatibility);
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: payload.mainModule,
      compatibility_date: payload.compatibilityDate,
      compatibility_flags: payload.compatibilityFlags,
      bindings: [],
    }),
  );
  for (const file of bundle.files) {
    const pin = payload.modules.find((module) => module.name === file.path)!;
    form.set(file.path, new Blob([Buffer.from(file.content)], { type: pin.type }), file.path);
  }
  const response = new Response(form);
  return {
    payload,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

const decodeMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    main_module: Schema.String,
    compatibility_date: Schema.String,
    compatibility_flags: Schema.Array(Schema.String),
  }),
);

/** Decode the same retained multipart bytes that the official Wrangler command consumed. */
export async function serializedStartupPayload(bytes: Uint8Array) {
  const raw = Buffer.from(bytes);
  const firstLine = raw.indexOf("\n");
  if (firstLine < 2) throw new Error("WORKER_STARTUP_MULTIPART_INVALID");
  const boundary = raw.subarray(2, firstLine).toString().trim();
  const form = await new Response(raw, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const metadata = decodeMetadata(JSON.parse(String(form.get("metadata"))));
  const files = [];
  for (const [path, module] of form.entries()) {
    if (path === "metadata") continue;
    if (!(module instanceof Blob) || module.type !== moduleType(path))
      throw new Error("WORKER_STARTUP_MULTIPART_MODULE_INVALID");
    files.push({ path, content: new Uint8Array(await module.arrayBuffer()), hash: "recomputed" });
  }
  const main = files.find((file) => file.path === metadata.main_module);
  if (!main) throw new Error("WORKER_STARTUP_MULTIPART_ENTRY_MISSING");
  return startupPayload(
    { hash: "recomputed", files: [main, ...files.filter((file) => file !== main)] },
    {
      date: metadata.compatibility_date,
      flags: metadata.compatibility_flags,
    },
  );
}
