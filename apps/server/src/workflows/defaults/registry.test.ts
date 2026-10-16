import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { PRECOMPILED_BUILT_INS } from "@signalbox/automations/defaults/precompiled";
import { BUILT_IN_AUTOMATIONS, builtInOfRow } from "@signalbox/automations/defaults/registry";

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

  it.each(BUILT_IN_AUTOMATIONS.map((builtIn) => [builtIn.slug, builtIn] as const))(
    "%s ships precompiled as the compiler compiles it now",
    (slug, builtIn) => {
      const compiled = compileWorkflow(builtIn.source);
      // Stale? Run `node apps/server/scripts/precompile-built-in-automations.ts`.
      expect(PRECOMPILED_BUILT_INS[slug]).toEqual(compiled.ok ? compiled.workflow : null);
    },
  );
});
