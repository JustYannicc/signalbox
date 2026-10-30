import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  HarnessReleaseArtifactManifestSchema,
  decodeRawProviderManifest,
  serializeHarnessReleaseArtifactManifest,
} from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { fixture } from "../../harnessReleases/fixtures/claudeReleaseVariants.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const envelope = Schema.decodeUnknownSync(HarnessReleaseArtifactManifestSchema);
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sdk = `export function initialize(){return {
  query(){throw new Error("Synthetic SDK cannot start an official Claude process")},
  forkSession(){throw new Error("Synthetic SDK cannot fork an official session")},
  getSubagentMessages(){return []}
}}`;

/** Replaces the graph fixture's JSON string literals with importable synthetic modules. */
export function executableSyntheticVariant(
  variant: Awaited<ReturnType<typeof fixture>>["baseline"],
) {
  const files = new Map(variant.files);
  const modules = (component: "cli" | "sdk") => {
    const path = `${component}/manifest.json`;
    const manifest = decodeRawProviderManifest(files.get(path)!);
    const updated = Object.fromEntries(
      Object.entries(record(manifest.modules)).map(([name, raw]) => {
        const module = record(raw);
        if (typeof module.path !== "string") throw new Error("Synthetic module path missing");
        const file = `${component}/${module.path}`;
        const previous: unknown = JSON.parse(new TextDecoder().decode(files.get(file)!));
        if (typeof previous !== "string") throw new Error("Synthetic module source missing");
        const bytes = new TextEncoder().encode(component === "sdk" ? sdk : previous);
        files.set(file, bytes);
        return [name, { ...module, bytes: bytes.length, sha256: hash(bytes) }];
      }),
    );
    const cliMetadata =
      component === "cli"
        ? {
            bytes: Object.values(updated).reduce((total, module) => total + module.bytes, 0),
            ...(manifest.workerEntries === undefined
              ? {}
              : {
                  workerEntries: Object.fromEntries(
                    Object.entries(record(manifest.workerEntries)).map(([name, raw]) => {
                      const worker = record(raw);
                      if (typeof worker.module !== "string" || updated[worker.module] === undefined)
                        throw new Error("Synthetic worker module missing");
                      return [name, { ...worker, preparedBytes: updated[worker.module]!.bytes }];
                    }),
                  ),
                }),
          }
        : {};
    const next = { ...manifest, modules: updated, ...cliMetadata };
    files.set(path, encode(next));
  };
  modules("cli");
  modules("sdk");
  const manifest = envelope(JSON.parse(new TextDecoder().decode(files.get("manifest.json")!)));
  files.delete("manifest.json");
  const bytes = serializeHarnessReleaseArtifactManifest({
    ...manifest,
    files: Object.fromEntries(
      [...files].map(([path, value]) => [path, { bytes: value.length, sha256: hash(value) }]),
    ),
  });
  files.set("manifest.json", bytes);
  const artifactHash = hash(bytes);
  return {
    files,
    fullArtifact: {
      ...variant.fullArtifact,
      fixtureIdentity: "synthetic-deploy3",
      artifactHash,
      artifactRef: `sha256:${artifactHash}`,
    },
  };
}
