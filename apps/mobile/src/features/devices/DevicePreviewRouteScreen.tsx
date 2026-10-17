import * as Dialog from "../../components/ui/Dialog";
import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  deviceSessionRequiresReadOnlyPanel,
  type DeviceSession,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import { AppState, BackHandler, Pressable, StatusBar, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  androidHeaderMenuActions,
  findHeaderMenuAction,
} from "../../components/ui/headerMenu.android";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { deviceEnvironment, refreshDeviceHubAccess, useDeviceHubAccess } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import { uuidv4 } from "../../lib/uuid";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  type ThreadDevicePreview,
} from "./threadDevicePreviews";
import { createShakeDetector } from "./shakeDetector";

const OVERLAY_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const OVERLAY_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      onClose={onClose}
    />
  );
}

function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inputConnected, setInputConnected] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const openDevice = useAtomCommand(deviceEnvironment.open, { reportFailure: false });
  const cancelDeviceOpen = useAtomCommand(deviceEnvironment.cancelOpen, { reportFailure: false });
  const closeDevice = useAtomCommand(deviceEnvironment.close, { reportFailure: false });
  const [panelSession, setPanelSession] = useState<DeviceSession | null>(null);
  const panelSessionRef = useRef<DeviceSession | null>(null);
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const previews = useMemo(
    () => threadDevicePreviews(state.data, threadId),
    [state.data, threadId],
  );
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const observer =
    (preview !== null && deviceSessionRequiresReadOnlyPanel(preview.session)) ||
    panelSession?.observer === true;
  const previewKey = preview?.key;
  const previewHostId = preview?.session.hostId;
  const previewDeviceId = preview?.session.deviceId;
  const previewPlatform = preview?.session.platform;
  useEffect(() => {
    if (
      !focused ||
      !foreground ||
      previewKey === undefined ||
      previewHostId === undefined ||
      previewDeviceId === undefined ||
      previewPlatform === undefined
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let openRequest: { readonly controller: AbortController; readonly requestId: string } | null =
      null;
    let owner: DeviceSession | null = null;
    const heartbeat = async () => {
      const controller = new AbortController();
      const requestId = uuidv4();
      openRequest = { controller, requestId };
      const result = await openDevice(
        {
          environmentId,
          input: {
            threadId,
            hostId: previewHostId,
            deviceId: previewDeviceId,
            platform: previewPlatform,
            requestId,
            ...(owner === null ? {} : { sessionId: owner.sessionId, leaseId: owner.leaseId }),
          },
        },
        controller.signal,
      );
      if (openRequest?.requestId === requestId) openRequest = null;
      if (cancelled) {
        void cancelDeviceOpen({
          environmentId,
          input: {
            threadId,
            hostId: previewHostId,
            deviceId: previewDeviceId,
            requestId,
          },
        });
        if (result._tag === "Success") {
          void closeDevice({
            environmentId,
            input: {
              threadId,
              hostId: result.value.hostId,
              deviceId: result.value.deviceId,
              sessionId: result.value.sessionId,
              leaseId: result.value.leaseId,
            },
          });
        }
        return;
      }
      if (result._tag === "Success") {
        owner = result.value;
        panelSessionRef.current = owner;
        setPanelSession(owner);
      }
      timer = setTimeout(() => void heartbeat(), 60_000);
    };
    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (openRequest !== null) {
        openRequest.controller.abort();
        void cancelDeviceOpen({
          environmentId,
          input: {
            threadId,
            hostId: previewHostId,
            deviceId: previewDeviceId,
            requestId: openRequest.requestId,
          },
        });
        openRequest = null;
      }
      if (owner !== null) {
        void closeDevice({
          environmentId,
          input: {
            threadId,
            hostId: owner.hostId,
            deviceId: owner.deviceId,
            sessionId: owner.sessionId,
            leaseId: owner.leaseId,
          },
        });
      }
      panelSessionRef.current = null;
    };
  }, [
    closeDevice,
    cancelDeviceOpen,
    environmentId,
    foreground,
    focused,
    openDevice,
    previewDeviceId,
    previewHostId,
    previewKey,
    previewPlatform,
    threadId,
  ]);
  const onInputConnected = useCallback(async (connected: boolean) => {
    setInputConnected(connected);
    if (connected) setControlsVisible(false);
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);
  useEffect(() => {
    if (!focused || !foreground) return;
    const shaken = createShakeDetector();
    Accelerometer.setUpdateInterval(50);
    const subscription = Accelerometer.addListener((sample) => {
      if (!shaken({ ...sample, timestamp: sample.timestamp * 1000 })) return;
      void Haptics.selectionAsync();
      setControlsVisible((visible) => !visible);
    });
    return () => subscription.remove();
  }, [focused, foreground]);
  useEffect(() => {
    if (controlsVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setControlsVisible(true);
      return true;
    });
    return () => subscription.remove();
  }, [controlsVisible]);

  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    const session = panelSessionRef.current ?? panelSession;
    if (!session) return;
    setShuttingDown(true);
    try {
      const result = await closeDevice({
        environmentId,
        input: {
          threadId,
          hostId: session.hostId,
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          leaseId: session.leaseId,
          shutdown: true,
        },
      });
      if (result._tag === "Failure") {
        Dialog.alert("Could not shut down device", String(Cause.squash(result.cause)));
      } else {
        panelSessionRef.current = null;
        setPanelSession(null);
      }
    } finally {
      setShuttingDown(false);
    }
  };

  const controls: AppBarMenuItem[] = [
    ...(!observer
      ? (state.data?.hosts
          .filter(
            (host) =>
              state.data?.supportsHostRetry &&
              state.data.hostStatuses[host.id]?.status === "failed",
          )
          .map((host) => ({
            id: `retry-${host.id}`,
            title: `Retry ${host.label}`,
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { retryHostId: host.id } });
            },
          })) ?? [])
      : []),
    ...(state.data?.supportsToolInspection
      ? [
          {
            id: "check-device-tools",
            title: "Check device tool versions",
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { inspectOnly: true } });
            },
          },
        ]
      : []),
    {
      id: "device-tools",
      title: "Device tool versions",
      icon: "info.circle",
      onPress: () =>
        Dialog.alert(
          "Device tool versions",
          deviceToolUpdateOwnership +
            "\n\n" +
            deviceToolUpdatePolicy(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
            ) +
            "\n\n" +
            deviceToolVersionLabels(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
            ).join("\n") +
            "\n" +
            (state.data?.hosts.find((host) => host.id === preview?.session.hostId)
              ?.toolInspectionError ??
              state.data?.hostStatuses[preview?.session.hostId ?? ""]?.detail ??
              ""),
        ),
    },
    {
      id: "reload",
      title: "Reload stream",
      icon: "arrow.clockwise" as const,
      disabled: !preview || shuttingDown,
      onPress: () => {
        setInputConnected(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(!observer && preview?.session.platform === "android"
      ? [
          {
            id: "back",
            title: "Back",
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    ...(!observer
      ? [
          {
            id: "app-switcher",
            title: "App switcher",
            icon: "square.on.square",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.appSwitcher(),
          },
        ]
      : []),
    ...(!observer && preview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: "Rotate device",
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    ...(!observer
      ? [
          {
            id: "shutdown",
            title: shuttingDown ? "Shutting down…" : "Shut down device",
            icon: "power",
            disabled: !preview || !panelSession || shuttingDown,
            onPress: () => void shutDownDevice(),
          },
        ]
      : []),
  ];
  const pressHome = () => streamRef.current?.home();
  const menuItems: AppBarMenuItem[] = [
    ...(previews.length > 1
      ? [
          {
            id: "devices",
            title: "Devices",
            inline: true,
            items: previews.map((device) => ({
              id: device.key,
              title: device.name,
              subtitle: device.description,
              selected: device.key === preview?.key,
              onPress: () => setSelectedKey(device.key),
            })),
          },
        ]
      : []),
    ...controls,
  ];
  return (
    <View className="flex-1" style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}>
      <StatusBar hidden animated />
      {preview && focused && foreground ? (
        <OpenDevicePreview
          key={`${preview.key}:${streamAttempt}`}
          environmentId={environmentId}
          preview={preview}
          streamRef={streamRef}
          onInputConnected={onInputConnected}
          observer={observer}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <Pressable
                accessibilityRole="button"
                className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
                onPress={state.refresh}
              >
                <AppText className="text-secondary-foreground">Retry</AppText>
              </Pressable>
            </>
          ) : focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
      {controlsVisible ? (
        <Animated.View
          entering={OVERLAY_ENTERING}
          exiting={OVERLAY_EXITING}
          pointerEvents="box-none"
          className="absolute inset-0"
        >
          {inputConnected ? (
            <Pressable
              accessibilityLabel="Hide device controls"
              className="absolute inset-0 bg-black/30"
              onPress={() => setControlsVisible(false)}
            />
          ) : null}
          <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
            <GlassSurface className="flex-row items-center gap-1 p-1">
              <ControlPill
                accessibilityLabel="Close device preview"
                icon="xmark"
                onPress={onClose}
              />
              <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base">
                {preview?.name ?? "Devices"}
              </AppText>
              <ControlPill
                accessibilityLabel="Home"
                icon="house"
                disabled={!inputConnected || observer}
                onPress={pressHome}
              />
              <DeviceOptionsMenu items={menuItems} />
            </GlassSurface>
          </View>
        </Animated.View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show device controls"
          accessibilityHint="Shaking the phone also shows them"
          hitSlop={12}
          className="absolute h-6 w-16 items-center justify-center self-center"
          style={{ top: Math.max(insets.top - 18, 4) }}
          onPress={() => setControlsVisible(true)}
        >
          <View className="h-1.5 w-10 rounded-full bg-white/40" />
        </Pressable>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<AppBarMenuItem> }) {
  return (
    <Menu
      actions={androidHeaderMenuActions(items)}
      isAnchoredToRight
      title="Device options"
      onPressAction={({ nativeEvent }) => {
        const action = findHeaderMenuAction(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <Pressable
        accessibilityLabel="Device options"
        accessibilityRole="button"
        className="size-11 items-center justify-center rounded-full bg-subtle"
      >
        <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" />
      </Pressable>
    </Menu>
  );
}

function OpenDevicePreview({
  environmentId,
  preview,
  streamRef,
  onInputConnected,
  observer,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: ThreadDevicePreview;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
  readonly observer: boolean;
}) {
  const { session } = preview;
  const { themeVariables } = useAppearancePreferences();
  const { access, error, refresh } = useDeviceHubAccess(environmentId, session.hostId);
  const onUnauthorized = useCallback(
    async () => refreshDeviceHubAccess(environmentId),
    [environmentId],
  );
  useEffect(() => {
    refreshDeviceHubAccess(environmentId);
    return () => void onInputConnected(false);
  }, [environmentId, onInputConnected]);
  return access ? (
    <View className="flex-1">
      <DeviceStreamWebView
        ref={streamRef}
        access={access}
        platform={session.platform}
        deviceId={session.deviceId}
        colors={{
          background: themeVariables["--color-sheet-solid"],
          foreground: themeVariables["--color-foreground"],
          muted: themeVariables["--color-foreground-muted"],
          buttonBackground: themeVariables["--color-secondary"],
          buttonForeground: themeVariables["--color-secondary-foreground"],
          buttonBorder: themeVariables["--color-secondary-border"],
        }}
        onUnauthorized={onUnauthorized}
        onInputConnected={onInputConnected}
      />
      {observer ? (
        <View
          accessibilityLabel="Watching the agent's device; touch input is disabled"
          accessibilityRole="text"
          className="absolute inset-0 items-center justify-end pb-10"
          pointerEvents="auto"
        >
          <AppText className="rounded-full bg-black/70 px-3 py-2 text-xs text-white">
            Watching the agent's device
          </AppText>
        </View>
      ) : null}
    </View>
  ) : (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <Pressable
            accessibilityRole="button"
            className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
            onPress={refresh}
          >
            <AppText className="text-secondary-foreground">Retry</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to device...</AppText>
        </>
      )}
    </View>
  );
}
