import { EGRESS_CA } from "@signalbox/runner-protocol/RunnerProtocol";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";

/**
 * On a light machine every HTTPS request goes through the thread's egress
 * check (#592), outside the container, which re-signs it with a CA Cloudflare
 * puts here when the container starts. The Runner trusts it before anything
 * else runs, for itself and everything the harnesses start:
 *
 * - Node (the Runner, Claude Code, Bun) through `NODE_EXTRA_CA_CERTS`, which
 *   the machine's backend sets as Node starts;
 * - OpenSSL, GnuTLS, Go and Rust's native roots (curl, git, wget, pip's
 *   system Python) through the system bundle, which the image lets the Runner
 *   add to; Python's `requests` through `REQUESTS_CA_BUNDLE`;
 * - the machine's browser through its NSS database.
 *
 * Without the CA (a boat VM, a developer's machine) nothing changes. A step
 * that fails leaves that client refusing intercepted HTTPS, which is logged.
 */

const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** The variables it sets, for the harnesses to inherit (`RunnerModelAccess.ts`). */
export const EGRESS_TRUST_VARIABLES = ["REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"] as const;

export const trustEgressCa = Effect.fn("trustEgressCa")(function* (
  environment: NodeJS.ProcessEnv,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(EGRESS_CA).pipe(Effect.orElseSucceed(() => false)))) return false;
  const bundled = yield* Effect.gen(function* () {
    const ca = (yield* fs.readFileString(EGRESS_CA)).trim();
    const bundle = yield* fs.readFileString(SYSTEM_BUNDLE);
    if (!bundle.includes(ca)) yield* fs.writeFileString(SYSTEM_BUNDLE, `${ca}\n`, { flag: "a" });
    return true;
  }).pipe(
    Effect.catch(() =>
      Effect.as(Effect.logWarning("couldn't add the egress CA to the system bundle"), false),
    ),
  );
  if (bundled) {
    environment.REQUESTS_CA_BUNDLE = SYSTEM_BUNDLE;
    environment.SSL_CERT_FILE = SYSTEM_BUNDLE;
  }
  // Chromium reads its trust from the user's NSS database, made on first use.
  const nssdb = path.join(home, ".pki", "nssdb");
  yield* fs.makeDirectory(nssdb, { recursive: true }).pipe(Effect.ignore);
  const certutil = (args: ReadonlyArray<string>) =>
    spawnAndCollect("certutil", ChildProcess.make("certutil", args, { stdin: "ignore" })).pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
    );
  if (!(yield* fs.exists(path.join(nssdb, "cert9.db")).pipe(Effect.orElseSucceed(() => false)))) {
    yield* certutil(["-d", `sql:${nssdb}`, "-N", "--empty-password"]);
  }
  const browser = yield* certutil([
    "-d",
    `sql:${nssdb}`,
    "-A",
    "-t",
    "C,,",
    "-n",
    "signalbox-egress",
    "-i",
    EGRESS_CA,
  ]);
  if (!browser) yield* Effect.logWarning("couldn't add the egress CA to the browser's trust");
  return true;
});
