import { expect, it, vi } from "vite-plus/test";
import { qualifyUgrepCommand } from "../UgrepCommand.ts";
import { commandGatewayFixture } from "./CommandGatewayAdmissionFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = (argv: readonly string[]) => ({
  executable: "/usr/local/bin/claude",
  argv,
  cwd: "/workspace",
  env: {},
});

it.each([
  ["claude", "--version"],
  ["ugrep", "--filter=external", "pattern"],
  ["ugrep", "--pager", "pattern"],
  ["ugrep", "--config", "pattern"],
  ["ugrep", "-Q", "pattern"],
  ["ugrep", "-z", "pattern"],
  ["ugrep", "-J2", "pattern"],
  ["ugrep", "-E", "pattern", "file.txt"],
  ["ugrep", "-A101", "pattern"],
  ["ugrep", "-E"],
])("forwards unsupported multicall or ugrep mode %j unchanged", async (...argv) => {
  const input = command(argv);
  const fixture = commandGatewayFixture({
    run: async () => {
      throw new Error("An unsupported ugrep command reached the isolate");
    },
  });
  try {
    const child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    expect(fixture.machineSpawn.mock.calls[0]![0]).toEqual(input);
  } finally {
    await fixture.close();
  }
});

it("lets the genuine matcher diagnose invalid regex syntax", () => {
  expect(qualifyUgrepCommand(command(["ugrep", "-E", "["]))).toEqual({ kind: "qualified-isolate" });
});

it("does not classify an unrelated executable", () => {
  expect(
    qualifyUgrepCommand({ ...command(["ugrep", "-E", "pattern"]), executable: "/bin/other" }),
  ).toBeUndefined();
});
