import type { LunoraClient } from "lunorash/client";
import { api } from "../lunora/_generated/api.js";

declare const client: LunoraClient;

const queryResult: Promise<number> = client.query(api.counters.value, { key: "primary" });
const mutationResult: Promise<number> = client.mutation(api.counters.increment, {
  key: "primary",
  amount: 1,
});

// @ts-expect-error The generated query args require a string key.
client.query(api.counters.value, { key: 1 });
// @ts-expect-error The generated mutation args require a string key and numeric amount.
client.mutation(api.counters.increment, { key: "primary" });
// @ts-expect-error The generated query result is a number.
const wrongQueryResult: Promise<string> = client.query(api.counters.value, { key: "primary" });
// @ts-expect-error The generated mutation result is a number.
const wrongMutationResult: Promise<string> = client.mutation(api.counters.increment, {
  key: "primary",
  amount: 1,
});

void [queryResult, mutationResult, wrongQueryResult, wrongMutationResult];
