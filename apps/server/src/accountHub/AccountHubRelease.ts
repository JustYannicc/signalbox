// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
/**
 * The pinned CLIProxyAPI release the account hub runs, and its installer.
 *
 * Downloads are size- and SHA-256-checked against the shared release manifest
 * before anything is unpacked. A version directory only counts as installed
 * once its completion record is written, so an interrupted install is retried
 * from scratch instead of being half-used.
 *
 * @module accountHub/AccountHubRelease
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
// Lives in the Docker context so the image and installer share the same pins.
import release from "../../../../apps/cloud/containers/cliproxyapi/release.json" with { type: "json" };

export const ACCOUNT_HUB_VERSION = release.version;

export interface AccountHubAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

const ASSETS: Record<string, AccountHubAsset> = release.platforms;

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
