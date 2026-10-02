/**
 * Renders the app window to a PNG for feedback. The desktop bridge has no
 * self-capture API (SnapShot is a system-screenshot flow with its own
 * permissions), so this draws the DOM through modern-screenshot, which is
 * imported on first use and costs nothing until then.
 *
 * Popovers and tooltips are left out, so the feedback popover never appears in
 * its own screenshot. Native surfaces the DOM cannot see (webviews, iframes
 * from other origins) render blank.
 */
const EXCLUDED_SLOTS = new Set(["popover-positioner", "tooltip-positioner"]);

function keepNode(node: Node): boolean {
  return !(node instanceof HTMLElement && EXCLUDED_SLOTS.has(node.dataset.slot ?? ""));
}

export async function captureAppScreenshot(): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  return domToBlob(document.body, {
    type: "image/png",
    width: window.innerWidth,
    height: window.innerHeight,
    // Retina detail without shipping 3x monsters from high-density displays.
    scale: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    filter: keepNode,
    timeout: 10_000,
  });
}
