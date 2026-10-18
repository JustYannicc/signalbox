import { describe, expect, it } from "@effect/vitest";
import { createNodeEnvironmentResolver } from "../NodeEnvironment.ts";
import {
  createNodeNativeAddonModules,
  NodeCapabilityNeedsMachineError,
} from "../NodeNativeAddon.ts";

const image = "/$bunfs/root/image-processor.node";
const audio = "/$bunfs/root/audio-capture.node";

describe("native addon call boundary", () => {
  it("imports exact declared exports without invoking native capabilities", () => {
    const modules = createNodeNativeAddonModules([
      { specifier: image, members: ["processImage"] },
      { specifier: audio, members: ["startRecording", "microphoneAuthorizationStatus"] },
    ]);
    const exports = modules.get(audio);
    expect(Object.keys(exports ?? {})).toEqual(["startRecording", "microphoneAuthorizationStatus"]);
    expect(exports && Reflect.get(exports, "microphoneAuthorizationStatus")).toBeTypeOf("function");
    expect(exports && Reflect.get(exports, "unknownMember")).toBeUndefined();
    expect(modules.has("./vendor/audio-capture/x64-linux/audio-capture.node")).toBe(false);
  });

  it("throws the typed addon and member at the actual call", () => {
    const modules = createNodeNativeAddonModules([{ specifier: image, members: ["processImage"] }]);
    const exports = modules.get(image);
    if (!exports) throw new Error("Missing declared addon");
    const processImage = Reflect.get(exports, "processImage");
    expect(() => Reflect.apply(processImage, exports, [new Uint8Array([1])])).toThrow(
      expect.objectContaining({
        name: "NodeCapabilityNeedsMachineError",
        code: "ERR_NODE_CAPABILITY_NEEDS_MACHINE",
        addon: image,
        member: "processImage",
      }),
    );
    expect(() => Reflect.construct(processImage, [])).toThrow(TypeError);
  });

  it("caches addon exports and forwards only undeclared names to the prepared resolver", () => {
    const seen: unknown[][] = [];
    const resolver = createNodeEnvironmentResolver({
      packages: {},
      addons: [{ specifier: image, members: ["processImage"] }],
      prepared: (specifier, referrer) => {
        seen.push([specifier, referrer]);
        return "prepared";
      },
    });
    expect(resolver(image, "/release/entry.js")).toBe(resolver(image, "/another/entry.js"));
    const addon = resolver(image, "/release/entry.js");
    expect(addon).toBeTypeOf("object");
    expect(resolver("./internal.cjs", "/release/entry.js")).toBe("prepared");
    expect(seen).toEqual([["./internal.cjs", "/release/entry.js"]]);
    expect(NodeCapabilityNeedsMachineError.prototype).toBeInstanceOf(Error);
  });
});
