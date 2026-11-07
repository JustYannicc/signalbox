import { describe, expect, it } from "vite-plus/test";
import { qualifyTrCommand } from "../TrCommand.ts";
import { trMachineVectors } from "./TrVectors.fixture.ts";
const command = (argv: readonly string[], env = { LC_ALL: "C" }) => ({
  executable: "/bin/tr",
  argv: ["tr", ...argv],
  cwd: "/work",
  env,
});

describe("BusyBox tr qualification", () => {
  it.each(trMachineVectors)("forwards the GNU-incompatible vector $args", ({ args }) => {
    expect(qualifyTrCommand(command(args))).toMatchObject({ kind: "machine" });
  });
  it.each(["\\133", "\\072", "\\075", "\\052", "\\135"])("forwards escaped set syntax %s", (set) =>
    expect(qualifyTrCommand(command(["-d", set]))).toMatchObject({ kind: "machine" }),
  );
  it("forwards a late operand delimiter after an initial option delimiter", () => {
    expect(qualifyTrCommand(command(["-d", "--", "a", "--"]))).toMatchObject({ kind: "machine" });
  });
  it("forwards an overridden multicall entry", () =>
    expect(qualifyTrCommand({ ...command(["-d", "x"]), argv: ["other", "-d", "x"] })).toMatchObject(
      { kind: "machine" },
    ));
  it.each([
    ["-d", "\\n"],
    ["\\n", " "],
    ["a-z", "A-Z"],
    ["-s", "[:space:]"],
    ["-cd", "0-9\\n"],
    ["-ds", "0-9", "[:space:]"],
    ["-s", "ab", "z"],
    ["[:upper:]", "[:lower:]"],
    ["[:lower:]", "[:upper:]"],
    ["-d", "[:punct:]"],
    ["-d", "[:cntrl:]"],
    ["-d", "[:xdigit:]"],
    ["-d", "\\000-\\377"],
    ["-c", "[:space:]", "x"],
    ["--", "-", "_"],
    ["[a-z]", "[A-Z]"],
    ["", "x"],
  ])("qualifies %j", (...args) =>
    expect(qualifyTrCommand(command(args))).toEqual({ kind: "qualified-isolate" }),
  );
  it.each([
    ["-t", "ab", "x"],
    ["--delete", "x"],
    ["-C", "x", "y"],
    ["-d", "[:graph:]"],
    ["-d", "[:print:]"],
    ["-d", "[=a=]"],
    ["ab", "[x*2]"],
    ["ab", "[x*]"],
    ["-d", "\\x41"],
    ["-d", "\\q"],
    ["-d", "\\400"],
    ["-d", "z-a"],
    ["-d", "雪"],
    ["-c", "[:lower:]", "[:upper:]"],
    ["-c", "[:space:]", "ab"],
    ["a", "[:digit:]"],
    ["a", ""],
    ["-d", "a", "b"],
    ["-ds", "a"],
    ["a", "b", "-s"],
  ])("forwards unqualified %j", (...args) =>
    expect(qualifyTrCommand(command(args))).toMatchObject({
      kind: "machine",
      reason: expect.any(String),
      detail: expect.any(String),
    }),
  );
  it("uses LC_ALL ahead of LANG", () =>
    expect(
      qualifyTrCommand({
        ...command(["-d", "[:alpha:]"]),
        env: { LC_ALL: "C", LANG: "en_US.UTF-8" },
      }),
    ).toEqual({ kind: "qualified-isolate" }));
  it("forwards locale-sensitive classes", () =>
    expect(qualifyTrCommand(command(["-d", "[:alpha:]"], { LC_ALL: "en_US.UTF-8" }))).toMatchObject(
      { kind: "machine" },
    ));
  it.each([[], ["hello", "world"], ["-"]])("qualifies literal yes %j", (...args) =>
    expect(
      qualifyTrCommand({ ...command(args), executable: "/bin/yes", argv: ["yes", ...args] }),
    ).toEqual({ kind: "qualified-isolate" }),
  );
  it.each(["--help", "--version", "--"])("forwards yes %s", (arg) =>
    expect(
      qualifyTrCommand({ ...command([]), executable: "/bin/yes", argv: ["yes", arg] }),
    ).toMatchObject({ kind: "machine" }),
  );
});
