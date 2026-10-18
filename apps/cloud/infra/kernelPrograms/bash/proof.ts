// @effect-diagnostics nodeBuiltinImport:off - pinned binary and in-memory database only.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";
import {
  createKernelBashProgram,
  KERNEL_BASH_ARTIFACT,
} from "../../../src/kernel/KernelBashProgram.ts";
import { ABI_VERSION, KernelProgramRegistry, callKernel } from "../../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../../src/kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { bashSqliteFixture } from "./bashFixture.ts";

const credentials = {
  uid: 1000,
  gid: 1000,
  euid: 1000,
  egid: 1000,
  umask: 0o22,
  hostname: "bash-test",
};

async function run(script: string, passwd?: string) {
  const bytes = await NodeFSP.readFile(new URL("./build/bash.async.wasm", import.meta.url));
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    KERNEL_BASH_ARTIFACT.sha256,
  );
  const module = new WebAssembly.Module(bytes);
  const fixture = bashSqliteFixture();
  const wakes = new KernelWakeRegistry();
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  const filesystem = new KernelFileSystem({
    mounts: [
      {
        path: "/",
        storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
      },
    ],
    stdio: [
      { readInto: () => 0 },
      {
        write: (chunk) => {
          output.push(chunk.slice());
          return chunk.length;
        },
      },
      {
        write: (chunk) => {
          errors.push(chunk.slice());
          return chunk.length;
        },
      },
    ],
  });
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  if (passwd !== undefined) {
    filesystem.mkdir("/etc");
    const fd = filesystem.open("/etc/passwd", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    try {
      filesystem.write(fd, new TextEncoder().encode(passwd), null);
    } finally {
      filesystem.close(fd);
    }
  }
  const program = createKernelBashProgram({ module, credentials });
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "gnu-bash",
    version: KERNEL_BASH_ARTIFACT.revision,
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "/bin/bash",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Bash registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/bash", { manifest, implementation: program }]]),
  });
  const prepared = host.prepare({ filesystem }, { cwd: "/workspace" });
  const resolved = host.resolve("/bin/bash");
  if (resolved.status !== "ok") throw new Error("Bash resolution failed");
  const spawned = callKernel(host.backend(prepared), "process.spawn", {
    program: resolved.value,
    args: ["/bin/bash", "-c", script],
    env: {},
  });
  if (spawned.status !== "ok") throw new Error("Bash admission failed");
  try {
    const exited = await host.exitStatus(spawned.value);
    if (exited.status !== "ok") throw new Error(`Bash failed: ${JSON.stringify(exited)}`);
    const exit = exited.value;
    const read = (path: string) => {
      const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
      try {
        const target = new Uint8Array(4096);
        return new TextDecoder().decode(target.subarray(0, filesystem.read(fd, target, null)));
      } finally {
        filesystem.close(fd);
      }
    };
    return {
      exit,
      stdout: output.map((chunk) => new TextDecoder().decode(chunk)).join(""),
      stderr: errors.map((chunk) => new TextDecoder().decode(chunk)).join(""),
      file: script.includes("result") ? read("/workspace/result") : undefined,
    };
  } finally {
    await prepared.release();
    await host.processes.dispose();
    filesystem.dispose();
    fixture.close();
    wakes.dispose();
  }
}

export async function proveKernelBashProgram() {
  const cases = [
    {
      name: "exact non-login Codex exec_command",
      script: "printf '%s\\n' codex-exec-ok",
      exitCode: 0,
      stdout: "codex-exec-ok\n",
      stderr: "",
    },
    {
      name: "shared filesystem redirection and exit status",
      script: "printf '%s\\n' redirected > /workspace/result; exit 7",
      exitCode: 7,
      stdout: "",
      stderr: "",
      file: "redirected\n",
    },
    {
      name: "cloned subshell continuation and wait",
      script: "(printf '%s\\n' child); printf '%s\\n' parent",
      exitCode: 0,
      stdout: "child\nparent\n",
      stderr: "",
    },
    {
      name: "two GNU Bash child continuations and a kernel pipe",
      script: "printf '%s\\n' piped | { IFS= read -r value; printf '<%s>\\n' \"$value\"; }",
      exitCode: 0,
      stdout: "<piped>\n",
      stderr: "",
    },
    {
      name: "command substitution and failed command status",
      script: "value=$(printf '%s' captured); /bin/absent; printf '%s:%s\\n' \"$value\" \"$?\"",
      exitCode: 0,
      stdout: "captured:127\n",
    },
    {
      name: "explicit credentials and inherited shell umask state",
      script: 'umask 077; (printf \'%s:%s:\' "$UID" "$EUID"; umask); umask',
      exitCode: 0,
      stdout: "1000:1000:0077\n0077\n",
      stderr: "",
    },
    {
      name: "setjmp continuation replay for errexit",
      script: "set -e; false; printf 'must-not-run\\n'",
      exitCode: 1,
      stdout: "",
      stderr: "",
    },
    {
      name: "account lookup skips invalid numeric identities",
      script: "printf '%s\\n' ~example",
      passwd:
        "example:x::1000:Invalid:/wrong:/bin/bash\nexample:x:1000:1000:Example:/home/example:/bin/bash\n",
      exitCode: 0,
      stdout: "/home/example\n",
      stderr: "",
    },
  ];
  const checks: string[] = [];
  for (const proof of cases) {
    const result = await run(proof.script, proof.passwd);
    NodeAssert.deepStrictEqual(
      result.exit,
      { exitCode: proof.exitCode, signal: 0, coreDumped: false },
      proof.name,
    );
    NodeAssert.equal(result.stdout, proof.stdout, proof.name);
    if (proof.stderr !== undefined) NodeAssert.equal(result.stderr, proof.stderr, proof.name);
    if (proof.file !== undefined) NodeAssert.equal(result.file, proof.file, proof.name);
    checks.push(proof.name);
  }
  return { ok: true, artifact: KERNEL_BASH_ARTIFACT, checks };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await proveKernelBashProgram(), null, 2)}\n`);
}
