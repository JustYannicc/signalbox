// @effect-diagnostics nodeBuiltinImport:off - disposable local Git remote, never live userdata.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function createLocalGitRemote() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "node-git-refspecs-"));
  const remote = NodePath.join(root, "remote");
  const client = NodePath.join(root, "client");
  function run(dir: string, args: readonly string[], input?: Uint8Array) {
    return NodeChildProcess.spawnSync("git", ["-C", dir, ...args], {
      input,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      },
    });
  }
  function checked(dir: string, args: readonly string[]) {
    const result = run(dir, args);
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  checked(root, ["init", "-q", "-b", "main", remote]);
  checked(remote, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "main",
    "--allow-empty",
  ]);
  checked(remote, ["checkout", "-qb", "prototype"]);
  checked(remote, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "prototype",
    "--allow-empty",
  ]);
  checked(remote, ["branch", "unrequested"]);
  checked(remote, ["tag", "v1"]);
  checked(root, ["init", "-q", "-b", "local", client]);
  checked(client, ["remote", "add", "origin", remote]);
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/info/refs")) {
      const result = run(remote, ["upload-pack", "--stateless-rpc", "--advertise-refs", "."]);
      if (result.status !== 0) throw new Error(result.stderr.toString());
      const prefix = new TextEncoder().encode("001e# service=git-upload-pack\n0000");
      const body = new Uint8Array(prefix.length + result.stdout.length);
      body.set(prefix);
      body.set(result.stdout, prefix.length);
      return new Response(body, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (url.pathname.endsWith("/git-upload-pack") && init?.method === "POST") {
      const input = new Uint8Array(await new Response(init.body).arrayBuffer());
      const result = run(remote, ["upload-pack", "--stateless-rpc", "."], input);
      if (result.status !== 0) throw new Error(result.stderr.toString());
      return new Response(new Uint8Array(result.stdout), {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    }
    throw new Error(`Unexpected Git HTTP request: ${url.pathname}`);
  };
  return {
    fetch,
    requests,
    oid: (ref: string) => checked(remote, ["rev-parse", ref]),
    remoteGit: (args: readonly string[]) => checked(remote, args),
    git: (args: readonly string[]) => run(client, args),
    refs: () =>
      checked(client, ["for-each-ref", "--format=%(refname) %(objectname)"])
        .split("\n")
        .filter(Boolean)
        .sort(),
    close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}
