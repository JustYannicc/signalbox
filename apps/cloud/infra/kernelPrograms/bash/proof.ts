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
import {
  KernelProgramHost,
  type KernelProgramBinding,
} from "../../../src/kernel/KernelProgramHost.ts";
import { KernelProcessTable } from "../../../src/kernel/KernelProcessTable.ts";
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

interface BashProofArtifact {
  readonly path: string | URL;
  readonly sha256: string;
  readonly bytes: number;
}

async function run(
  script: string,
  passwd?: string,
  fault?: "missing" | "running",
  candidate?: BashProofArtifact,
  verifyForkSignals = false,
) {
  const bytes = await NodeFSP.readFile(
    candidate?.path ?? new URL("./build/bash.async.wasm", import.meta.url),
  );
  NodeAssert.equal(
    NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    candidate?.sha256 ?? KERNEL_BASH_ARTIFACT.sha256,
  );
  NodeAssert.equal(bytes.length, candidate?.bytes ?? KERNEL_BASH_ARTIFACT.bytes);
  const module = new WebAssembly.Module(bytes);
  const fixture = bashSqliteFixture();
  const wakes = new KernelWakeRegistry();
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  let descriptorsAtExec: number | undefined;
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
    version: KERNEL_BASH_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"] as const,
    entrypoint: "/bin/bash",
  };
  if (registry.register(manifest).status !== "ok") throw new Error("Bash registration failed");
  const programs = new Map<string, KernelProgramBinding>([
    ["/bin/bash", { manifest, implementation: program }],
  ]);
  filesystem.mkdir("/bin");
  filesystem.close(
    filesystem.open("/bin/fd-count", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY),
  );
  const counter = { ...manifest, name: "fd-count", version: "1", entrypoint: "/bin/fd-count" };
  if (registry.register(counter).status !== "ok") throw new Error("FD counter registration failed");
  programs.set(counter.entrypoint, {
    manifest: counter,
    implementation: {
      kind: "javascript",
      runInline: ({ filesystem: replacementFs }) => {
        descriptorsAtExec = [...replacementFs.descriptors.entries()].length;
        return 0;
      },
    },
  });
  if (fault !== undefined) {
    filesystem.close(
      filesystem.open("/bin/exec-fault", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY),
    );
    if (fault === "running") {
      const replacement = {
        ...manifest,
        name: "exec-fault",
        version: "1",
        entrypoint: "/bin/exec-fault",
      };
      if (registry.register(replacement).status !== "ok")
        throw new Error("Fault fixture registration failed");
      programs.set("/bin/exec-fault", {
        manifest: replacement,
        implementation: {
          kind: "javascript",
          runInline: ({ filesystem: replacementFs }) => {
            replacementFs.write(1, new TextEncoder().encode("replacement-started\n"), null);
            throw Object.assign(new Error("Injected error after replacement started"), {
              code: "EIO",
            });
          },
        },
      });
    }
  }
  const forkSignals: Array<{
    mask: ReturnType<KernelProcessTable["signalMask"]>;
    delivered: ReturnType<KernelProcessTable["signal"]>;
    unblocked: ReturnType<KernelProcessTable["signalMask"]>;
  }> = [];
  class ForkSignalProofTable extends KernelProcessTable {
    override spawn(...args: Parameters<KernelProcessTable["spawn"]>) {
      const spawned = super.spawn(...args);
      if (args[0] !== undefined && spawned.status === "ok") {
        const handle = spawned.value.handle;
        forkSignals.push({
          mask: this.signalMask(handle, 3),
          delivered: this.signal(handle, 12),
          unblocked: this.signalMask(handle, 1, { low: 1 << 11, high: 0 }),
        });
      }
      return spawned;
    }
  }
  const processes = verifyForkSignals ? new ForkSignalProofTable({ wakes }) : undefined;
  if (processes) {
    NodeAssert.equal(processes.signalMask(undefined, 2, { low: 1 << 11, high: 0 }).status, "ok");
  }
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs,
    ...(processes === undefined ? {} : { processes }),
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
    const exit = exited.status === "ok" ? exited.value : undefined;
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
      failure: exited.status === "ok" ? undefined : exited,
      stdout: output.map((chunk) => new TextDecoder().decode(chunk)).join(""),
      stderr: errors.map((chunk) => new TextDecoder().decode(chunk)).join(""),
      descriptorsAtExec,
      forkSignals,
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

