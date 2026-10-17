import { describe, expect, it } from "vite-plus/test";

import { resolveCollapsedRailWidth } from "./workspaceTitlebar";

describe("resolveCollapsedRailWidth", () => {
  it("takes the rail's width off collapsed headers at desktop widths", () => {
    expect(resolveCollapsedRailWidth({ isMobile: false, railLayout: true })).toBe(
      "var(--sidebar-width-icon)",
    );
  });

  it("leaves the inset alone when nothing stays beside main content", () => {
    // Mobile shows the sidebar as a sheet; the legacy sidebar slides away whole.
    expect(resolveCollapsedRailWidth({ isMobile: true, railLayout: true })).toBeUndefined();
    expect(resolveCollapsedRailWidth({ isMobile: false, railLayout: false })).toBeUndefined();
  });
});
