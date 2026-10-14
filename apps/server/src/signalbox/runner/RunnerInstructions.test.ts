// @effect-diagnostics nodeBuiltinImport:off - the assertions read the machine's files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { scopedTest } from "./driveTesting.ts";
import { makeRunnerInstructions } from "./RunnerInstructions.ts";

const levels = [
  { label: "Top level", text: "Be brief." },
  { label: "Work", text: "Write in English." },
  { label: "Work / Clients", text: "Bill hourly." },
];

describe("RunnerInstructions", () => {
  it.effect("writes the folders' AGENTS.md above the checkout, top level first", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const cwd = NodePath.join(root, "workspace", "drive");
        NodeFS.mkdirSync(cwd, { recursive: true });
        const instructions = yield* makeRunnerInstructions({ cwd });

        const bundle = yield* instructions.compose([], levels);
        expect(NodeFS.readFileSync(instructions.bundleFile, "utf8")).toBe(bundle);
        const at = (text: string) => bundle.indexOf(text);
        expect(at("## Top level")).toBeGreaterThan(-1);
        expect(at("## Top level")).toBeLessThan(at("## Work\n"));
        expect(at("## Work\n")).toBeLessThan(at("## Work / Clients"));
        expect(at("Be brief.")).toBeLessThan(at("Bill hourly."));
        // Nothing from shortcuts, so no section for them.
        expect(bundle).not.toContain("shortcuts");

        // Moving to a folder with none leaves no bundle behind.
        expect(yield* instructions.compose([], [])).toBe("");
        expect(NodeFS.existsSync(instructions.bundleFile)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