export async function proveKernelBashProgram(candidate?: BashProofArtifact) {
  const runProof = (script: string, passwd?: string, fault?: "missing" | "running") =>
    run(script, passwd, fault, candidate);
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
      name: "redirection can claim libc's cached root preopen descriptor",
      script: "exec 3>/workspace/log; printf ok >/workspace/result; printf done >&3",
      exitCode: 0,
      stdout: "",
      stderr: "",
      file: "ok",
    },
    {
      name: "forked Bash inherits a relocated root preopen",
      script: "exec 3>/workspace/log; (printf child >/workspace/result); printf '%s\\n' parent >&3",
      exitCode: 0,
      stdout: "",
      stderr: "",
      file: "child",
    },
    {
      name: "closing a claimed preopen number preserves libc's namespace",
      script: "exec 3>/workspace/log; exec 3>&-; printf after-close >/workspace/result",
      exitCode: 0,
      stdout: "",
      stderr: "",
      file: "after-close",
    },
    {
      name: "ordinary fd probes distinguish a closed claimed preopen from its retained root",
      script:
        "exec 3>/workspace/log; exec 3>&-; : 3>/workspace/other; printf reopened >/workspace/result",
      exitCode: 0,
      stdout: "",
      stderr: "",
      file: "reopened",
    },
    {
      name: "closing the original preopen preserves later pathname access",
      script: "exec 3>&-; printf after-close >/workspace/result",
      exitCode: 0,
      stdout: "",
      stderr: "",
      file: "after-close",
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
    {
      name: "kill reports ESRCH for a nonexistent process",
      script: "kill 2147483647; printf '%s\\n' \"$?\"",
      exitCode: 0,
      stdout: "1\n",
      stderr: "/bin/bash: line 1: kill: (2147483647) - No such process\n",
    },
  ];
  const checks: string[] = [];
  const forkSignals = await run(
    "(printf child); printf parent",
    undefined,
    undefined,
    candidate,
    true,
  );
  NodeAssert.deepStrictEqual(forkSignals.exit, { exitCode: 0, signal: 0, coreDumped: false });
  NodeAssert.equal(forkSignals.stdout, "childparent");
  NodeAssert.equal(forkSignals.stderr, "");
  NodeAssert.ok(forkSignals.forkSignals.length > 0, "Bash must exercise a real fork");
  for (const observed of forkSignals.forkSignals) {
    NodeAssert.deepStrictEqual(observed.mask, { status: "ok", value: { low: 1 << 11, high: 0 } });
    NodeAssert.equal(observed.delivered.status, "error", "blocked unsupported signal must fail");
    if (observed.delivered.status === "error")
      NodeAssert.equal(observed.delivered.error.code, "UNSUPPORTED");
    NodeAssert.deepStrictEqual(observed.unblocked, {
      status: "ok",
      value: { low: 1 << 11, high: 0 },
    });
  }
  checks.push("forked Bash rejects unsupported signals even when inherited mask blocks them");
  for (const proof of cases) {
    const result = await runProof(proof.script, proof.passwd);
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
  const baseline = await runProof("exec /bin/fd-count");
  const repeated = await runProof(
    "for ((i=0; i<64; i++)); do : 3>/workspace/log; done; exec /bin/fd-count",
  );
  NodeAssert.equal(baseline.exit?.exitCode, 0);
  NodeAssert.equal(repeated.exit?.exitCode, 0);
  NodeAssert.equal(repeated.stderr, "");
  NodeAssert.ok(baseline.descriptorsAtExec !== undefined);
  NodeAssert.ok(repeated.descriptorsAtExec !== undefined);
  NodeAssert.ok(
    repeated.descriptorsAtExec <= baseline.descriptorsAtExec + 1,
    `temporary redirections leaked descriptors: ${baseline.descriptorsAtExec} -> ${repeated.descriptorsAtExec}`,
  );
  checks.push("temporary redirections reuse one retained root capability across 64 iterations");
  const rejected = await runProof(
    "exec /bin/exec-fault; printf 'resumed\\n'",
    undefined,
    "missing",
  );
  NodeAssert.equal(
    rejected.exit?.exitCode,
    127,
    "a rejected exec keeps GNU Bash's failure semantics",
  );
  NodeAssert.equal(rejected.stdout, "", "exec failure must not run the following command");
  checks.push("pre-admission exec rejection returns to GNU Bash");
  const replaced = await runProof(
    "exec /bin/exec-fault; printf 'old-shell-resumed\\n'",
    undefined,
    "running",
  );
  NodeAssert.equal(
    replaced.exit,
    undefined,
    "an admitted replacement failure must terminate the owning shell process",
  );
  NodeAssert.equal(replaced.failure?.status, "error");
  NodeAssert.equal(
    replaced.stdout,
    "replacement-started\n",
    "an admitted replacement must never resume its old Bash continuation",
  );
  checks.push("an admitted replacement error never resumes the old Bash continuation");
  return { ok: true, artifact: candidate ?? KERNEL_BASH_ARTIFACT, checks };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await proveKernelBashProgram(), null, 2)}\n`);
}
