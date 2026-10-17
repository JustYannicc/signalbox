import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { StoredSidebarView } from "./sidebarView";

const decode = Schema.decodeUnknownSync(StoredSidebarView);

describe("StoredSidebarView", () => {
  it("keeps the views that still exist", () => {
    expect(decode("home")).toBe("home");
  });

  it("opens Home for a saved view that was removed from the rail", () => {
    expect(decode("pipeline")).toBe("home");
    expect(decode("automations")).toBe("home");
    expect(decode("spaces")).toBe("home");
  });

  it("rejects anything else, so the stored value falls back to the default", () => {
    expect(() => decode("plugins")).toThrow();
  });
});
