/**
 * Connections added through the Add connection dialog. PLACEHOLDER: kept in
 * prototype storage, so the dialog can end on a real row in Connections
 * instead of a toast. Replace with Executor once it is wired in.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import type { LevelKey } from "../levels/levels";
import { HARNESS_IDS, type Integration, type IntegrationKind } from "./pluginsModel";

export interface NewConnectionInput {
  readonly name: string;
  readonly glyph: string;
  readonly kind: IntegrationKind;
  readonly via: "executor" | "direct";
  /** The name models see; empty falls back to "New account". */
  readonly accountLabel: string;
  readonly levels: readonly LevelKey[];
}

interface AddedConnectionsState {
  readonly integrations: readonly Integration[];
  readonly add: (input: NewConnectionInput) => Integration;
}

export const useAddedConnections = create<AddedConnectionsState>()(
  persist(
    (set, get) => ({
      integrations: [],
      add: (input) => {
        // Survives reloads, so the next id comes from what's stored, not a counter.
        const id = `added-${get().integrations.length + 1}`;
        const integration: Integration = {
          id,
          name: input.name,
          glyph: input.glyph,
          kind: input.kind,
          via: input.via,
          ...(input.via === "direct" ? { transport: "stdio" as const, levels: input.levels } : {}),
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
                    levels: input.levels,
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
    }),
    {
      name: "t3code:plugins:added-connections:v1",
      version: 1,
      storage: prototypeStorage(),
      partialize: (state) => ({ integrations: state.integrations }),
    },
  ),
);
