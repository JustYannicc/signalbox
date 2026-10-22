import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { object, sha256 } from "./fixture.ts";

const PROGRAM_MANIFEST = {
  url: "https://github.com/JustYannicc/signalbox/releases/download/kernel-programs-20261022-c3e8dc79-791b862a/program-inputs.json",
  sha256: "277da52b48ee0f7aac3bc043696a934ee26132a83e417ee60c48522883745d17",
};
const PROGRAM_FILES = { bash: "bash.wasm", busybox: "busybox.wasm", ripgrep: "rg.wasm" } as const;

type Asset = { readonly url: string; readonly bytes: number; readonly sha256: string };

function asset(value: unknown): Asset {
  const entry = object(value);
  if (
    typeof entry.url !== "string" ||
    new URL(entry.url).protocol !== "https:" ||
    typeof entry.bytes !== "number" ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("RELEASE_PROGRAM_INPUT_INVALID");
  return { url: entry.url, bytes: entry.bytes, sha256: entry.sha256 };
}

export async function fetchProgramInputs(
  output: string,
  options: {
    readonly fetch?: typeof fetch;
    readonly manifest?: { readonly url: string; readonly sha256: string };
  } = {},
) {
  const fetchAsset = options.fetch ?? fetch;
  const manifestPin = options.manifest ?? PROGRAM_MANIFEST;
  const read = async (pin: {
    readonly url: string;
    readonly sha256: string;
    readonly bytes?: number;
  }) => {
    const response = await fetchAsset(pin.url);
    if (!response.ok) throw new Error(`RELEASE_PROGRAM_DOWNLOAD_FAILED:${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if ((pin.bytes !== undefined && bytes.length !== pin.bytes) || sha256(bytes) !== pin.sha256)
      throw new Error("RELEASE_PROGRAM_INPUT_HASH_MISMATCH");
    return bytes;
  };
  const manifestBytes = await read(manifestPin);
  const manifest = object(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (manifest.schemaVersion !== 1) throw new Error("RELEASE_PROGRAM_MANIFEST_VERSION");
  const programs = object(manifest.programs);
  const entries = Object.entries(PROGRAM_FILES).map(([name, file]) => {
    const entry = object(programs[name]);
    return { name, file, program: asset(entry), provenance: asset(entry.provenance) };
  });
  const root = NodePath.resolve(output);
  await NodeFSP.mkdir(NodePath.dirname(root), { recursive: true });
  await NodeFSP.mkdir(root);
  try {
    const downloads = await Promise.allSettled(
      entries.map(async (entry) => ({
        ...entry,
        bytes: await read(entry.program),
        provenanceBytes: await read(entry.provenance),
      })),
    );
    const receipts = [];
    for (const result of downloads) {
      if (result.status === "rejected") throw result.reason;
      const { name, file, program, provenance, bytes, provenanceBytes } = result.value;
      await NodeFSP.writeFile(NodePath.join(root, file), bytes, { flag: "wx" });
      await NodeFSP.writeFile(NodePath.join(root, `${name}.provenance.json`), provenanceBytes, {
        flag: "wx",
      });
      receipts.push({ name, file, ...program, provenance });
    }
    await NodeFSP.writeFile(NodePath.join(root, "program-inputs.json"), manifestBytes, {
      flag: "wx",
    });
    await NodeFSP.writeFile(
      NodePath.join(root, "verified-inputs.json"),
      `${JSON.stringify({ manifest: manifestPin, programs: receipts }, null, 2)}\n`,
      { flag: "wx" },
    );
    return Object.fromEntries(entries.map(({ name, file }) => [name, NodePath.join(root, file)]));
  } catch (error) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
}
