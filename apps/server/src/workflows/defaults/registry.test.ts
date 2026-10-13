import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "../compiler/compileWorkflow.ts";
import { BUILT_IN_AUTOMATIONS, builtInOfRow } from "./registry.ts";

describe("built-in automations", () => {
  it.each(BUILT_IN_AUTOMATIONS.map((builtIn) => [builtIn.slug, builtIn] as const))(
    "%s compiles under its own name",
    (_slug, builtIn) => {
      const compiled = compileWorkflow(builtIn.source);
      expect(compiled.ok ? compiled.workflow.meta.name : compiled.diagnostics).toBe(builtIn.name);
      expect(builtInOfRow({ builtin_slug: builtIn.slug })).toBe(builtIn);
      expect(builtInOfRow({ builtin_slug: null })).toBeUndefined();
    },
  );
});
