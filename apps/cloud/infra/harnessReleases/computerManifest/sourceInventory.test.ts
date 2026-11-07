import { expect, it } from "vite-plus/test";
import { CHILD_PROGRAM_CODE_NAMES } from "../../../src/computer/ChildProgramCodes.ts";
import type { PreparedChildPrograms, ChildProgramSourceCode } from "../../childPrograms/prepare.ts";
import { computerSha256 } from "./identity.ts";
import { verifyAndNormalizePreparedSourceInventory } from "./sourceInventory.ts";

it("validates CodeMode with every catalog source and rejects omitted or changed cell modules", () => {
  const command: ChildProgramSourceCode = {
    entrypoint: "fixture-command",
    mainModule: "main.js",
    modules: { "main.js": { js: "export default {};" } },
  };
  const cell: ChildProgramSourceCode = {
    entrypoint: "code-mode-cell",
    mainModule: "main.js",
    modules: { "main.js": { js: "export default class Cell {}" } },
  };
  const programs = Object.fromEntries(
    CHILD_PROGRAM_CODE_NAMES.map((name) => [
      name,
      name === "coreutils" ? { mkdir: command } : name === "codeMode" ? cell : command,
    ]),
  );
  const records = [command, cell].map((code) => {
    const bytes = new TextEncoder().encode((code.modules["main.js"] as { js: string }).js);
    return {
      path: `generated/${code.entrypoint}/main.js`,
      bytes: bytes.byteLength,
      sha256: computerSha256(bytes),
    };
  });
  const inventory = Object.fromEntries(
    CHILD_PROGRAM_CODE_NAMES.map((name) => {
      const code = name === "codeMode" ? cell : command;
      return [
        name,
        { entrypoint: code.entrypoint!, mainModule: code.mainModule, modules: ["main.js"] },
      ];
    }),
  );
  const prepared = {
    programs,
    sourceInventory: {
      format: "signalbox-child-programs-v1",
      sources: records,
      artifacts: [],
      programs: inventory,
    },
  } as unknown as PreparedChildPrograms;
  const source = { commit: "c".repeat(40), sha256: computerSha256("[]"), files: [] };
  const verified = verifyAndNormalizePreparedSourceInventory(prepared, source);
  expect(Object.keys(verified.programs).sort()).toEqual([...CHILD_PROGRAM_CODE_NAMES].sort());
  expect(verified.programs.codeMode).toMatchObject({ entrypoint: "code-mode-cell" });
  const { codeMode: _omitted, ...missing } = inventory;
  expect(() =>
    verifyAndNormalizePreparedSourceInventory(
      { ...prepared, sourceInventory: { ...prepared.sourceInventory, programs: missing } },
      source,
    ),
  ).toThrow("TRUSTED_COMPUTER_PROGRAM_INVENTORY_DRIFT");
  expect(() =>
    verifyAndNormalizePreparedSourceInventory(
      {
        ...prepared,
        sourceInventory: { ...prepared.sourceInventory, sources: records.slice(0, 1) },
      },
      source,
    ),
  ).toThrow("TRUSTED_COMPUTER_GENERATED_INVENTORY_DRIFT");
});
