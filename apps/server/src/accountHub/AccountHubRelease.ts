// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
/**
 * The pinned CLIProxyAPI release the account hub runs, and its installer.
 *
 * Downloads are size- and SHA-256-checked against the table below before
 * anything is unpacked, and a version directory only counts as installed
 * once its completion record is written, so an interrupted install is
 * retried from scratch instead of being half-used.
 *
 * @module accountHub/AccountHubRelease
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";

export const ACCOUNT_HUB_VERSION = "8.0.15";

export interface AccountHubAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

// From https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.15 checksums.txt.
const ASSETS: Record<string, AccountHubAsset> = {
  "darwin-arm64": {
    name: "CLIProxyAPI_8.0.15_darwin_aarch64.tar.gz",
    bytes: 21_236_900,
    sha256: "90fe6d309613b33520b9f08746829dd6c4fdfbbbb353f41ac01e4e94f168f7c4",
  },
  "darwin-x64": {
    name: "CLIProxyAPI_8.0.15_darwin_amd64.tar.gz",
    bytes: 22_989_862,
    sha256: "d0f69a00d9ab3a514a96159542dec6632dbfef03e74dc9f8224b7edad9b5ca6f",
  },
  "linux-arm64": {
    name: "CLIProxyAPI_8.0.15_linux_aarch64.tar.gz",
    bytes: 20_764_980,
    sha256: "172f1f71dc0381538c09f44a65c687b55035c61ff63f505a6b7edd4fc7b69c95",
  },
  "linux-x64": {
    name: "CLIProxyAPI_8.0.15_linux_amd64.tar.gz",
    bytes: 23_032_196,
    sha256: "3acca2d978ba140b4b664bcfb74acea8f6c9a32c24fa6e2d58130f6c1128d3a8",
  },
  "win32-arm64": {
    name: "CLIProxyAPI_8.0.15_windows_aarch64.zip",
    bytes: 20_795_935,
    sha256: "8c95ec34b604b0aaebd138e8c9d9a4ed1d222e28adb231427b794b6f1560cb8f",
  },
  "win32-x64": {
    name: "CLIProxyAPI_8.0.15_windows_amd64.zip",
    bytes: 23_308_755,
    sha256: "948febbab9d9192c359fc655b2f10e12469ebab6551b8b2c9008f51593ef62b9",
  },
};

export const resolveAccountHubAsset = (platform: NodeJS.Platform, arch: string) =>
  ASSETS[`${platform}-${arch}`] ?? null;

export class AccountHubInstallError extends Schema.TaggedError<AccountHubInstallError>()(
  "AccountHubInstallError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

const isInstallError = Schema.is(AccountHubInstallError);
const Completion = Schema.Struct({ version: Schema.String, sha256: Schema.String });
const encodeCompletion = Schema.encodeEffect(Schema.fromJsonString(Completion));
const decodeCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(Completion));

const fail = (detail: string) => (cause: unknown) => new AccountHubInstallError({ detail, cause });

/**
 * Returns the hub executable inside `toolsDirectory`, downloading and
 * verifying the pinned release first when it is missing.
 */
export const installAccountHub = Effect.fn("AccountHubRelease.install")(
  function* (options: {
    readonly toolsDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    /** Overrides the GitHub release URL, for tests. */
    readonly downloadUrl?: string;
    readonly asset?: AccountHubAsset;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const asset = options.asset ?? resolveAccountHubAsset(options.platform, options.arch);
    if (!asset) {
      return yield* new AccountHubInstallError({
        detail: `The account hub does not run on ${options.platform}-${options.arch}.`,
      });
    }
    const executableName = options.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
    const directory = path.join(options.toolsDirectory, ACCOUNT_HUB_VERSION);
    const executablePath = path.join(directory, executableName);
    const completionPath = path.join(directory, ".install-complete.json");

    const installed = yield* fs.readFileString(completionPath).pipe(
      Effect.flatMap(decodeCompletion),
      Effect.map(
        (record) => record.version === ACCOUNT_HUB_VERSION && record.sha256 === asset.sha256,
      ),
      Effect.orElseSucceed(() => false),
    );
    if (installed && (yield* fs.exists(executablePath))) return executablePath;

    yield* fs.makeDirectory(options.toolsDirectory, { recursive: true });
    yield* fs.remove(directory, { recursive: true, force: true });
    yield* Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: options.toolsDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, asset.name);
      const runtime = path.join(staging, "runtime");
      yield* fs.makeDirectory(runtime);

      const url =
        options.downloadUrl ??
        `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${ACCOUNT_HUB_VERSION}/${asset.name}`;
      const hash = NodeCrypto.createHash("sha256");
      let downloaded = 0;
      const response = yield* http
        .execute(HttpClientRequest.get(url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloaded += chunk.byteLength;
            if (downloaded > asset.bytes) {
              return yield* new AccountHubInstallError({
                detail: "The account hub download is larger than the pinned release.",
              });
            }
            hash.update(chunk);
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        Effect.timeout("15 minutes"),
      );
      if (downloaded !== asset.bytes || hash.digest("hex") !== asset.sha256) {
        return yield* new AccountHubInstallError({
          detail:
            "The account hub download failed its size or SHA-256 check. Nothing was installed.",
        });
      }

      // bsdtar unpacks both tarballs and Windows zips; only the executable is kept.
      const exitCode = yield* spawner
        .spawn(
          ChildProcess.make("tar", ["-xf", archivePath, "-C", runtime, executableName], {
            shell: false,
          }),
        )
        .pipe(Effect.flatMap((child) => child.exitCode));
      if (exitCode !== 0) {
        return yield* new AccountHubInstallError({ detail: "Could not unpack the account hub." });
      }
      const unpacked = path.join(runtime, executableName);
      const info = yield* fs.stat(unpacked);
      if (info.type !== "File" || Number(info.size) === 0) {
        return yield* new AccountHubInstallError({
          detail: "The account hub package is incomplete.",
        });
      }
      if (options.platform !== "win32") yield* fs.chmod(unpacked, 0o755);
      yield* fs.writeFileString(
        path.join(runtime, ".install-complete.json"),
        yield* encodeCompletion({ version: ACCOUNT_HUB_VERSION, sha256: asset.sha256 }),
        { flag: "wx", mode: 0o600 },
      );
      yield* fs.rename(runtime, directory);
    }).pipe(Effect.scoped);
    return executablePath;
  },
  Effect.mapError((cause) =>
    isInstallError(cause)
      ? cause
      : fail("Could not install the account hub. Check the network and disk space.")(cause),
  ),
);
