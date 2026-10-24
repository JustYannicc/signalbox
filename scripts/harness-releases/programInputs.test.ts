import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { sha256 } from "./fixture.ts";
import { fetchProgramInputs } from "./programInputs.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-program-inputs-"));
  directories.push(directory);
  const bodies = new Map<string, Uint8Array>();
  const entry = (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const url = `https://programs.invalid/${name}`;
    bodies.set(url, bytes);
    return { url, bytes: bytes.length, sha256: sha256(bytes) };
  };
  const manifest = {
    schemaVersion: 1,
    programs: Object.fromEntries(
      ["bash", "busybox", "ripgrep", "sed", "coreutils"].map((name) => [
        name,
        { ...entry(name, `wasm:${name}`), provenance: entry(`${name}.json`, `source:${name}`) },
      ]),
    ),
  };
  const manifestPin = entry("manifest.json", JSON.stringify(manifest));
  const calls: string[] = [];
  const fetchAsset: typeof fetch = async (url) => {
    const key = String(url);
    calls.push(key);
    const body = bodies.get(key);
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
  };
  return {
    output: NodePath.join(directory, "programs"),
    bodies,
    calls,
    manifestPin,
    options: { fetch: fetchAsset, manifest: manifestPin },
  };
}

it("downloads exact program and provenance bytes from the pinned manifest", async () => {
  const input = await fixture();
  const result = await fetchProgramInputs(input.output, input.options);
  expect(await NodeFSP.readFile(result.bash!, "utf8")).toBe("wasm:bash");
  expect(await NodeFSP.readFile(result.busybox!, "utf8")).toBe("wasm:busybox");
  expect(await NodeFSP.readFile(result.ripgrep!, "utf8")).toBe("wasm:ripgrep");
  expect(await NodeFSP.readFile(result.sed!, "utf8")).toBe("wasm:sed");
  expect(await NodeFSP.readFile(NodePath.join(input.output, "coreutils.tar"), "utf8")).toBe(
    "wasm:coreutils",
  );
  expect(await NodeFSP.readFile(NodePath.join(input.output, "bash.provenance.json"), "utf8")).toBe(
    "source:bash",
  );
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(input.output, "verified-inputs.json"), "utf8")),
  ).toMatchObject({
    manifest: input.manifestPin,
    programs: [
      { name: "bash" },
      { name: "busybox" },
      { name: "ripgrep" },
      { name: "sed" },
      { name: "coreutils" },
    ],
  });
});

it("rejects a changed manifest before downloading programs", async () => {
  const input = await fixture();
  input.bodies.set(input.manifestPin.url, new TextEncoder().encode("{}"));
  await expect(fetchProgramInputs(input.output, input.options)).rejects.toThrow(
    "RELEASE_PROGRAM_INPUT_HASH_MISMATCH",
  );
  expect(input.calls).toEqual([input.manifestPin.url]);
});

it.each(["corrupt", "missing", "provenance"])(
  "rejects %s input without leaving a usable output",
  async (mode) => {
    const input = await fixture();
    const key =
      mode === "provenance"
        ? "https://programs.invalid/bash.json"
        : "https://programs.invalid/bash";
    if (mode === "missing") input.bodies.delete(key);
    else
      input.bodies.set(key, new TextEncoder().encode(mode === "corrupt" ? "WASM:bash" : "wrong"));
    await expect(fetchProgramInputs(input.output, input.options)).rejects.toThrow(
      mode === "missing"
        ? "RELEASE_PROGRAM_DOWNLOAD_FAILED:404"
        : "RELEASE_PROGRAM_INPUT_HASH_MISMATCH",
    );
    await expect(NodeFSP.stat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("leaves an existing output intact", async () => {
  const input = await fixture();
  await NodeFSP.mkdir(input.output);
  await NodeFSP.writeFile(NodePath.join(input.output, "keep"), "preserved");
  await expect(fetchProgramInputs(input.output, input.options)).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await NodeFSP.readFile(NodePath.join(input.output, "keep"), "utf8")).toBe("preserved");
});
