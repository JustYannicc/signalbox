import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { record, sha256, text as requiredText } from "./guards.ts";

export { sha256 };
export const object = (value: unknown) => record(value, "RELEASE_EVIDENCE_OBJECT_REQUIRED");
const text = (value: unknown) => requiredText(value, "RELEASE_EVIDENCE_TEXT_REQUIRED");

export interface FrozenFixture {
  readonly id: string;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly inventory: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly requests: ReadonlyArray<{
    readonly path: string;
    readonly method: string;
    readonly contentType?: string;
    readonly payload?: {
      readonly bytes: number;
      readonly sha256: string;
      readonly bodyFile: string;
    };
  }>;
}

/** Captures the existing isolate-probe input contract without executing the guest. */
export async function freezeFixture(directory: string): Promise<FrozenFixture> {
  const root = await NodeFSP.realpath(directory);
  const read = async (path: string) => {
    if (NodePath.isAbsolute(path) || NodePath.win32.isAbsolute(path))
      throw new Error("RELEASE_FIXTURE_PATH_ESCAPE");
    const absolute = await NodeFSP.realpath(NodePath.resolve(root, path));
    const relative = NodePath.relative(root, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new Error("RELEASE_FIXTURE_PATH_ESCAPE");
    return NodeFSP.readFile(absolute);
  };
  const manifest = await read("manifest.json");
  const input = object(JSON.parse(manifest.toString("utf8")));
  if (input.mode !== "facet") throw new Error("RELEASE_PROOF_REQUIRES_FACET");
  const id = text(input.id);
  const inventory = [];
  for (const [name, raw] of Object.entries(object(input.modules)).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = object(raw);
    const type = text(entry.type);
    if (!["js", "cjs", "text", "wasm"].includes(type))
      throw new Error("RELEASE_FIXTURE_MODULE_TYPE");
    const bytes = await read(text(entry.path));
    inventory.push({ name, type, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (!inventory.some((entry) => entry.name === input.mainModule))
    throw new Error("RELEASE_FIXTURE_MAIN_MISSING");
  text(input.entrypoint);
  if (Object.hasOwn(input, "paths") === Object.hasOwn(input, "requests"))
    throw new Error("RELEASE_FIXTURE_REQUESTS_REQUIRED");
  const rawRequests = input.paths ?? input.requests;
  if (!Array.isArray(rawRequests) || !rawRequests.length) throw new Error("RELEASE_FIXTURE_EMPTY");
  const requests = [];
  for (const value of rawRequests) {
    const request = typeof value === "string" ? { path: value } : object(value);
    const bodyFile = request.bodyFile === undefined ? undefined : text(request.bodyFile);
    const payload = bodyFile === undefined ? undefined : await read(bodyFile);
    requests.push({
      path: text(request.path),
      method: request.method === undefined ? "GET" : text(request.method),
      ...(request.contentType === undefined ? {} : { contentType: text(request.contentType) }),
      ...(payload && bodyFile
        ? { payload: { bytes: payload.length, sha256: sha256(payload), bodyFile } }
        : {}),
    });
  }
  const frozen = { id, manifestSha256: sha256(manifest), inventory, requests };
  return { ...frozen, sha256: sha256(JSON.stringify(frozen)) };
}

export function assertFixtureUnchanged(before: FrozenFixture, after: FrozenFixture) {
  if (before.sha256 !== after.sha256) throw new Error("RELEASE_FIXTURE_CHANGED");
}
