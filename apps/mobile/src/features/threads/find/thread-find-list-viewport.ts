import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import {
  measureThreadFindNode,
  type ThreadFindInsets,
  type ThreadFindMeasureNode,
  type ThreadFindRect,
  type ThreadFindViewport,
} from "./thread-find-geometry";

interface FindList {
  getState(): { readonly scroll: number };
  getNativeScrollRef(): ThreadFindMeasureNode | null;
  scrollToOffset(input: { readonly offset: number; readonly animated: boolean }): Promise<void>;
}

export function useThreadFindListViewport(input: {
  readonly listRef: RefObject<FindList | null>;
  readonly insets: (rect: ThreadFindRect) => ThreadFindInsets;
  readonly topOcclusion?: () => ThreadFindRect | null;
  readonly onBeforeScroll?: () => void;
}): ThreadFindViewport {
  const options = useRef(input);
  useLayoutEffect(() => {
    options.current = input;
  });
  return useMemo(
    () => ({
      async measure() {
        const list = input.listRef.current;
        const node = list?.getNativeScrollRef();
        if (!list || !node) return null;
        const rect = await measureThreadFindNode(node);
        if (!rect || input.listRef.current !== list || list.getNativeScrollRef() !== node)
          return null;
        const insets = options.current.insets(rect);
        const occlusion = options.current.topOcclusion?.();
        const occludes =
          occlusion &&
          occlusion.x < rect.x + rect.width &&
          occlusion.x + occlusion.width > rect.x &&
          occlusion.y < rect.y + rect.height;
        return {
          rect,
          scroll: list.getState().scroll,
          insets: occludes
            ? { ...insets, top: Math.max(insets.top, occlusion.y + occlusion.height - rect.y) }
            : insets,
        };
      },
      async scrollTo(offset) {
        const list = input.listRef.current;
        if (!list) return;
        options.current.onBeforeScroll?.();
        await list.scrollToOffset({ offset, animated: false });
      },
    }),
    [input.listRef],
  );
}
