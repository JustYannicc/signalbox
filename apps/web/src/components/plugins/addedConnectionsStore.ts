/**
 * Connections added through the Add connection dialog during this session.
 * PLACEHOLDER: in-memory only, so the dialog can end on a real row in
 * Connections instead of a toast. Replace with Executor once it is wired in.
 */
import { create } from "zustand";

import { HARNESS_IDS, type GroupId, type Integration, type IntegrationKind } from "./pluginsModel";

export interface NewConnectionInput {
  readonly name: string;
  readonly glyph: string;
  readonly kind: IntegrationKind;
  readonly via: "executor" | "direct";
  /** The name models see; empty falls back to "New account". */
  readonly accountLabel: string;
  readonly groups: readonly GroupId[];
}

interface AddedConnectionsState {
  readonly integrations: readonly Integration[];
  readonly add: (input: NewConnectionInput) => Integration;
}

let addedCount = 0;

export const useAddedConnections = create<AddedConnectionsState>()((set) => ({
  integrations: [],
  add: (input) => {
    addedCount += 1;
    const id = `added-${addedCount}`;
    const integration: Integration = {
      id,
      name: input.name,
      glyph: input.glyph,
      kind: input.kind,
      via: input.via,
      ...(input.via === "direct" ? { transport: "stdio" as const, groups: input.groups } : {}),
      auth: "connected",
      accounts:
        input.via === "direct"
          ? []
          : [
              {
                id: `${id}-account`,
                label: input.accountLabel.trim() || "New account",
                identity: "Connected just now (preview)",
                auth: "connected",
                groups: input.groups,
                addedBy: "you",
              },
            ],
      toolCount: 0,
      tools: [],
      scopes: [],
      harnesses: HARNESS_IDS,
    };
    set((state) => ({ integrations: [...state.integrations, integration] }));
    return integration;
  },
}));
