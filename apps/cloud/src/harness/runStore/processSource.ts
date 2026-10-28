import * as Schema from "effect/Schema";
import { HarnessRunStoreError, fail } from "./errors.ts";
import { decodeState } from "./records.ts";
import { formatTable, requireOwnSchema, stateTable } from "./sqliteSchema.ts";
import { versions } from "./format.ts";
import type { HarnessRunDatabase } from "./types.ts";
import { capability, Supervisor } from "./values.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestFinish,
  HarnessRequestOffer,
  HarnessRequestPublisher,
} from "./requestSchemas.ts";

const SourceRead = Schema.Struct({ controlKey: capability, supervisor: Supervisor });
const decodeSourceRead = Schema.decodeUnknownSync(SourceRead, { onExcessProperty: "error" });

export type HarnessRunStoreProcessSourceInput = typeof SourceRead.Type;

export interface HarnessRunStoreProcessSource {
  readonly runId: string;
  readonly processOperationId: string;
  readonly supervisor: HarnessRunStoreProcessSourceInput["supervisor"];
  readonly currentPublisher: HarnessRequestPublisher;
  readonly request: HarnessRequestOffer;
  readonly finish: HarnessRequestFinish;
  readonly parentCheckpoint: HarnessRequestCheckpoint;
}

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;

/** Reads the persisted source only after authenticating both independent RunStore capabilities. */
export function readHarnessRunStoreProcessSource(
  database: HarnessRunDatabase,
  runId: string,
  supplied: unknown,
): HarnessRunStoreProcessSource {
  try {
    const input = decodeSourceRead(supplied);
    if (!runId) return fail("INVALID");
    return database.transactionSync(() => {
      requireOwnSchema(database, false);
      const row = first(
        database.sql.exec(`SELECT revision, state_json FROM ${stateTable} WHERE slot = 1`),
      );
      const format = first(database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`));
      if (!row || !format) return fail("CORRUPT");
      if (
        typeof row.revision !== "number" ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        row.revision >= Number.MAX_SAFE_INTEGER ||
        !versions.some((version) => version === format.version)
      )
        return fail("CORRUPT");
      const state = decodeState(row.state_json, runId);
      if (state.version !== format.version) return fail("CORRUPT");
      const supervisor = state.claims.at(-1);
      if (
        state.controlKey !== input.controlKey ||
        supervisor === undefined ||
        supervisor.supervisorKey !== input.supervisor.supervisorKey ||
        supervisor.epoch !== input.supervisor.epoch ||
        supervisor.claimId !== input.supervisor.claimId
      )
        return fail("STALE_SUPERVISOR");

      const requests = state.requests;
      const facet = requests?.facets.at(-1);
      const entry = requests?.entries.at(-1);
      if (
        requests === undefined ||
        facet === undefined ||
        entry === undefined ||
        entry.status !== "completed" ||
        entry.finish === null ||
        entry.finish.status !== "completed" ||
        entry.generation !== facet.generation ||
        entry.facetNonce !== facet.facetNonce
      )
        return fail("CONFLICT");

      return {
        runId,
        processOperationId: facet.operationId,
        supervisor: {
          supervisorKey: supervisor.supervisorKey,
          epoch: supervisor.epoch,
          claimId: supervisor.claimId,
        },
        currentPublisher: {
          generation: facet.generation,
          facetNonce: facet.facetNonce,
          publisherKey: facet.publisherKey,
        },
        request: entry.request,
        finish: entry.finish,
        parentCheckpoint: facet.checkpoint,
      };
    });
  } catch (error) {
    if (error instanceof HarnessRunStoreError) throw error;
    throw new HarnessRunStoreError("STORAGE", { cause: error });
  }
}
