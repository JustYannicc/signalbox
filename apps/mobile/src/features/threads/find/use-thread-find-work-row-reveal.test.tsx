// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadFindWorkRowReveal } from "./use-thread-find-work-row-reveal";

type Input = Parameters<typeof useThreadFindWorkRowReveal>[0];
const rows = Array.from({ length: 25 }, (_, index) => ({ id: `activity-${index}` }));

function Harness(props: Input) {
  useThreadFindWorkRowReveal(props);
  return null;
}

function pendingScroll() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe("Find inside a capped work-list viewport", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("waits for loading and row expansion, then acknowledges mounting only after scrolling to the last activity", async () => {
    const pending = pendingScroll();
    const list = { getState: () => ({ data: rows }), scrollToIndex: vi.fn(() => pending.promise) };
    const onRowMounted = vi.fn();
    const onBeforeScroll = vi.fn();
    const input: Input = {
      request: { key: "find-last", rowId: "activity-24", anchorKey: "work-group" },
      rows,
      expandedRows: {},
      loaded: false,
      listRef: { current: list },
      onBeforeScroll,
      onRowMounted,
    };
    await act(async () => {
      root.render(<Harness {...input} />);
    });
    expect(list.scrollToIndex).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Harness {...input} loaded />);
    });
    expect(list.scrollToIndex).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Harness {...input} loaded expandedRows={{ "activity-24": true }} />);
    });
    expect(onBeforeScroll).toHaveBeenCalledOnce();
    expect(list.scrollToIndex).toHaveBeenCalledWith({
      index: 24,
      animated: false,
      viewPosition: 0,
    });
    expect(onRowMounted).not.toHaveBeenCalled();
    await act(async () => {
      pending.finish();
    });
    expect(onRowMounted).toHaveBeenCalledExactlyOnceWith("find-last");
  });

  it("does not let an old inner scroll acknowledge a newer Find selection or a closed Find session", async () => {
    const first = pendingScroll();
    const second = pendingScroll();
    const list = {
      getState: () => ({ data: rows }),
      scrollToIndex: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    };
    const onRowMounted = vi.fn();
    const input: Input = {
      request: { key: "first", rowId: "activity-24", anchorKey: "work-group" },
      rows,
      expandedRows: { "activity-24": true, "activity-4": true },
      loaded: true,
      listRef: { current: list },
      onBeforeScroll: () => {},
      onRowMounted,
    };
    await act(async () => {
      root.render(<Harness {...input} />);
    });
    await act(async () => {
      root.render(
        <Harness
          {...input}
          request={{ key: "second", rowId: "activity-4", anchorKey: "work-group" }}
        />,
      );
    });
    await act(async () => {
      first.finish();
    });
    expect(onRowMounted).not.toHaveBeenCalled();
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({
      index: 4,
      animated: false,
      viewPosition: 0,
    });
    await act(async () => {
      root.render(<Harness {...input} request={null} />);
    });
    await act(async () => {
      second.finish();
    });
    expect(onRowMounted).not.toHaveBeenCalled();
  });
});
