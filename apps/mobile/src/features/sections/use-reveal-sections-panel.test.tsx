// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRevealSectionsPanel } from "./use-reveal-sections-panel";

function Home(props: { readonly open: boolean; readonly scrollToTop: () => void }) {
  useRevealSectionsPanel(props.open, props.scrollToTop);
  return null;
}

describe("revealing the sections panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("scrolls up to the panel each time it opens", () => {
    const scrollToTop = vi.fn();
    act(() => root.render(<Home open={false} scrollToTop={scrollToTop} />));
    act(() => root.render(<Home open scrollToTop={scrollToTop} />));
    act(() => root.render(<Home open={false} scrollToTop={scrollToTop} />));
    act(() => root.render(<Home open scrollToTop={scrollToTop} />));
    expect(scrollToTop).toHaveBeenCalledTimes(2);
  });

  it("keeps the restored scroll position when Home returns with the panel open", () => {
    const scrollToTop = vi.fn();
    act(() => root.render(<Home open scrollToTop={scrollToTop} />));
    act(() => root.render(<Home open scrollToTop={() => scrollToTop()} />));
    expect(scrollToTop).not.toHaveBeenCalled();
  });
});
