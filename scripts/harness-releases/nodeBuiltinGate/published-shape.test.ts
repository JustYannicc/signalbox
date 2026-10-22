import { describe, expect, it } from "vite-plus/test";
import { assertPackagedBuiltinCoverage, scanBuiltinSource } from "../nodeBuiltinGate.ts";

const publishedFacade =
  'var __defProp=Object.defineProperty;var __getOwnPropNames=Object.getOwnPropertyNames;\nvar __commonJS=(cb12,mod2)=>function __require2(){try{return mod2||(0,cb12[__getOwnPropNames(cb12)[0]])((mod2={exports:{}}).exports,mod2),mod2.exports}catch(e117){throw mod2=0,e117}};\nvar __toESM=(mod2,isNodeMode,target)=>(target=mod2!=null?__create(__getProtoOf(mod2)):{},__copyProps(isNodeMode||!mod2||!mod2.__esModule?__defProp(target,"default",{value:mod2,enumerable:true}):target,mod2));\nvar require_os=__commonJS({"signalbox-layer:os"(exports2,module2){var bridge=globalThis[Symbol.for("signalbox.nodeBridge.v1")];if(!bridge){const error=new Error("Install the Node bridge before importing the release");error.code="NODE_BRIDGE_NOT_INSTALLED";throw error}module2.exports=bridge.require("os")}});\nvar import_os22; import_os22=__toESM(require_os()); import_os22.default.release();';

describe("published release helper shapes", () => {
  it("finds os.release through a guarded facade and a cache-resetting CommonJS helper", () => {
    const scan = scanBuiltinSource({ name: "published-release.js", source: publishedFacade });
    expect(scan.requiredFunctions).toContainEqual(
      expect.objectContaining({ specifier: "os", memberPath: ["release"] }),
    );
  });

  it.each([
    ["wrong cache reset", "throw mod2=0,e117", "throw mod2=1,e117"],
    ["wrong guard condition", "if(!bridge)", "if(bridge)"],
    ["wrong guard error", 'error.code="NODE_BRIDGE_NOT_INSTALLED"', 'error.code="OTHER_ERROR"'],
    [
      "unexpected facade effect",
      'module2.exports=bridge.require("os")',
      'bridge={};module2.exports=bridge.require("os")',
    ],
    [
      "reassigned namespace",
      " import_os22.default.release();",
      " import_os22={}; import_os22.default.release();",
    ],
  ])("keeps %s uncertain", async (_name, before, after) => {
    expect(publishedFacade).toContain(before);
    const input = {
      name: "published-near-match.js",
      source: publishedFacade.replace(before, after),
    };
    const scan = scanBuiltinSource(input);
    expect(scan.requiredFunctions).toEqual([]);
    expect(scan.functionAmbiguities.map(({ specifier }) => specifier)).toContain("os.release");
    const result = assertPackagedBuiltinCoverage([input], {
      modules: ["os"],
      functions: [
        {
          specifier: "os",
          memberPath: ["release"],
          status: "supported",
          evidence: "test capability",
        },
      ],
      profile: {
        systemIdentity: {},
        processIdentity: {},
        filesystem: { posixPolicy: false, setUmask: false },
        cpu: { execution: false, processAccounting: false },
      },
    });
    if (scan.functionAmbiguities.some(({ kind }) => kind === "dynamic-builtin-loader-call")) {
      await expect(result).rejects.toThrow("unresolved-function-calls=");
    } else {
      await expect(result).resolves.toMatchObject({
        status: "pass",
        functionAmbiguities: expect.arrayContaining([
          expect.objectContaining({ severity: "warning" }),
        ]),
      });
    }
  });

  it("does not attribute a shadowed namespace to the outer builtin", () => {
    const input = publishedFacade.replace(
      " import_os22.default.release();",
      " function local(import_os22) { import_os22.default.release(); }",
    );
    const scan = scanBuiltinSource({ name: "shadowed.js", source: input });
    expect(scan.requiredFunctions).toEqual([]);
    expect(scan.functionAmbiguities).toEqual([]);
  });
});
