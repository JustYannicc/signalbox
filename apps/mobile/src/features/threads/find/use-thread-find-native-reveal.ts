import { useCallback, useLayoutEffect, useRef } from "react";
import type { MarkdownSourceSelection } from "react-native-enriched-markdown";

import type { SelectableMarkdownTextProps } from "../../../native/SelectableMarkdownText.types";
import type { useThreadFindReveal } from "./thread-find-reveal-context";

export function useThreadFindNativeReveal(
  reveal: ReturnType<typeof useThreadFindReveal>,
  revision: string,
  selection: MarkdownSourceSelection | null,
) {
  const active = useRef({ request: reveal.request, revision, selection });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    active.current = { request: reveal.request, revision, selection };
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [reveal.request, revision, selection]);
  const reportGlyphRects = reveal.reportGlyphRects;
  return useCallback<NonNullable<SelectableMarkdownTextProps["onSourceSelection"]>>(
    (result, rootRef) => {
      const selected = active.current.selection;
      const request = active.current.request;
      if (
        !mounted.current ||
        !request ||
        !selected ||
        result.status !== "applied" ||
        result.requestId !== request.requestId ||
        result.requestId !== selected.requestId ||
        result.revision !== active.current.revision ||
        result.revision !== selected.revision
      )
        return;
      void reportGlyphRects({
        requestId: request.requestId,
        revision: request.revision,
        sourceRevision: result.revision,
        rootRef,
        rects: result.rects,
        isCurrent: () =>
          mounted.current &&
          active.current.request === request &&
          active.current.selection === selected,
      });
    },
    [reportGlyphRects],
  );
}
