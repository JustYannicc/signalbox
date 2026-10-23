// @effect-diagnostics nodeBuiltinImport:off - compares local WASM with byte receipts captured from Linux GNU programs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import corpus from "../../../infra/kernelPrograms/gnu/utf8-corpus.json" with { type: "json" };
import reference from "../../../infra/kernelPrograms/gnu/utf8-reference.json" with { type: "json" };
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function loadProgram() {
  const program = "sed";
  const path =
    NodeProcess.env[`SIGNALBOX_GNU_${program.toUpperCase()}_ARTIFACT`] ??
    new URL(`../../../../../.t3/1071/programs/${program}.wasm`, import.meta.url);
  if (!NodeFS.existsSync(path)) {
    if (NodeProcess.env.SIGNALBOX_REQUIRE_GNU_ARTIFACTS === "1")
      throw new Error(`GNU UTF-8 differential requires ${String(path)}`);
    return undefined;
  }
  const bytes = NodeFS.readFileSync(path);
  const pin = KERNEL_GNU_SED_ARTIFACT;
  if (
    bytes.length !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    throw new Error(`GNU UTF-8 differential ${program} artifact does not match its pin`);
  return new WebAssembly.Module(bytes);
}
const module = loadProgram();
const receipts: unknown[] = [];
afterAll(() => {
  const path = NodeProcess.env.SIGNALBOX_UTF8_RESULT_PATH;
  if (path)
    NodeFS.writeFileSync(
      path,
      JSON.stringify({ reference: reference.versions, receipts }, null, 2) + "\n",
    );
});

const forced = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  CODEX_CI: "1",
};

describe.skipIf(!module)("GNU WASI C.UTF-8 versus Linux GNU", () => {
  it("matches stdout, stderr, exit status and file bytes for the complete UTF-8 corpus", async () => {
    const mismatches: string[] = [];
    let qualified = 0;
    expect(reference.platform).toBe("linux");
    expect(reference.results).toHaveLength(corpus.length * 2);
    expect(new Set(reference.results.map(({ name, locale }) => `${locale} ${name}`)).size).toBe(
      reference.results.length,
    );
    for (const expected of reference.results) {
      const entry = corpus.find(({ name }) => name === expected.name);
      if (!entry) throw new Error(`Missing UTF-8 corpus entry ${expected.name}`);
      if (entry.program !== "sed") throw new Error("Unknown GNU program");
      const env = {
        ...forced,
        LANG: expected.locale,
        LC_CTYPE: expected.locale,
        LC_ALL: expected.locale,
      };
      const args = [entry.program, ...entry.args];
      const qualification = qualifyGnuCommand({
        executable: entry.program,
        argv: args,
        cwd: "/workspace",
        env,
      });
      if (qualification.kind === "qualified-isolate") qualified++;
      const fixture = childBusyboxFixture({ args, env });
      const fd = fixture.filesystem.open(
        "input",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      fixture.filesystem.write(fd, Buffer.from(entry.inputHex, "hex"), null);
      fixture.filesystem.close(fd);
      const owner = createKernelBusyboxHost({ context: fixture.context });
      try {
        const result = await createChildBusybox({
          module: module!,
          port: owner.port,
          args,
          env,
        }).run();
        const input = fixture.filesystem.open("input", KernelOpenFlags.O_RDONLY);
        let after;
        try {
          after = new Uint8Array(Number(fixture.filesystem.fstat(input).size));
          fixture.filesystem.read(input, after, null);
        } finally {
          fixture.filesystem.close(input);
        }
        const actual = {
          name: entry.name,
          locale: expected.locale,
          stdoutHex: Buffer.from(fixture.stdout()).toString("hex"),
          stderrHex: Buffer.from(fixture.stderr()).toString("hex"),
          exitCode: result.exitCode,
          files: { input: Buffer.from(after).toString("hex") },
        };
        const equal = JSON.stringify(actual) === JSON.stringify(expected);
        receipts.push({ qualification, equal, actual, expected });
        if (!equal) mismatches.push(`${expected.locale} ${entry.name}`);
      } finally {
        await owner.close();
        await fixture.close();
      }
    }
    expect(mismatches).toEqual([]);
    expect(qualified).toBeGreaterThan(0);
  });
});
