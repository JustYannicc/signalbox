import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import {
  matchesThreadFindRequest,
  revealThreadFindGlyph,
  type ThreadFindMeasureNode,
  type ThreadFindRect,
  type ThreadFindViewport,
} from "./thread-find-geometry";
import type { ThreadFindRevealRequest } from "./thread-find-model";

interface GlyphReport {
  readonly requestId: string;
  readonly revision: string;
  readonly rootRef: RefObject<ThreadFindMeasureNode | null>;
  readonly rects: ReadonlyArray<ThreadFindRect>;
  readonly isCurrent?: () => boolean;
  readonly sourceRevision?: string;
}

const RevealContext = createContext<{
  readonly request: ThreadFindRevealRequest | null;
  readonly isCurrent: (request: ThreadFindRevealRequest) => boolean;
  readonly onRevealed: (requestId: string) => void;
} | null>(null);
const ViewportsContext = createContext<ReadonlyArray<ThreadFindViewport>>([]);

export function ThreadFindRevealProvider(props: {
  readonly request: ThreadFindRevealRequest | null;
  readonly sourceIdentity: unknown;
  readonly viewport: ThreadFindViewport;
  readonly onRevealed: (requestId: string) => void;
  readonly children: ReactNode;
}) {
  const identity = useMemo(
    () => ({ request: props.request, sourceIdentity: props.sourceIdentity }),
    [props.request, props.sourceIdentity],
  );
  const active = useRef<object | null>(identity);
  useLayoutEffect(() => {
    active.current = identity;
    return () => {
      active.current = null;
    };
  }, [identity]);
  const isCurrent = useCallback(
    (request: ThreadFindRevealRequest) =>
      active.current === identity && matchesThreadFindRequest(props.request, request),
    [identity, props.request],
  );
  const value = useMemo(
    () => ({ request: props.request, isCurrent, onRevealed: props.onRevealed }),
    [props.request, isCurrent, props.onRevealed],
  );
  const viewports = useMemo(() => [props.viewport], [props.viewport]);
  return (
    <RevealContext value={value}>
      <ViewportsContext value={viewports}>{props.children}</ViewportsContext>
    </RevealContext>
  );
}

export function ThreadFindViewportProvider(props: {
  readonly viewport: ThreadFindViewport;
  readonly children: ReactNode;
}) {
  const ancestors = useContext(ViewportsContext);
  const viewports = useMemo(() => [props.viewport, ...ancestors], [props.viewport, ancestors]);
  return <ViewportsContext value={viewports}>{props.children}</ViewportsContext>;
}

export function useThreadFindReveal(entryId: string | null) {
  const context = useContext(RevealContext);
  const viewports = useContext(ViewportsContext);
  const request = context?.request?.target.entryId === entryId ? context.request : null;
  const lifetime = useMemo(
    () => ({ entryId, request, viewports, isCurrent: context?.isCurrent }),
    [entryId, request, viewports, context?.isCurrent],
  );
  const activeLifetime = useRef<typeof lifetime | null>(lifetime);
  const generation = useRef(0);
  useLayoutEffect(() => {
    activeLifetime.current = lifetime;
    return () => {
      activeLifetime.current = null;
    };
  }, [lifetime]);
  const reportGlyphRects = useCallback(
    async (report: GlyphReport) => {
      if (
        !request ||
        !context ||
        report.requestId !== request.requestId ||
        report.revision !== request.revision ||
        !context.isCurrent(request) ||
        report.isCurrent?.() === false
      ) {
        return false;
      }
      const reportGeneration = ++generation.current;
      const current = () =>
        activeLifetime.current === lifetime &&
        generation.current === reportGeneration &&
        context.isCurrent(request) &&
        report.isCurrent?.() !== false;
      const visible = await revealThreadFindGlyph({
        rootRef: report.rootRef,
        rects: report.rects,
        viewports,
        isCurrent: current,
      }).catch(() => false);
      if (!visible || !current()) return false;
      context.onRevealed(request.requestId);
      return true;
    },
    [request, context, viewports, lifetime],
  );
  return { request, reportGlyphRects };
}
