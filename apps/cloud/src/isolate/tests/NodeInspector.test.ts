import { describe, expect, it } from "@effect/vitest";

import { createNodeInspectorModule } from "../NodeInspector.ts";
import { getNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";

describe("Node inspector personality wrapper", () => {
  it("preserves native exports and owns url behavior without stamping the native callable", () => {
    const receivers: unknown[] = [];
    const nativeUrl = function (this: unknown) {
      receivers.push(this);
      return undefined;
    };
    const open = () => "opened";
    const nativeInspector = { open, url: nativeUrl };
    const inspector = createNodeInspectorModule(nativeInspector);
    const url: unknown = Reflect.get(inspector, "url");

    expect(Reflect.get(inspector, "open")).toBe(open);
    expect(typeof url).toBe("function");
    if (typeof url !== "function") throw new TypeError("inspector.url is unavailable");
    expect(Reflect.apply(url, inspector, [])).toBeUndefined();
    expect(receivers).toEqual([nativeInspector]);
    expect(getNodeBuiltinCapability(url)).toMatchObject({ status: "supported" });
    expect(getNodeBuiltinCapability(nativeUrl)).toBeUndefined();
  });

  it("returns undefined when the native inspector has no URL operation", () => {
    const inspector = createNodeInspectorModule({});
    const url: unknown = Reflect.get(inspector, "url");

    expect(typeof url).toBe("function");
    if (typeof url !== "function") throw new TypeError("inspector.url is unavailable");
    expect(Reflect.apply(url, inspector, [])).toBeUndefined();
  });
});
