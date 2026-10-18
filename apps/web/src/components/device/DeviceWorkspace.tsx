import type { DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@t3tools/client-runtime/device/screenshot";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView, type DeviceStreamHandle } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceControls } from "./useDeviceControls";

export function DeviceWorkspace(props: {
  environmentId: EnvironmentId;
  device: DeviceSummary;
  hostLabel: string;
  hostDiagnostics: string | undefined;
  visible: boolean;
  observer: boolean;
  onFloat: () => void;
  onClose: () => void;
  onPowerOff: () => void;
}) {
  const [handle, setHandle] = useState<DeviceStreamHandle | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const downloadRef = useRef<string | null>(null);
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  const controls = useDeviceControls({ ...props, access });
  const canControl = props.visible && !props.observer;
  const canControlRef = useRef(canControl);
  useLayoutEffect(() => {
    canControlRef.current = canControl;
  }, [canControl]);
  const guardedControls = {
    ...controls,
    disabled: !canControl || controls.disabled,
    act: (body: Parameters<typeof controls.act>[0]) =>
      canControlRef.current ? controls.act(body) : Promise.resolve(),
  };
  useEffect(() => {
    if (!access || !props.visible) captureRef.current?.abort();
    return () => {
      captureRef.current?.abort();
      if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
      downloadRef.current = null;
    };
  }, [access, props.visible]);
  const saveScreenshot = () => {
    if (!access || captureRef.current || !canControlRef.current) return;
    const controller = new AbortController();
    captureRef.current = controller;
    setScreenshotPending(true);
    setScreenshotError(null);
    return captureDeviceScreenshot(
      { access, platform: props.device.platform, deviceId: props.device.id },
      controller.signal,
    )
      .then((image) => {
        if (controller.signal.aborted) return;
        if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
        const url = URL.createObjectURL(image);
        downloadRef.current = url;
        const link = document.createElement("a");
        link.href = url;
        link.download = `${props.device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          if (cause instanceof DeviceScreenshotError && cause.status === 401)
            refreshDeviceHubAccess(props.environmentId);
          setScreenshotError(
            cause instanceof Error ? cause.message : "Screenshot capture failed. Try again.",
          );
        }
      })
      .finally(() => {
        if (captureRef.current === controller) {
          captureRef.current = null;
          setScreenshotPending(false);
        }
      });
  };
  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {props.observer ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Watching the agent's device. Input is disabled while the agent is using it.
          </p>
        ) : null}
        {screenshotError || (controls.error && !toolsOpen) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {screenshotError ?? controls.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceStreamView
            environmentId={props.environmentId}
            platform={props.device.platform}
            deviceName={props.device.name}
            deviceDescription={`${props.hostLabel} · ${props.device.version}`}
            deviceId={props.device.id}
            hostId={props.device.hostId}
            visible={props.visible}
            readOnly={props.observer}
            axOverlay={axOverlay}
            allowPhoneView={!props.observer}
            onHandle={setHandle}
            {...(!props.observer
              ? {
                  renderControls: (view) => (
                    <DeviceControlsRail
                      platform={props.device.platform}
                      handle={handle}
                      view={view}
                      controls={guardedControls}
                      screenshotPending={screenshotPending}
                      onScreenshot={() => void saveScreenshot()}
                      toolsOpen={toolsOpen}
                      onTools={() => {
                        if (canControlRef.current) setToolsOpen(!toolsOpen);
                      }}
                      onFloat={() => {
                        if (canControlRef.current) props.onFloat();
                      }}
                      onClose={() => {
                        if (canControlRef.current) props.onClose();
                      }}
                      onPowerOff={() => {
                        if (canControlRef.current) props.onPowerOff();
                      }}
                    />
                  ),
                }
              : {})}
          />
        </div>
      </div>
      {toolsOpen && canControl ? (
        <DeviceToolsPanel
          device={props.device}
          controls={guardedControls}
          hostDiagnostics={props.hostDiagnostics}
          access={access}
          axOverlay={axOverlay}
          onAxOverlayChange={(enabled) => {
            if (canControlRef.current) setAxOverlay(enabled);
          }}
          readOnly={!canControl}
          onClose={() => setToolsOpen(false)}
          className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none"
        />
      ) : null}
    </>
  );
}
