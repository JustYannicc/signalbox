import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";

const EDGE = 16;
const OVERSCROLL = 72;
const MAX_SCALE = 2;
const SETTLE = { duration: 220 };

interface Frame {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly fitScale: number;
  readonly minScale: number;
}

/** Offsets that keep the content on screen: free inside when it fits, edge to edge when it doesn't. */
function offsetRange(content: number, view: number) {
  "worklet";
  const far = view - content - EDGE;
  return { low: Math.min(EDGE, far), high: Math.max(EDGE, far) };
}

function clamp(value: number, low: number, high: number) {
  "worklet";
  return Math.min(high, Math.max(low, value));
}

/**
 * Pan and pinch over a fixed-size drawing. Only the transform animates, on the
 * UI thread, and nothing moves while you aren't touching it. Opens fitted to
 * width, scrolled so `focus` (the part that needs you) is in view. Double-tap
 * fits it again.
 */
export function WorkflowCanvas(props: {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly focusY: number | null;
  /** Space a floating bar covers at the bottom, so the end of the diagram can scroll above it. */
  readonly bottomInset: number;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<{ width: number; height: number } | null>(null);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const frame = useSharedValue<Frame>({
    viewWidth: 1,
    viewHeight: 1,
    contentWidth: props.contentWidth,
    contentHeight: props.contentHeight,
    fitScale: 1,
    minScale: 1,
  });
  const panFrom = useSharedValue({ x: 0, y: 0 });
  const pinchFrom = useSharedValue(1);
  const placedFor = useRef<string | null>(null);

  const viewHeight = view ? Math.max(1, view.height - props.bottomInset) : 1;
  useLayoutEffect(() => {
    if (!view) return;
    const fitScale = Math.min(1, (view.width - EDGE * 2) / props.contentWidth);
    frame.set({
      viewWidth: view.width,
      viewHeight,
      contentWidth: props.contentWidth,
      contentHeight: props.contentHeight,
      fitScale,
      minScale: Math.min(fitScale, (viewHeight - EDGE * 2) / props.contentHeight, 0.5),
    });
    // Place once per drawing; live run updates must not yank the view around.
    const placement = `${props.contentWidth}x${props.contentHeight}`;
    if (placedFor.current === placement) return;
    placedFor.current = placement;
    scale.set(fitScale);
    x.set((view.width - props.contentWidth * fitScale) / 2);
    const top =
      props.focusY === null || props.focusY * fitScale < viewHeight * 0.6
        ? EDGE
        : viewHeight * 0.4 - props.focusY * fitScale;
    const range = offsetRange(props.contentHeight * fitScale, viewHeight);
    y.set(clamp(top, range.low, range.high));
  }, [view, viewHeight, props.contentWidth, props.contentHeight, props.focusY, frame, scale, x, y]);

  // Built once: the canvas re-renders on every live run update, and swapping
  // handlers mid-gesture would drop the pan under your finger.
  const gesture = useMemo(() => {
    const settle = () => {
      "worklet";
      const f = frame.get();
      const rx = offsetRange(f.contentWidth * scale.get(), f.viewWidth);
      const ry = offsetRange(f.contentHeight * scale.get(), f.viewHeight);
      x.set(withTiming(clamp(x.get(), rx.low, rx.high), SETTLE));
      y.set(withTiming(clamp(y.get(), ry.low, ry.high), SETTLE));
    };

    const pan = Gesture.Pan()
      .averageTouches(true)
      .onStart(() => {
        cancelAnimation(x);
        cancelAnimation(y);
        panFrom.set({ x: 0, y: 0 });
      })
      .onUpdate((event) => {
        const f = frame.get();
        const rx = offsetRange(f.contentWidth * scale.get(), f.viewWidth);
        const ry = offsetRange(f.contentHeight * scale.get(), f.viewHeight);
        x.set(
          clamp(
            x.get() + event.translationX - panFrom.get().x,
            rx.low - OVERSCROLL,
            rx.high + OVERSCROLL,
          ),
        );
        y.set(
          clamp(
            y.get() + event.translationY - panFrom.get().y,
            ry.low - OVERSCROLL,
            ry.high + OVERSCROLL,
          ),
        );
        panFrom.set({ x: event.translationX, y: event.translationY });
      })
      .onEnd((event) => {
        const f = frame.get();
        const rx = offsetRange(f.contentWidth * scale.get(), f.viewWidth);
        const ry = offsetRange(f.contentHeight * scale.get(), f.viewHeight);
        const glide = (value: number, velocity: number, low: number, high: number) =>
          value < low || value > high
            ? withTiming(clamp(value, low, high), SETTLE)
            : withDecay({ velocity, clamp: [low, high] });
        x.set(glide(x.get(), event.velocityX, rx.low, rx.high));
        y.set(glide(y.get(), event.velocityY, ry.low, ry.high));
      });

    const pinch = Gesture.Pinch()
      .onStart(() => {
        cancelAnimation(x);
        cancelAnimation(y);
        pinchFrom.set(1);
      })
      .onUpdate((event) => {
        const f = frame.get();
        const next = clamp((scale.get() * event.scale) / pinchFrom.get(), f.minScale, MAX_SCALE);
        const factor = next / scale.get();
        // Zoom about the fingers: the point under them stays under them.
        x.set(event.focalX - (event.focalX - x.get()) * factor);
        y.set(event.focalY - (event.focalY - y.get()) * factor);
        scale.set(next);
        pinchFrom.set(event.scale);
      })
      .onEnd(settle);

    const fit = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        const f = frame.get();
        scale.set(withTiming(f.fitScale, SETTLE));
        x.set(withTiming((f.viewWidth - f.contentWidth * f.fitScale) / 2, SETTLE));
        const ry = offsetRange(f.contentHeight * f.fitScale, f.viewHeight);
        y.set(withTiming(clamp(y.get(), ry.low, ry.high), SETTLE));
      });

    return Gesture.Simultaneous(pan, pinch, fit);
  }, [frame, scale, x, y, panFrom, pinchFrom]);

  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        className="flex-1 overflow-hidden"
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setView((current) =>
            current?.width === width && current.height === height ? current : { width, height },
          );
        }}
      >
        {view ? (
          <Animated.View
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: props.contentWidth,
                height: props.contentHeight,
                transformOrigin: "0 0",
              },
              transform,
            ]}
          >
            {props.children}
          </Animated.View>
        ) : null}
      </View>
    </GestureDetector>
  );
}
