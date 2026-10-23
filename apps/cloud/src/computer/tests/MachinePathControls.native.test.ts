import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { COMPUTER_ISOLATE_POLICY } from "../EscalationPolicy.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";
import { bashModule } from "./MachinePathFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe.skipIf(bashModule === undefined)("R29 filesystem discovery controls", () => {
  it.each([
    { command: "jq", marker: undefined, path: undefined, argv: ["jq"], stdout: "" },
    {
      command: "/usr/bin/jq",
      marker: undefined,
      path: "/usr/bin/jq",
      argv: ["/usr/bin/jq"],
      stdout: "",
    },
    { command: "sort", marker: "/bin/sort", path: "/bin/sort", argv: ["sort"], stdout: "" },
    {
      command: "hash sort; hash -t sort; sort",
      marker: "/bin/sort",
      path: "/bin/sort",
      argv: ["sort"],
      stdout: "/bin/sort\n",
    },
  ])("separates discovery from admission for $command with $marker", async (test) => {
    const calls: Array<{ path: string; argv: readonly string[]; decision: string }> = [];
    const table = new ComputerEscalationTable([], COMPUTER_ISOLATE_POLICY, qualifyGnuCommand);
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", test.command],
      env: { HOME: "/workspace", PATH: "/bin:/usr/bin", LC_ALL: "C" },
      async exec(request) {
        const decision = table.decide({
          executable: request.path,
          argv: request.args,
          cwd: request.filesystem.cwd,
          env: request.env,
        });
        calls.push({ path: request.path, argv: request.args, decision: decision.kind });
        return exited(23);
      },
    });
    fixture.filesystem.mkdir("/usr");
    fixture.filesystem.mkdir("/usr/bin");
    for (const path of Object.values(CHILD_PROGRAM_PATHS)) fixture.write(path, "", 0o755);
    if (test.marker !== undefined) fixture.write(test.marker, "", 0o755);
    try {
      const result = await createKernelBashProgram({
        module: bashModule!,
        credentials: bashCredentials,
      }).run(fixture.context);
      expect(result.exitCode).toBe(test.path === undefined ? 127 : 23);
      expect(fixture.stdout()).toBe(test.stdout);
      expect(calls).toEqual(
        test.path === undefined ? [] : [{ path: test.path, argv: test.argv, decision: "machine" }],
      );
    } finally {
      await fixture.close();
    }
  });
});
