/**
 * Pan and zoom for the workflow canvas. Drag the background or scroll to pan,
 * pinch or Cmd/Ctrl+scroll to zoom around the pointer. Until the user moves
 * the view it keeps refitting the graph as the canvas resizes, so opening the
 * details panel never strands nodes off-screen.
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

import { NODE_HEIGHT, NODE_WIDTH, type WorkflowNode } from "./automationModel";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.75;
const FIT_PADDING = 56;
/** Pointer travel below this still counts as a click on the background. */
const DRAG_THRESHOLD = 3;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

function fitViewport(nodes: readonly WorkflowNode[], width: number, height: number): Viewport {
  if (nodes.length === 0 || width === 0 || height === 0) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const boundsWidth = Math.max(...nodes.map((node) => node.x)) + NODE_WIDTH - minX;
  const boundsHeight = Math.max(...nodes.map((node) => node.y)) + NODE_HEIGHT - minY;
  const zoom = clampZoom(
    Math.min((width - FIT_PADDING * 2) / boundsWidth, (height - FIT_PADDING * 2) / boundsHeight, 1),
  );
  return {
    x: (width - boundsWidth * zoom) / 2 - minX * zoom,
    y: (height - boundsHeight * zoom) / 2 - minY * zoom,
    zoom,
  };
}

export function useCanvasViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  nodes: readonly WorkflowNode[],
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

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    userMovedRef.current = false;
    setViewport(fitViewport(nodes, container.clientWidth, container.clientHeight));
  }, [containerRef, nodes]);

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
