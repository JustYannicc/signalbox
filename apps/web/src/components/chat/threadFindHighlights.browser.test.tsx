import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { collectThreadFindRanges, useThreadFindHighlights } from "./threadFindHighlights";
import { toolInputFindPresentation } from "./toolInputFind";

function renderInput(value: unknown) {
  const input = toolInputFindPresentation(value);
  const scope = document.createElement("div");
  for (const [key, value] of Object.entries(input.attributes)) scope.setAttribute(key, value);
  if (input.args) {
    for (const [key, value] of input.args) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${key} `;
      row.append(label, value);
      scope.append(row);
    }
  } else {
    scope.textContent = input.argsText;
  }
  return scope;
}

function Probe(props: Parameters<typeof useThreadFindHighlights>[0]) {
  useThreadFindHighlights(props);
  return null;
}

let root: Root;
let host: HTMLElement;
let container: HTMLElement;
const onActiveRange = vi.fn();
const activeRanges = () => [
  ...(CSS.highlights.get("t3-thread-find-active") as unknown as Set<Range>),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  host = document.createElement("div");
  container = document.createElement("div");
  container.innerHTML =
    '<div data-timeline-row-id="first"><p data-thread-find-text>COD4 and COD4</p></div>' +
    '<div data-timeline-row-id="second"><p data-thread-find-text>COD4</p></div>';
  document.body.append(host, container);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("find highlight caching", () => {
  it("maps safe input values to glyphs before output occurrences, excluding keys and secrets", () => {
    container.innerHTML =
      '<div data-timeline-row-id="group" data-thread-find-entry-id="tool"></div>';
    const row = container.firstElementChild!;
    const input = renderInput({ "café label": "café", password: "café secret" });
    const output = document.createElement("pre");
    output.setAttribute("data-thread-find-text", "tool-output");
    output.textContent = "café";
    row.append(input, output);
    const ranges = collectThreadFindRanges(container, "café");
    expect(
      ranges.map(({ rowId, occurrence, range }) => [rowId, occurrence, range.toString()]),
    ).toEqual([
      ["tool", 0, "café"],
      ["tool", 1, "café"],
    ]);
    expect(ranges[0]!.range.startContainer.parentElement?.textContent).toBe("café label café");
    expect(ranges[0]!.range.startOffset).toBe(0);
    expect(ranges[1]!.range.startContainer.parentElement).toBe(output);
  });

  it("maps nested escaped input and repeated values to their own rendered positions", () => {
    container.innerHTML = '<div data-timeline-row-id="tool"></div>';
    const input = renderInput({
      query: { password: "café", terms: ["café", "café"], escaped: 'say "hi"\n😀' },
    });
    container.firstElementChild!.append(input);
    const repeated = collectThreadFindRanges(container, "café");
    expect(repeated).toHaveLength(2);
    expect(repeated.every(({ range }) => range.toString() === "café")).toBe(true);
    expect(repeated[0]!.range.startOffset).toBeLessThan(repeated[1]!.range.startOffset);
    const escaped = collectThreadFindRanges(container, '"hi"\n😀');
    expect(escaped).toHaveLength(1);
    expect(escaped[0]!.range.toString()).toBe('\\"hi\\"\\n😀');
  });

  it("keeps the global input budget from shifting an output match", () => {
    container.innerHTML = '<div data-timeline-row-id="tool"></div>';
    const input = renderInput({ prefix: "x".repeat(998), suffix: "café" });
    const output = document.createElement("pre");
    output.setAttribute("data-thread-find-text", "tool-output");
    output.textContent = "café";
    container.firstElementChild!.append(input, output);
    const ranges = collectThreadFindRanges(container, "café");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.occurrence).toBe(0);
    expect(ranges[0]!.range.startContainer.parentElement).toBe(output);
  });

  it("restarts non-overlapping matching at each indexed output edge", () => {
    container.innerHTML =
      '<div data-timeline-row-id="tool"><pre data-thread-find-text="tool-output"></pre></div>';
    container.querySelector("pre")!.textContent = "a".repeat(1001);
    const ranges = collectThreadFindRanges(container, "aa");
    expect(ranges).toHaveLength(320);
    expect(ranges[160]!.range.startOffset).toBe(681);
    expect(ranges[319]!.range.startOffset).toBe(999);
  });
  it("counts only the indexed output edges, preserving the tail occurrence", () => {
    container.innerHTML =
      '<div data-timeline-row-id="tool"><pre data-thread-find-text="tool-output"></pre></div>';
    const output = container.querySelector("pre")!;
    output.textContent = "café" + "x".repeat(350) + "café" + "x".repeat(350) + "café";
    const ranges = collectThreadFindRanges(container, "café");
    expect(ranges.map(({ occurrence, range }) => [occurrence, range.startOffset])).toEqual([
      [0, 0],
      [1, output.textContent.length - 4],
    ]);
  });
  it("keeps tool occurrences under their source item inside a grouped timeline row", () => {
    container.innerHTML =
      '<div data-timeline-row-id="work-group:first:details">' +
      '<div data-thread-find-entry-id="first"><pre data-thread-find-text>café</pre></div>' +
      '<div data-thread-find-entry-id="second"><span>café wrapper</span><pre data-thread-find-text>printf café</pre><pre data-thread-find-text>café output</pre></div></div>';
    const ranges = collectThreadFindRanges(container, "café");
    expect(
      ranges.map(({ rowId, occurrence, range }) => [rowId, occurrence, range.toString()]),
    ).toEqual([
      ["first", 0, "café"],
      ["second", 0, "café"],
      ["second", 1, "café"],
    ]);
  });

  it("checks only the old and new occurrence when cycling a message with many clipped matches", async () => {
    container.innerHTML =
      '<div data-timeline-row-id="first"><div data-thread-find-fold><p data-thread-find-text>' +
      "COD4 ".repeat(1500) +
      "</p></div></div>";
    const bounds = vi.fn(() => new DOMRect(0, 0, 40, 20));
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: bounds,
    });
    container.querySelector<HTMLElement>("[data-thread-find-fold]")!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 800, 100);
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    try {
      await act(async () => root.render(<Probe {...props} />));
      const inactive = CSS.highlights.get("t3-thread-find");
      const first = activeRanges()[0];
      bounds.mockClear();
      await act(async () => root.render(<Probe {...props} activeOccurrence={1} />));
      expect(bounds).toHaveBeenCalledTimes(2);
      expect(CSS.highlights.get("t3-thread-find")).toBe(inactive);
      expect(inactive?.size).toBe(1499);
      expect(inactive?.has(first!)).toBe(true);
      expect(activeRanges()[0]?.startOffset).toBe(5);
      expect(inactive?.has(activeRanges()[0]!)).toBe(false);
    } finally {
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("repaints for searchable text changes but not for timers outside it", async () => {
    const timer = document.createElement("span");
    container.firstElementChild!.append(timer);
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    onActiveRange.mockClear();
    await act(async () => {
      timer.textContent = "0:01";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onActiveRange).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector("p")!.append(" COD4");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onActiveRange).toHaveBeenCalled();
  });

  it("opens only the selected fold while reusing its cached text", async () => {
    container.innerHTML =
      '<div data-timeline-row-id="first"><div hidden><p data-thread-find-text>COD4 COD4</p></div></div>' +
      '<div data-timeline-row-id="second"><div hidden><p data-thread-find-text>COD4</p></div></div>';
    const folds = [...container.querySelectorAll<HTMLElement>("[hidden]")];
    for (const fold of folds)
      fold.addEventListener("beforematch", () => fold.removeAttribute("hidden"));
    const createRange = vi.spyOn(document, "createRange");
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(folds[0]?.hasAttribute("hidden")).toBe(false);
    expect(folds[1]?.hasAttribute("hidden")).toBe(true);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(1);
    const scanned = createRange.mock.calls.length;
    await act(async () =>
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={1}
          onActiveRange={onActiveRange}
        />,
      ),
    );
    expect(createRange).toHaveBeenCalledTimes(scanned);
    expect(activeRanges()[0]?.startOffset).toBe(5);
  });

  it("observes rows mounted synchronously while revealing the first match", async () => {
    container.replaceChildren();
    onActiveRange.mockImplementationOnce(() => {
      container.innerHTML =
        '<div data-timeline-row-id="first"><p data-thread-find-text>COD4</p></div>';
    });
    await act(async () => {
      root.render(
        <Probe
          container={container}
          query="COD4"
          activeRowId="first"
          activeOccurrence={0}
          onActiveRange={onActiveRange}
        />,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("rebuilds ranges when the list moves or recycles an existing row", async () => {
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await act(async () => root.render(<Probe {...props} />));
    const initial = activeRanges()[0];
    const row = container.querySelector<HTMLElement>('[data-timeline-row-id="first"]')!;
    await act(async () => {
      row.remove();
      container.append(row);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()[0]).not.toBe(initial);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    await act(async () => {
      row.dataset.timelineRowId = "recycled";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()).toHaveLength(0);
    await act(async () => root.render(<Probe {...props} activeRowId="recycled" />));
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("reuses unchanged text ranges on navigation and scans only the streaming row", async () => {
    const createRange = vi.spyOn(document, "createRange");
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await act(async () => root.render(<Probe {...props} />));
    expect(createRange).toHaveBeenCalledTimes(3);
    const initial = activeRanges()[0];
    await act(async () => root.render(<Probe {...props} activeOccurrence={1} />));
    expect(createRange).toHaveBeenCalledTimes(3);
    expect(activeRanges()[0]?.startOffset).toBe(9);
    await act(async () => root.render(<Probe {...props} />));
    expect(activeRanges()[0]).toBe(initial);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"] p')!.firstChild!.nodeValue =
        "COD4 COD4";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]).toBe(initial);
    await act(async () =>
      root.render(<Probe {...props} activeRowId="second" activeOccurrence={1} />),
    );
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(activeRanges()[0]?.startOffset).toBe(5);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"]')!.remove();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(activeRanges()).toHaveLength(0);
    expect(onActiveRange).toHaveBeenLastCalledWith(null);
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(2);
    await act(async () => root.render(<Probe {...props} query="missing" />));
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(0);
  });
});

function row(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  return container;
}

describe("collectThreadFindRanges", () => {
  it("finds matches split across inline token spans, in order", () => {
    // Shiki-style tokens split one identifier over several text nodes.
    const container = row(
      "<pre><code><span>con</span><span>st</span> a = <span>c</span>onst; const</code></pre>",
    );
    const ranges = collectThreadFindRanges(container, "const");
    expect(ranges.map((match) => [match.occurrence, match.range.toString()])).toEqual([
      [0, "const"],
      [1, "const"],
      [2, "const"],
    ]);
  });

  it("finds every match across thousands of token nodes", () => {
    const tokens = Array.from({ length: 4000 }, (_, i) => `<span>id</span><span>${i} </span>`);
    const container = row(`<pre><code>${tokens.join("")}</code></pre>`);
    const ranges = collectThreadFindRanges(container, "id");
    expect(ranges).toHaveLength(4000);
    expect(ranges.map((match) => match.occurrence)).toEqual([...ranges.keys()]);
    expect(ranges.every((match) => match.range.toString() === "id")).toBe(true);
  });
});
