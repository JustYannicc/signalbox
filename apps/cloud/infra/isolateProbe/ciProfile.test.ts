// @effect-diagnostics nodeBuiltinImport:off - exercise standalone Node CI tooling with isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Cloudflare } from "./ciCloudflare.ts";
import {
  captureProfile,
  curlBinary,
  inspectProfile,
  redact,
  type CurlRequest,
} from "./ciProfile.ts";
import { digest, json } from "./ciArchive.ts";

const protobuf = Buffer.from([
  10,
  4,
  8,
  1,
  16,
  2,
  50,
  0,
  50,
  5,
  ...Buffer.from("space"),
  50,
  5,
  ...Buffer.from("bytes"),
]);
const directories: string[] = [];
const temporary = async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-ci-profile-"));
  directories.push(dir);
  return dir;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("binary profile capture", () => {
  it("keeps curl bytes unchanged and records exact version/root selectors without claiming child coverage", async () => {
    const dir = await temporary();
    const scratch = await temporary();
    const bytes = NodeZlib.gzipSync(protobuf);
    const runCurl = vi.fn(async (request: CurlRequest) => {
      expect(request.url.endsWith("/versions/version-uuid/profile")).toBe(true);
      expect(JSON.parse(request.body)).toEqual({
        duration_ms: 1000,
        profile_type: "heap",
        namespace_id: "namespace",
        actor_id: "a".repeat(64),
      });
      await NodeFSP.writeFile(request.output, bytes);
      await NodeFSP.writeFile(
        request.headers,
        "HTTP/2 200\r\ncontent-type: application/vnd.google.protobuf\r\ncontent-encoding: gzip\r\nset-cookie: do-not-upload\r\n",
      );
      return { exit: 0, status: 200 };
    });
    const cloud = new Cloudflare("a".repeat(32), "fake-ci-token");
    const owner = {
      script: `sb-isolate-probe-${"b".repeat(24)}`,
      version: "version-uuid",
      namespace: "namespace",
      actor: "a".repeat(64),
    };
    expect(
      await captureProfile(cloud, owner, dir, scratch, "during-cold-request", [], runCurl),
    ).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(dir, "supervisor.pprof"))).toEqual(bytes);
    expect(await json(NodePath.join(dir, "profile-receipt.json"))).toMatchObject({
      valid: true,
      sha256: digest(bytes),
      httpStatus: 200,
      scope: "supervisor-only",
      childFramesVerified: false,
      gzip: true,
      sampleTypes: [{ type: "space", unit: "bytes" }],
    });
    expect(await NodeFSP.readdir(scratch)).toEqual([]);
    expect(
      await NodeFSP.readFile(NodePath.join(dir, "profile-receipt.json"), "utf8"),
    ).not.toContain("do-not-upload");
  });

  it.each([403, 200])(
    "preserves HTTP %i JSON errors without producing a fake pprof",
    async (status) => {
      const dir = await temporary();
      const scratch = await temporary();
      const runCurl = async (request: CurlRequest) => {
        await NodeFSP.writeFile(
          request.output,
          JSON.stringify({
            errors: [
              {
                code: 10393,
                message: "No recent executions https://private.workers.dev credential",
              },
            ],
          }),
        );
        await NodeFSP.writeFile(
          request.headers,
          `HTTP/2 ${status}\r\ncontent-type: application/json\r\n`,
        );
        return { status, exit: 0 };
      };
      const cloud = new Cloudflare("a".repeat(32), "fake-ci-token");
      const owner = { script: "owned", version: "v", namespace: "ns", actor: "a".repeat(64) };
      expect(
        await captureProfile(
          cloud,
          owner,
          dir,
          scratch,
          "after-cold-request",
          ["credential"],
          runCurl,
        ),
      ).toBe(false);
      expect(await NodeFSP.readdir(dir)).toEqual(["profile-error.json", "profile-receipt.json"]);
      const error = await NodeFSP.readFile(NodePath.join(dir, "profile-error.json"), "utf8");
      expect(error).toContain(`"httpStatus": ${status}`);
      expect(error).toContain("10393");
      expect(error).not.toContain("private.workers.dev");
      expect(error).not.toContain("credential");
    },
  );

  it("rejects gzip that is not a pprof message and malformed protobuf", () => {
    expect(() => inspectProfile(NodeZlib.gzipSync(Buffer.from("not a profile")))).toThrow();
    expect(() => inspectProfile(Buffer.from([50, 255]))).toThrow();
  });

  it("passes curl authorization only through stdin and requires raw --output without --compressed", async () => {
    const dir = await temporary();
    const executable = NodePath.join(dir, "curl");
    const args = NodePath.join(dir, "args.json");
    const config = NodePath.join(dir, "stdin.txt");
    await NodeFSP.writeFile(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(config)},fs.readFileSync(0));process.stdout.write('200');\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
    try {
      expect(
        await curlBinary({
          url: "https://api.cloudflare.com/test",
          token: "fake-ci-token",
          body: "{}",
          output: "/output",
          headers: "/headers",
        }),
      ).toEqual({ exit: 0, status: 200 });
      const argv = await json(args);
      expect(argv).toEqual(expect.arrayContaining(["--output", "/output", "--config", "-"]));
      expect(argv).not.toContain("--compressed");
      expect(JSON.stringify(argv)).not.toContain("fake-ci-token");
      expect(await NodeFSP.readFile(config, "utf8")).toBe(
        'header = "Authorization: Bearer fake-ci-token"\n',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redacts credentials and private URLs", () => {
    expect(redact("Bearer credential https://private.workers.dev/a", ["credential"])).toBe(
      "Bearer [redacted] [url]",
    );
  });
});
