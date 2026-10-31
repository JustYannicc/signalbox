// @effect-diagnostics nodeBuiltinImport:off - Profiler tooling identity is read by the standalone Node deployment adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { sha256 } from "./payload.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const StartupRuntime = Schema.Struct({
  node: Schema.String,
  nodeSha256: Hash,
  wrangler: Schema.String,
  wranglerSha256: Hash,
  miniflare: Schema.String,
  miniflareSha256: Hash,
  workerd: Schema.String,
  workerdSha256: Hash,
  platform: Schema.String,
  arch: Schema.String,
});
const packageVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
const workerdModule = Schema.decodeUnknownSync(
  Schema.Struct({ default: Schema.String, version: Schema.String }),
);

export async function profilerRuntime() {
  const require = NodeModule.createRequire(import.meta.url);
  const wranglerPackage = require.resolve("wrangler/package.json");
  const miniflarePackage =
    NodeModule.createRequire(wranglerPackage).resolve("miniflare/package.json");
  const workerd = workerdModule(NodeModule.createRequire(miniflarePackage)("workerd"));
  const wranglerCli = NodePath.join(NodePath.dirname(wranglerPackage), "wrangler-dist/cli.js");
  const nodeExecutable = await NodeFSP.realpath(process.execPath);
  const workerdExecutable = await NodeFSP.realpath(workerd.default);
  const [nodeBytes, wranglerBytes, workerdBytes, packageJson, miniflareJson, miniflareBytes] =
    await Promise.all([
      NodeFSP.readFile(nodeExecutable),
      NodeFSP.readFile(wranglerCli),
      NodeFSP.readFile(workerdExecutable),
      NodeFSP.readFile(wranglerPackage, "utf8"),
      NodeFSP.readFile(miniflarePackage, "utf8"),
      NodeFSP.readFile(NodeModule.createRequire(wranglerPackage).resolve("miniflare")),
    ]);
  return {
    nodeExecutable,
    wranglerCli,
    workerdExecutable,
    identity: {
      node: process.version,
      nodeSha256: sha256(nodeBytes),
      wrangler: packageVersion(JSON.parse(packageJson)).version,
      wranglerSha256: sha256(wranglerBytes),
      miniflare: packageVersion(JSON.parse(miniflareJson)).version,
      miniflareSha256: sha256(miniflareBytes),
      workerd: workerd.version,
      workerdSha256: sha256(workerdBytes),
      platform: HostProcess.Platform.defaultValue(),
      arch: HostProcess.Architecture.defaultValue(),
    },
  };
}
