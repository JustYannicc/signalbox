import { useCallback, useLayoutEffect, useRef } from "react";
import type { ViewInstance } from "react-native";

import type { ThreadFindRect } from "./thread-find-geometry";

export function useThreadFindBarOcclusion(
  visible: boolean,
  onChange: ((rect: ThreadFindRect | null) => void) | undefined,
) {
  const ref = useRef<ViewInstance>(null);
  const generation = useRef(0);
  const currentVisible = useRef(visible);
  const measure = useCallback(() => {
    if (!visible || !currentVisible.current) return;
    const measuredGeneration = generation.current;
    ref.current?.measureInWindow((x, y, width, height) => {
      if (
        !currentVisible.current ||
        generation.current !== measuredGeneration ||
        width <= 0 ||
        height <= 0
      )
        return;
      onChange?.({ x, y, width, height });
    });
  }, [visible, onChange]);
  useLayoutEffect(() => {
    currentVisible.current = visible;
    generation.current++;
    if (visible) measure();
    else onChange?.(null);
    return () => {
      currentVisible.current = false;
      generation.current++;
      onChange?.(null);
    };
  }, [visible, measure, onChange]);
  return { ref, measure };
}
