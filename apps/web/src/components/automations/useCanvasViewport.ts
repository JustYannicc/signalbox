/**
 * Pan and zoom for the diagram canvas. Drag the background or scroll to pan,
 * pinch or Cmd/Ctrl+scroll to zoom around the pointer. Until the user moves
 * the view it keeps the diagram fitted as the canvas resizes, so opening the
 * details panel never strands the diagram off-screen.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.75;
const FIT_PADDING = 40;
/** Pointer travel below this still counts as a click on the background. */
const DRAG_THRESHOLD = 3;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * Fits the diagram's width, but never shrinks a tall diagram below a readable
 * size just to show all of it: a long automation starts at the top and scrolls.
 */
function fitViewport(
  bounds: { width: number; height: number },
  width: number,
  height: number,
): Viewport {
  if (bounds.width === 0 || width === 0 || height === 0) return { x: 0, y: 0, zoom: 1 };
  const fitWidth = (width - FIT_PADDING * 2) / bounds.width;
  const fitHeight = (height - FIT_PADDING * 2) / bounds.height;
  const zoom = clampZoom(Math.min(1, fitWidth, Math.max(fitHeight, 0.7)));
  const tall = bounds.height * zoom > height - FIT_PADDING * 2;
  return {
    x: (width - bounds.width * zoom) / 2,
    y: tall ? FIT_PADDING / 2 : (height - bounds.height * zoom) / 2,
    zoom,
  };
}

export function useCanvasViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  bounds: { width: number; height: number },
  onBackgroundClick: () => void,
) {
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const userMovedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    origin: Viewport;
  } | null>(null);
  const { width, height } = bounds;

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    userMovedRef.current = false;
    setViewport(fitViewport({ width, height }, container.clientWidth, container.clientHeight));
  }, [containerRef, width, height]);

  useLayoutEffect(() => {
    fit();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!userMovedRef.current) fit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, fit]);

  const zoomAround = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
      const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
      userMovedRef.current = true;
      setViewport((current) => {
        const zoom = clampZoom(current.zoom * factor);
        const scale = zoom / current.zoom;
        return { zoom, x: px - (px - current.x) * scale, y: py - (py - current.y) * scale };
      });
    },
    [containerRef],
  );

  // React's onWheel is passive, so preventDefault needs a native listener.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAround(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
        return;
      }
      userMovedRef.current = true;
      setViewport((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomAround]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("[data-workflow-node], [data-canvas-control]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      origin: viewport,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    userMovedRef.current = true;
    setViewport({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) onBackgroundClick();
  };

  return {
    viewport,
    fit,
    zoomIn: () => zoomAround(1.2),
    zoomOut: () => zoomAround(1 / 1.2),
    canvasHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => {
        dragRef.current = null;
      },
    },
  };
}
