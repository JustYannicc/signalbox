// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - preserve the profiler's native binary HTTP response.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeZlib from "node:zlib";
import { digest, writeJson } from "./ciArchive.ts";
import type { Cloudflare, OwnedWorker } from "./ciCloudflare.ts";

export function redact(text: string, secrets: string[]) {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.replaceAll(/https?:\/\/[^\s"'<>\\]+/g, "[url]");
}

// Only the pprof wire structure is decoded here. The raw curl bytes remain untouched for pprof.
function fields(bytes: Uint8Array) {
  let offset = 0;
  const variable = () => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated protobuf");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid protobuf varint");
  };
  const result: { number: number; value: number | Uint8Array }[] = [];
  while (offset < bytes.length) {
    const tag = variable();
    const wire = tag & 7;
    if (tag < 8) throw new Error("Invalid protobuf tag");
    if (wire === 0) result.push({ number: Math.floor(tag / 8), value: variable() });
    else if (wire === 2) {
      const length = variable();
      if (!Number.isSafeInteger(length) || offset + length > bytes.length)
        throw new Error("Invalid protobuf length");
      result.push({ number: Math.floor(tag / 8), value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error("Truncated protobuf fixed field");
    } else throw new Error("Unsupported protobuf wire type");
  }
  return result;
}

export function inspectProfile(raw: Uint8Array) {
  const gzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const body = gzip ? NodeZlib.gunzipSync(raw, { maxOutputLength: 128 * 1024 * 1024 }) : raw;
  const decoded = fields(body);
  const strings = decoded
    .filter((f) => f.number === 6)
    .map((f) => {
      if (!(f.value instanceof Uint8Array)) throw new Error("Invalid pprof string table");
      return Buffer.from(f.value).toString("utf8");
    });
  const types = decoded
    .filter((f) => f.number === 1)
    .map((f) => {
      if (!(f.value instanceof Uint8Array)) throw new Error("Invalid pprof sample type");
      const value = fields(f.value);
      return {
        type: strings[Number(value.find((v) => v.number === 1)?.value ?? 0)],
        unit: strings[Number(value.find((v) => v.number === 2)?.value ?? 0)],
      };
    });
  if (strings[0] !== "" || !types.length || types.some((t) => !t.type || !t.unit))
    throw new Error("Response is not a pprof Profile");
  const labelKeys = new Set<string>();
  for (const sample of decoded.filter((f) => f.number === 2)) {
    if (!(sample.value instanceof Uint8Array)) throw new Error("Invalid pprof sample");
    for (const label of fields(sample.value).filter((f) => f.number === 3)) {
      if (!(label.value instanceof Uint8Array)) throw new Error("Invalid pprof label");
      const key = fields(label.value).find((f) => f.number === 1)?.value;
      if (typeof key === "number" && strings[key]) labelKeys.add(strings[key]);
    }
  }
  return {
    gzip,
    sampleTypes: types,
    labelKeys: [...labelKeys],
    sampleCount: decoded.filter((f) => f.number === 2).length,
  };
}

export interface CurlRequest {
  url: string;
  token: string;
  body: string;
  output: string;
  headers: string;
}
export const curlBinary = (request: CurlRequest): Promise<{ exit: number; status: number }> =>
  new Promise((resolve, reject) => {
    if (!/^[\w.-]+$/.test(request.token)) return reject(new Error("Unsafe curl credential"));
    const child = NodeChildProcess.spawn(
      "curl",
      [
        "--silent",
        "--show-error",
        "--config",
        "-",
        "--request",
        "POST",
        "--url",
        request.url,
        "--header",
        "Content-Type: application/json",
        "--data-binary",
        request.body,
        "--max-time",
        "75",
        "--output",
        request.output,
        "--dump-header",
        request.headers,
        "--write-out",
        "%{http_code}",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let status = "";
    child.stdout.on("data", (chunk: Buffer) => {
      status += chunk.toString();
    });
    // curl's stderr can include the private endpoint; only the numeric exit is persisted.
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (exit) => resolve({ exit: exit ?? -1, status: Number(status) || 0 }));
    child.stdin.on("error", () => {});
    child.stdin.end(`header = "Authorization: Bearer ${request.token}"\n`);
  });

export async function captureProfile(
  cloud: Cloudflare,
  owner: OwnedWorker,
  dir: string,
  scratch: string,
  phase: "during-cold-request" | "after-cold-request",
  secrets: string[],
  runCurl = curlBinary,
) {
  if (!owner.actor || !owner.namespace || !owner.version)
    throw new Error("Missing exact profile target");
  const output = NodePath.join(scratch, `${owner.script}.body`);
  const headers = NodePath.join(scratch, `${owner.script}.headers`);
  const request = {
    duration_ms: 1000,
    profile_type: "heap",
    namespace_id: owner.namespace,
    actor_id: owner.actor,
  };
  const receipt: Record<string, unknown> = {
    script: owner.script,
    version: owner.version,
    namespace: owner.namespace,
    actor: owner.actor,
    request,
    phase,
    scope: "supervisor-only",
    childFramesVerified: false,
    limitation:
      "No public dynamic-child selector. Already-loaded startup allocations are missed. Allocation samples do not establish retained heap or peak memory.",
    curlCompressed: false,
  };
  try {
    const result = await runCurl({
      url: `${cloud.base}/workers/workers/${owner.script}/versions/${owner.version}/profile`,
      token: cloud.token,
      body: JSON.stringify(request),
      output,
      headers,
    });
    Object.assign(receipt, { httpStatus: result.status, curlExit: result.exit });
    const bytes = await NodeFSP.readFile(output).catch(() => Buffer.alloc(0));
    const rawHeaders = await NodeFSP.readFile(headers, "utf8").catch(() => "");
    for (const name of ["content-type", "content-encoding"]) {
      receipt[name] = rawHeaders.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
    }
    if (result.status !== 200 || result.exit !== 0)
      throw new Error(`Profile HTTP ${result.status}, curl exit ${result.exit}`);
    Object.assign(receipt, JSON.parse(redact(JSON.stringify(inspectProfile(bytes)), secrets)), {
      bytes: bytes.length,
      sha256: digest(bytes),
      magicHex: bytes.subarray(0, 16).toString("hex"),
      valid: true,
    });
    await NodeFSP.rename(output, NodePath.join(dir, "supervisor.pprof"));
  } catch (error) {
    receipt.valid = false;
    receipt.error = redact(String(error), secrets);
    const body = await NodeFSP.readFile(output, "utf8").catch(() => "");
    await writeJson(NodePath.join(dir, "profile-error.json"), {
      httpStatus: receipt.httpStatus ?? null,
      error: receipt.error,
      body: redact(body.slice(0, 64_000), secrets),
    });
  } finally {
    await writeJson(NodePath.join(dir, "profile-receipt.json"), receipt);
    await NodeFSP.rm(output, { force: true });
    await NodeFSP.rm(headers, { force: true });
  }
  return receipt.valid === true;
}
