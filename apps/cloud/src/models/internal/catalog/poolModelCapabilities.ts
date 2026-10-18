import type { ModelCapabilities, ProviderOptionDescriptor } from "@t3tools/contracts";

import type { ServedModel } from "../../../pool/cliProxyApi.ts";
import type { CloudPoolKind } from "./routing.ts";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export const poolModelCapabilities = (
  kind: CloudPoolKind,
  model: ServedModel,
  fallback: ModelCapabilities | undefined,
): ModelCapabilities | null => {
  const descriptors: ProviderOptionDescriptor[] = [];
  const efforts = [...new Set(model.reasoningEfforts ?? [])];
  const defaultEffort = efforts.includes("medium") ? "medium" : efforts[0];
  if (defaultEffort !== undefined) {
    descriptors.push({
      id: kind === "codex" ? "reasoningEffort" : "effort",
      label: "Reasoning",
      type: "select",
      options: efforts.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort] ?? effort,
        ...(effort === defaultEffort ? { isDefault: true } : {}),
      })),
      currentValue: defaultEffort,
    });
  }
  // CLIProxyAPI reports thinking levels, but not Claude Code's fast-mode support.
  for (const descriptor of fallback?.optionDescriptors ?? []) {
    if (descriptor.id === "fastMode") descriptors.push(descriptor);
  }
  return descriptors.length > 0 ? { optionDescriptors: descriptors } : null;
};
