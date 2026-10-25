"use client";

import {
  AuthPreviewOperateScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { ThreadBrowsingWebView } from "~/browsing/ThreadBrowsingWebView"; // signalbox: synced tabs (#585)
import { useEnvironmentSupportsThreadBrowsing } from "~/state/browsing"; // signalbox: synced tabs (#585)
import { useEnvironmentScope } from "~/state/session";
import { useOneEnvironmentCopy } from "~/state/oneEnvironmentCopy"; // signalbox: one-environment copy for preview access

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const available = usePreviewAvailable(threadRef.environmentId);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const synced = useEnvironmentSupportsThreadBrowsing(threadRef.environmentId); // signalbox
  const environmentCopy = useOneEnvironmentCopy(); // signalbox: one-environment copy for preview access
  if (canOperatePreview && !available && synced) {
    return (
      <PreviewPanelShell mode={mode}>
        <ThreadBrowsingWebView threadRef={threadRef} />
      </PreviewPanelShell>
    );
  }
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {
              canOperatePreview
                ? "Preview is only available in the Signalbox desktop app."
                : environmentCopy(
                    "Pair this client again with preview access to control browser previews.",
                  ) /* signalbox: one-environment copy for preview access */
            }
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
