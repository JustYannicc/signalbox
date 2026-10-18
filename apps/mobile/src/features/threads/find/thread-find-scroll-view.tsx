import { useMemo, useRef, type ComponentProps } from "react";
import { ScrollView, type ScrollViewInstance } from "react-native";

import { measureThreadFindNode, type ThreadFindViewport } from "./thread-find-geometry";
import { ThreadFindViewportProvider } from "./thread-find-reveal-context";

/** A native capped ScrollView contributes its measured viewport to Find. */
export function ThreadFindScrollView(props: ComponentProps<typeof ScrollView>) {
  const root = useRef<ScrollViewInstance>(null);
  const scroll = useRef(0);
  const insets = useRef({ top: 0, bottom: 0, left: 0, right: 0 });
  const viewport = useMemo<ThreadFindViewport>(
    () => ({
      async measure() {
        const node = root.current;
        if (!node) return null;
        const rect = await measureThreadFindNode(node);
        return rect && root.current === node
          ? { rect, scroll: scroll.current, insets: insets.current }
          : null;
      },
      async scrollTo(offset) {
        root.current?.scrollTo({ y: offset, animated: false });
        // ScrollView has no scroll promise. Measure after the native frame that
        // applies this command; the caller still verifies the actual rectangle.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    }),
    [],
  );
  return (
    <ThreadFindViewportProvider viewport={viewport}>
      <ScrollView
        {...props}
        ref={root}
        scrollEventThrottle={16}
        onScroll={(event) => {
          scroll.current = event.nativeEvent.contentOffset.y;
          insets.current = event.nativeEvent.contentInset;
          props.onScroll?.(event);
        }}
      />
    </ThreadFindViewportProvider>
  );
}
