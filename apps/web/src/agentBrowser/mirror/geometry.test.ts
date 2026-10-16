import { describe, expect, it } from "vite-plus/test";

import {
  fitPage,
  fractionIn,
  inputModifiers,
  keyText,
  toPagePoint,
  wheelDeltaPx,
} from "./geometry";

const page = { width: 1280, height: 720 };

describe("fitPage", () => {
  it("scales a wide page down to the frame and centers it vertically", () => {
    expect(fitPage({ width: 640, height: 600 }, page)).toEqual({ scale: 0.5, left: 0, top: 120 });
  });

  it("never scales a page up", () => {
    expect(fitPage({ width: 1600, height: 900 }, page)).toEqual({ scale: 1, left: 160, top: 90 });
  });

  it("leaves the page alone until both sizes are known", () => {
    expect(fitPage({ width: 0, height: 0 }, page)).toEqual({ scale: 1, left: 0, top: 0 });
  });
});

describe("toPagePoint", () => {
  const fit = fitPage({ width: 640, height: 600 }, page);

  it("maps a point in the frame to the page's CSS pixels", () => {
    expect(toPagePoint(320, 300, fit, page, false)).toEqual({ x: 640, y: 360 });
    expect(toPagePoint(0, 120, fit, page, false)).toEqual({ x: 0, y: 0 });
  });

  it("ignores the letterbox unless a drag is pinned to the page's edge", () => {
    expect(toPagePoint(320, 50, fit, page, false)).toBeNull();
    expect(toPagePoint(320, 50, fit, page, true)).toEqual({ x: 640, y: 0 });
    expect(toPagePoint(700, 590, fit, page, true)).toEqual({ x: 1280, y: 720 });
  });
});

describe("fractionIn", () => {
  const box = { left: 100, top: 20, width: 200, height: 40 };

  it("says where a point sits across an element's box", () => {
    expect(fractionIn(box, 100, 20)).toEqual({ fx: 0, fy: 0 });
    expect(fractionIn(box, 150, 50)).toEqual({ fx: 0.25, fy: 0.75 });
    expect(fractionIn(box, 300, 60)).toEqual({ fx: 1, fy: 1 });
  });

  it("keeps a point just outside the box on its edge, and aims at an empty box's middle", () => {
    expect(fractionIn(box, 99.5, 61)).toEqual({ fx: 0, fy: 1 });
    expect(fractionIn({ left: 10, top: 10, width: 0, height: 0 }, 10, 10)).toEqual({
      fx: 0.5,
      fy: 0.5,
    });
  });
});

describe("input details", () => {
  it("turns line and page wheel deltas into pixels", () => {
    expect(wheelDeltaPx(3, 0, 720)).toBe(3);
    expect(wheelDeltaPx(3, 1, 720)).toBe(48);
    expect(wheelDeltaPx(1, 2, 720)).toBe(720);
  });

  it("packs modifiers the way CDP reads them", () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(inputModifiers(none)).toBe(0);
    expect(inputModifiers({ ...none, altKey: true, shiftKey: true })).toBe(9);
    expect(inputModifiers({ ...none, ctrlKey: true, metaKey: true })).toBe(6);
  });

  it("types printable keys and Enter, never shortcuts", () => {
    const plain = { ctrlKey: false, metaKey: false };
    expect(keyText({ ...plain, key: "a" })).toBe("a");
    expect(keyText({ ...plain, key: "é" })).toBe("é");
    expect(keyText({ ...plain, key: "Enter" })).toBe("\r");
    expect(keyText({ ...plain, key: "ArrowLeft" })).toBeUndefined();
    expect(keyText({ ...plain, ctrlKey: true, key: "a" })).toBeUndefined();
  });
});
