// @effect-diagnostics nodeBuiltinImport:off - builds a fixture archive with the system tar.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { ACCOUNT_HUB_VERSION, installAccountHub } from "./AccountHubRelease.ts";

const makeArchive = Effect.fn("test.makeArchive")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-archive-" });
  yield* fs.writeFileString(`${source}/cli-proxy-api`, "#!/bin/sh\necho hub\n", { mode: 0o644 });
  yield* fs.writeFileString(`${source}/README.md`, "not extracted\n");
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    `${source}/hub.tar.gz`,
    "-C",
    source,
    "cli-proxy-api",
    "README.md",
  ]);
  const bytes = yield* fs.readFile(`${source}/hub.tar.gz`);
  return {
    bytes,
    asset: {
      name: "hub.tar.gz",
      bytes: bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    },
  };
});

const serving = (body: Uint8Array, onRequest: () => void) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      onRequest();
      return Object.defineProperty(
        HttpClientResponse.fromWeb(request, new Response(null)),
        "stream",
        {
          value: Stream.succeed(body),
        },
      );
    }),
  );

it.layer(NodeServices.layer)("installAccountHub", (it) => {
  it.effect("installs the pinned executable once and reuses it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { bytes, asset } = yield* makeArchive();
      const toolsDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-tools-" });
      let downloads = 0;
      const install = installAccountHub({
        toolsDirectory,
        platform: "darwin",
        arch: "arm64",
        asset,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          serving(bytes, () => downloads++),
        ),
      );

      const executable = yield* install;
      expect(executable).toBe(`${toolsDirectory}/${ACCOUNT_HUB_VERSION}/cli-proxy-api`);
      const info = yield* fs.stat(executable);
      expect(info.mode & 0o111).not.toBe(0);
      expect(yield* fs.exists(`${toolsDirectory}/${ACCOUNT_HUB_VERSION}/README.md`)).toBe(false);

      expect(yield* install).toBe(executable);
      expect(downloads).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("installs nothing when the download fails its checksum", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { bytes, asset } = yield* makeArchive();
      const toolsDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "account-hub-tools-" });
      const error = yield* installAccountHub({
        toolsDirectory,
        platform: "linux",
        arch: "x64",
        asset: { ...asset, sha256: "0".repeat(64) },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          serving(bytes, () => undefined),
        ),
        Effect.flip,
      );
      expect(error.detail).toContain("SHA-256");
      expect(yield* fs.exists(`${toolsDirectory}/${ACCOUNT_HUB_VERSION}`)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses platforms without a pinned release", () =>
    Effect.gen(function* () {
      const error = yield* installAccountHub({
        toolsDirectory: "/nonexistent",
        platform: "aix",
        arch: "ppc64",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          serving(new Uint8Array(), () => undefined),
        ),
        Effect.flip,
      );
      expect(error.detail).toContain("aix-ppc64");
    }),
  );
});
