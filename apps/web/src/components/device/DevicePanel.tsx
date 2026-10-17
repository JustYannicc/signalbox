import { DeviceHostUpdates } from "./DeviceHostUpdates";
import { deviceSessionRequiresReadOnlyPanel } from "@t3tools/contracts";
import type {
  DevicePlatform,
  DeviceSession,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceSetup, deviceHubReadiness } from "./DeviceSetup";
import { DeviceWorkspace } from "./DeviceWorkspace";
import { settleDeviceOpenForSurface } from "./deviceOpenSurfaceRequest";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { state, loaded } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const cancelOpen = useAtomCommand(deviceEnvironment.cancelOpen, { reportFailure: false });
  const close = useAtomCommand(deviceEnvironment.close);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDevice, setPendingDevice] = useState<DeviceSummary | null>(null);
  const [panelSession, setPanelSession] = useState<DeviceSession | null>(null);
  const panelSessionRef = useRef<DeviceSession | null>(null);
  const preserveLeaseForFloat = useRef(false);
  const targetLeaseConsumed = useRef(false);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const selectionGenerationRef = useRef(0);
  const [leaseWaiting, setLeaseWaiting] = useState(false);
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  // Opening setup never grants permission to install or start helpers.
  useEffect(() => {
    if (!props.visible || !loaded || hostDisabled) return;
    void list({ environmentId, input: {} });
  }, [environmentId, list, loaded, props.visible, hostDisabled]);

  const sessions = useMemo(
    () => state.sessions.filter((session) => session.threadId === threadId),
    [state.sessions, threadId],
  );
  const targetSession = props.surface.target
    ? sessions.filter(
        (session) =>
          session.deviceId === props.surface.target?.deviceId &&
          session.hostId === props.surface.target.hostId,
      )
    : [];
  const activeSession = panelSession
    ? targetSession.find(
        (session) =>
          session.ownerKind === "panel" &&
          session.sessionId === panelSession.sessionId &&
          session.leaseId === panelSession.leaseId,
      )
    : undefined;
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;

  useEffect(() => {
    const target = props.surface.target;
    if (!props.visible || !target) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | null = null;
    let owner = panelSessionRef.current;
    if (
      owner &&
      (owner.threadId !== threadId ||
        owner.hostId !== target.hostId ||
        owner.deviceId !== target.deviceId)
    )
      owner = null;
    const heartbeat = async () => {
      const controller = new AbortController();
      requestController = controller;
      const settlement = await settleDeviceOpenForSurface({
        signal: controller.signal,
        isCurrent: () => !cancelled,
        open: (signal, requestId) =>
          open(
            {
              environmentId,
              input: {
                threadId,
                hostId: target.hostId,
                deviceId: target.deviceId,
                platform: target.platform,
                requestId,
                ...(owner !== null
                  ? { sessionId: owner.sessionId, leaseId: owner.leaseId }
                  : !targetLeaseConsumed.current &&
                      target.sessionId !== undefined &&
                      target.leaseId !== undefined
                    ? { sessionId: target.sessionId, leaseId: target.leaseId }
                    : {}),
              },
            },
            signal,
          ),
        cancel: (requestId) =>
          cancelOpen({
            environmentId,
            input: {
              threadId,
              hostId: target.hostId,
              deviceId: target.deviceId,
              requestId,
            },
          }),
        release: (session) =>
          close({
            environmentId,
            input: {
              threadId,
              hostId: session.hostId,
              deviceId: session.deviceId,
              sessionId: session.sessionId,
              leaseId: session.leaseId,
            },
          }),
        accept: () => undefined,
      });
      if (requestController === controller) requestController = null;
      if (settlement._tag === "Cancelled") return;
      const result = settlement.result;
      if (result._tag === "Success") {
        owner = result.value;
        panelSessionRef.current = owner;
        targetLeaseConsumed.current = true;
        setPanelSession(owner);
        setLeaseWaiting(false);
        setOperationError(null);
      } else {
        const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
        const staleSession =
          typeof failure === "object" &&
          failure !== null &&
          "_tag" in failure &&
          failure._tag === "DeviceOperationError" &&
          "reason" in failure &&
          failure.reason === "stale_session";
        if (owner !== null && staleSession) {
          owner = null;
          panelSessionRef.current = null;
          setPanelSession(null);
          setLeaseWaiting(true);
          timer = setTimeout(() => void heartbeat(), 0);
          return;
        }
        if (owner === null) {
          if (!targetLeaseConsumed.current && target.sessionId !== undefined) {
            targetLeaseConsumed.current = true;
            setLeaseWaiting(true);
            timer = setTimeout(() => void heartbeat(), 0);
            return;
          }
          setLeaseWaiting(false);
          setOperationError(formatEnvironmentQueryError(result.cause));
        }
      }
      timer = setTimeout(() => void heartbeat(), 60_000);
    };
    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      requestController?.abort();
      requestController = null;
      const released = owner;
      if (preserveLeaseForFloat.current) {
        preserveLeaseForFloat.current = false;
        targetLeaseConsumed.current = true;
      } else if (released !== null) {
        void close({
          environmentId,
          input: {
            threadId,
            hostId: released.hostId,
            deviceId: released.deviceId,
            sessionId: released.sessionId,
            leaseId: released.leaseId,
          },
        });
        panelSessionRef.current = null;
        setPanelSession(null);
        targetLeaseConsumed.current = true;
      } else {
        targetLeaseConsumed.current = true;
        setPanelSession(null);
      }
    };
  }, [cancelOpen, close, environmentId, open, props.surface.target, props.visible, threadId]);

  useEffect(() => {
    selectionGenerationRef.current++;
    selectionControllerRef.current?.abort();
    selectionControllerRef.current = null;
    setPendingDevice(null);
  }, [props.visible, props.surface.id]);
  useEffect(
    () => () => {
      selectionGenerationRef.current++;
      selectionControllerRef.current?.abort();
      selectionControllerRef.current = null;
    },
    [props.surface.id],
  );

  const grouped = useMemo(() => groupDevices(state), [state]);

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    selectionControllerRef.current?.abort();
    const controller = new AbortController();
    selectionControllerRef.current = controller;
    const generation = ++selectionGenerationRef.current;
    setOperationError(null);
    setPendingDevice(device);
    try {
      await settleDeviceOpenForSurface({
        signal: controller.signal,
        isCurrent: () => generation === selectionGenerationRef.current,
        open: (signal, requestId) =>
          open(
            {
              environmentId,
              input: {
                threadId,
                hostId: device.hostId,
                deviceId: device.id,
                platform: device.platform,
                requestId,
              },
            },
            signal,
          ),
        cancel: (requestId) =>
          cancelOpen({
            environmentId,
            input: {
              threadId,
              hostId: device.hostId,
              deviceId: device.id,
              requestId,
            },
          }),
        release: (session) =>
          close({
            environmentId,
            input: {
              threadId,
              hostId: session.hostId,
              deviceId: session.deviceId,
              sessionId: session.sessionId,
              leaseId: session.leaseId,
            },
          }),
        accept: (result) => {
          if (result._tag === "Failure") {
            setOperationError(formatEnvironmentQueryError(result.cause));
            return;
          }
          panelSessionRef.current = result.value;
          setPanelSession(result.value);
          useRightPanelStore.getState().openDevice(props.threadRef, {
            hostId: result.value.hostId,
            deviceId: result.value.deviceId,
            platform: device.platform,
            name: device.name,
            sessionId: result.value.sessionId,
            leaseId: result.value.leaseId,
          });
        },
      });
    } finally {
      if (generation === selectionGenerationRef.current) {
        selectionControllerRef.current = null;
        setPendingDevice(null);
      }
    }
  };

  const floatActive = () => {
    if (!activeDevice) return;
    const session = panelSessionRef.current;
    preserveLeaseForFloat.current = true;
    usePreviewMiniPlayerStore.getState().open(props.threadRef, {
      kind: "device",
      hostId: activeDevice.hostId,
      deviceId: activeDevice.id,
      platform: activeDevice.platform,
      name: activeDevice.name,
      ...(session === null ? {} : { sessionId: session.sessionId, leaseId: session.leaseId }),
    });
    useRightPanelStore.getState().close(props.threadRef);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
      return;
    }
    const session =
      panelSessionRef.current ?? (activeSession?.ownerKind === "panel" ? activeSession : undefined);
    if (!session) return;
    setOperationError(null);
    void close({
      environmentId,
      input: {
        threadId,
        hostId: session.hostId,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        leaseId: session.leaseId,
        shutdown: powerOff,
      },
    }).then((result) => {
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else {
        panelSessionRef.current = null;
        setPanelSession(null);
        useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
      }
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const waitingForDevice =
    pendingDevice !== null &&
    (state.queuedDevices ?? []).some(
      (device) =>
        device.hostId === pendingDevice.hostId &&
        device.id === pendingDevice.id &&
        device.threadId === threadId,
    );
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  if (loaded && (!state.onboardingCompleted || hostDisabled)) {
    return (
      <Dialog
        open={props.visible}
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onDismissSetup();
        }}
      >
        <WizardPopup>
          <DeviceSetup environmentId={environmentId} state={state} />
        </WizardPopup>
      </Dialog>
    );
  }

  return (
    <PreviewPanelShell mode={props.mode}>
      {hostReady && !activeDevice && state.hostStatusDetail ? (
        <div
          role="status"
          className="whitespace-pre-line border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {state.hostStatusDetail}
        </div>
      ) : null}
      <DeviceHostUpdates state={state} environmentId={environmentId} />
      {bootingDevices.length > 0 ? (
        <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a minute.
        </div>
      ) : null}
      {operationError ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{operationError}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss device error"
            onClick={() => setOperationError(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      {leaseWaiting ? (
        <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Waiting to reacquire this device…
        </div>
      ) : null}
      <div className="@container relative flex min-h-0 flex-1">
        {activeDevice && activeSession ? (
          <DeviceWorkspace
            key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
            environmentId={environmentId}
            device={activeDevice}
            hostLabel={
              state.hosts.find((host) => host.id === activeDevice.hostId)?.label ?? "Device host"
            }
            hostDiagnostics={state.hostStatusDetail}
            visible={props.visible}
            observer={deviceSessionRequiresReadOnlyPanel(activeSession)}
            onFloat={floatActive}
            onClose={() => closeActive(false)}
            onPowerOff={() => closeActive(true)}
          />
        ) : pendingDevice || hostBusy || !loaded ? (
          <DeviceLoadingView
            name={pendingDevice?.name ?? "Devices"}
            description={
              pendingDevice
                ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                : ""
            }
            stage="opening"
            message={
              waitingForDevice
                ? `Waiting for ${pendingDevice?.name ?? "device"} to become available…`
                : pendingDevice
                  ? pendingDevice.booted
                    ? "Opening device…"
                    : "Starting device…"
                  : state.hostStatus === "installing"
                    ? (state.hostStatusDetail ?? "Installing device support…")
                    : "Finding devices…"
            }
          />
        ) : (
          <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
            <div
              className={cn(
                "mx-auto flex w-full max-w-xl flex-col gap-6",
                grouped.length === 0 && "my-auto items-center text-center",
              )}
            >
              {grouped.length === 0 ? (
                <>
                  <Smartphone className="size-6 opacity-60" />
                  <p className="max-w-sm">
                    {state.hostStatus === "failed"
                      ? (state.hostStatusDetail ?? "The device hub failed to start.")
                      : "No simulators or emulators were found on this environment."}
                  </p>
                </>
              ) : null}
              {hostReady && grouped.length > 0 ? (
                <div className="w-full space-y-6 text-left">
                  {grouped.map((group) => (
                    <section key={group.platform} className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Smartphone className="size-4 shrink-0" />
                        <h3 className="font-medium">{platformLabel(group.platform)}</h3>
                      </div>
                      <DiscoveryList>
                        {group.devices.map((device) => (
                          <DiscoveryListRow
                            key={deviceKey(device)}
                            icon={
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                            }
                            title={device.name}
                            description={`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
                            disabled={pendingDeviceKey !== null}
                            aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
                            onClick={() => void selectDevice(deviceKey(device))}
                            action={
                              pendingDeviceKey === deviceKey(device) ? (
                                <Spinner size="xs" />
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {device.booted ? "Open" : "Start"}
                                </span>
                              )
                            }
                          />
                        ))}
                      </DiscoveryList>
                    </section>
                  ))}
                </div>
              ) : null}
              {hostReady &&
              !state.devices.some((device) => device.platform === "android") &&
              !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                <p className="max-w-sm text-xs">
                  No Android virtual devices found. Create one in Android Studio's Device Manager,
                  then refresh.
                </p>
              ) : null}
              {loaded && !hostBusy ? (
                <Button
                  className={grouped.length > 0 ? "self-start" : "self-center"}
                  variant={grouped.length > 0 ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => void list({ environmentId, input: {} })}
                >
                  Refresh devices
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </PreviewPanelShell>
  );
}

function groupDevices(state: DeviceServiceState) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices
      .filter((device) => device.platform === platform)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}
