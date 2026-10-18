import type { LunoraClient } from "lunorash/client";

import { api } from "../lunora/_generated/api.js";
import { internal } from "../lunora/_generated/internal.js";

declare const client: LunoraClient;

const absent = client.query(api.functions.view_absent, { input: { defined: false } });
const absentResult: Promise<{
  readonly _tag: "Value";
  readonly value: { readonly defined: false };
  readonly cursor: string;
}> = absent;
void absentResult;

const date = client.query(api.functions.view_date, {
  input: { defined: true, value: "2025-01-02T03:04:05.000Z" },
});
const dateResult: Promise<{
  readonly _tag: "Value";
  readonly value: { readonly defined: true; readonly value: string };
  readonly cursor: string;
}> = date;
void dateResult;

const nullable = client.query(api.functions.view_nullable, { input: { defined: false } });
const nullableResult: Promise<
  | {
      readonly _tag: "Value";
      readonly value: { readonly defined: true; readonly value: null };
      readonly cursor: string;
    }
  | {
      readonly _tag: "Failure";
      readonly failure: { readonly defined: true; readonly value: "missing" };
    }
> = nullable;
void nullableResult;

const changedDate = client.mutation(api.functions.change_date, {
  input: { defined: true, value: "2025-01-02T03:04:05.000Z" },
  operationKey: "date-1",
});
const changeResult: Promise<
  | {
      readonly _tag: "Committed";
      readonly value: { readonly defined: true; readonly value: string };
      readonly receipt: string;
    }
  | { readonly _tag: "Pending"; readonly operationKey: string }
> = changedDate;
void changeResult;

const internalProjection = client.mutation(internal.functions.project_touch, {
  input: { defined: false },
  operationKey: "touch-1",
});
void internalProjection;

// @ts-expect-error Void inputs have only the absent WireValue branch.
client.query(api.functions.view_absent, { input: { defined: true, value: null } });
// @ts-expect-error The authenticated actor is injected by bind(ctx), never public request data.
client.query(api.functions.view_absent, { input: { defined: false }, actor: { userId: "alice" } });
// @ts-expect-error Date inputs cross the wire as their encoded string.
client.query(api.functions.view_date, { input: { defined: true, value: 42 } });
// @ts-expect-error Committed writes require an operation key.
client.mutation(api.functions.change_date, { input: { defined: true, value: "now" } });
// @ts-expect-error Projections are generated only under the internal API.
client.mutation(api.functions.project_touch, {
  input: { defined: false },
  operationKey: "touch-2",
});
