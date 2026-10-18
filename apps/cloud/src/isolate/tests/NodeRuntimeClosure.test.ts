// @effect-diagnostics nodeBuiltinImport:off - verifies host-provided modules against isolated Node adapters.
import { describe, expect, it } from "@effect/vitest";
import * as NodeConstants from "node:constants";
import * as NodeInspector from "node:inspector";
import * as NodeModule from "node:module";
import * as NodeQuerystring from "node:querystring";

import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
import { canonicalNodeBuiltin, NODE_BUILTIN_ROUTES } from "../NodeBuiltinMap.ts";
import { createNodeConstants } from "../NodeConstants.ts";
import { createNodeEnvironmentResolver } from "../NodeEnvironment.ts";
import { createNodeBridge } from "../NodeBridge.ts";
import { createNodeModule } from "../NodeModule.ts";
import { createNodeFs, KernelOpenFlags } from "../NodeFs.ts";
import * as BunJsc from "../NodeBunJsc.ts";

function filesystemFixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1_800_000_000_000_000_000n);
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }], cwd: "/" });
  return {
    filesystem,
    close() {
      try {
        filesystem.dispose();
      } finally {
        database.close();
      }
    },
  };
}

describe("Node runtime closure adapters", () => {
  it("routes builtin aliases to the expected runtime owners", () => {
    expect(canonicalNodeBuiltin("constants")).toBe("constants");
    expect(canonicalNodeBuiltin("node:constants")).toBe("constants");
    expect(canonicalNodeBuiltin("querystring")).toBe("querystring");
    expect(canonicalNodeBuiltin("node:querystring")).toBe("querystring");
    expect(canonicalNodeBuiltin("inspector")).toBe("inspector");
    expect(canonicalNodeBuiltin("node:inspector")).toBe("inspector");
    expect(NODE_BUILTIN_ROUTES.constants).toBe("facet-context");
    expect(NODE_BUILTIN_ROUTES.querystring).toBe("workerd");
    expect(NODE_BUILTIN_ROUTES.inspector).toBe("workerd-partial");
  });

  it("keeps constants filesystem flags aligned with the KernelFileSystem adapter", () => {
    const fixture = filesystemFixture();
    try {
      const { fs } = createNodeFs(fixture.filesystem);
      const divergentNativeConstants = {
        ...NodeConstants,
        O_RDONLY: 91_001,
        O_APPEND: 91_002,
      };
      const constants = createNodeConstants(divergentNativeConstants, fs);

      expect(constants.O_RDONLY).toBe(fs.constants.O_RDONLY);
      expect(constants.O_APPEND).toBe(fs.constants.O_APPEND);
      expect(constants.O_APPEND).toBe(KernelOpenFlags.O_APPEND);
      expect(constants.EACCES).toBe(NodeConstants.EACCES);
      expect(constants.default).toBe(constants);
    } finally {
      fixture.close();
    }
  });

  it("keeps querystring behavior and the partial native inspector on their actual modules", () => {
    const fixture = filesystemFixture();
    try {
      const fs = createNodeFs(fixture.filesystem).fs;
      const constants = createNodeConstants(NodeConstants, fs);
      const bridge = createNodeBridge({
        constants,
        querystring: NodeQuerystring,
        inspector: NodeInspector,
      });

      const querystring = bridge.require("node:querystring");
      const inspector = bridge.require("inspector");
      expect(querystring).toBe(NodeQuerystring);
      expect(NodeQuerystring.parse(NodeQuerystring.stringify({ answer: "42" }))).toMatchObject({
        answer: "42",
      });
      expect(inspector).toBe(NodeInspector);
      expect(NodeInspector.url()).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("imports JSC operations safely and rejects calls explicitly on V8", () => {
    for (const member of ["edenGC", "heapStats"] as const) {
      expect(typeof BunJsc[member]).toBe("function");
      expect(() => BunJsc[member]()).toThrow(
        expect.objectContaining({ code: "ERR_BUN_JSC_UNAVAILABLE", runtime: "v8", member }),
      );
    }
  });

  it("resolves actual prepared exports by runtime identity", () => {
    const nativeRequire = NodeModule.createRequire(import.meta.url);
    const undici = nativeRequire("undici");
    const yaml = nativeRequire("yaml");
    const packages = { undici, yaml, "bun:jsc": BunJsc };
    const resolver = createNodeEnvironmentResolver({ packages, addons: [] });
    const module = createNodeModule(createNodeBridge({}), resolver);
    const require = module.createRequire("/guest/release.js");

    expect(require("undici")).toBe(undici);
    expect(require("yaml")).toBe(yaml);
    expect(require("bun:jsc")).toBe(BunJsc);
    expect(() => require("unprepared-package")).toThrow(
      expect.objectContaining({ code: "ERR_NODE_PREPARED_MODULE_UNAVAILABLE" }),
    );
  });
});
