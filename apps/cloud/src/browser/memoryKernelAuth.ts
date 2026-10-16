import * as Effect from "effect/Effect";

import { KernelApiError } from "./KernelApi.ts";
import type {
  AuthChoice,
  AuthConnection,
  AuthConnectionRequest,
  AuthField,
  AuthSubmission,
  KernelAuth,
} from "./KernelAuth.ts";

/**
 * For tests: Kernel's Managed Auth against scripted sites. A site is its
 * login screens in order: fields it expects values for, or routes to choose
 * from. A wrong value shows the same screen again with the field rejected.
 * The fake reads submitted values to check them, as the site would; nothing
 * of it is the login service's own storage, logs or answers.
 */

export type Screen =
  | { readonly fields: ReadonlyArray<AuthField>; readonly expect: Readonly<Record<string, string>> }
  | { readonly choices: ReadonlyArray<AuthChoice>; readonly expect: string };

interface Live {
  connection: AuthConnection;
  readonly request: AuthConnectionRequest;
  screen: number;
  interaction: number;
  /** Reads left before the next screen shows: Kernel discovers, then submits. */
  settling: number;
  rejected: ReadonlySet<string>;
}

export const memoryKernelAuth = (sites: Readonly<Record<string, ReadonlyArray<Screen>>>) => {
  const live = new Map<string, Live>();
  const submissions: Array<{ readonly id: string; readonly answer: AuthSubmission }> = [];
  const logins: Array<string> = [];
  let staleOnce = false;
  let next = 0;

  const show = (entry: Live): AuthConnection => {
    const screens = sites[entry.connection.domain] ?? [];
    const screen = screens[entry.screen];
    if (screen === undefined) {
      return {
        ...entry.connection,
        status: "AUTHENTICATED",
        flow_status: "SUCCESS",
        flow_step: "COMPLETED",
      };
    }
    const interaction_id = `i-${entry.interaction}`;
    return "fields" in screen
      ? {
          ...entry.connection,
          flow_status: "IN_PROGRESS",
          flow_step: "AWAITING_INPUT",
          interaction_id,
          choices: [],
          fields: screen.fields.map((field) => ({
            ...field,
            reason: entry.rejected.has(field.id) ? "rejected" : "missing",
          })),
        }
      : {
          ...entry.connection,
          flow_status: "IN_PROGRESS",
          flow_step: "AWAITING_INPUT",
          interaction_id,
          fields: [],
          choices: screen.choices,
        };
  };

  const refused = (status: number, code: string, message: string) =>
    new KernelApiError({ operation: "test", status, code, message });

  const api: KernelAuth = {
    ensureConnection: (request) =>
      Effect.sync(() => {
        const found = [...live.values()].find(
          (entry) =>
            entry.request.domain === request.domain &&
            entry.request.profile_name === request.profile_name,
        );
        if (found !== undefined) return found.connection;
        const id = `conn-${++next}`;
        const connection: AuthConnection = {
          id,
          domain: request.domain,
          status: "NEEDS_AUTH",
          save_credentials: request.save_credentials,
        };
        live.set(id, {
          connection,
          request,
          screen: 0,
          interaction: 0,
          settling: 0,
          rejected: new Set(),
        });
        return connection;
      }),
    getConnection: (id) =>
      Effect.sync(() => {
        const entry = live.get(id);
        if (entry === undefined) return null;
        if (entry.connection.flow_status !== "IN_PROGRESS") return entry.connection;
        if (entry.settling > 0) {
          entry.settling -= 1;
          return { ...entry.connection, flow_step: "SUBMITTING", interaction_id: null };
        }
        const shown = show(entry);
        if (shown.flow_status === "SUCCESS") entry.connection = shown;
        return shown;
      }),
    stopSavingCredentials: (id) =>
      Effect.sync(() => {
        const entry = live.get(id);
        if (entry !== undefined)
          entry.connection = { ...entry.connection, save_credentials: false };
      }),
    login: (id) =>
      Effect.sync(() => {
        const entry = live.get(id);
        // A login running already is followed, as Kernel's 409 says, never restarted.
        if (entry === undefined || entry.connection.flow_status === "IN_PROGRESS") return;
        logins.push(id);
        entry.screen = 0;
        entry.interaction += 1;
        entry.settling = 1;
        entry.rejected = new Set();
        entry.connection = {
          ...entry.connection,
          flow_status: "IN_PROGRESS",
          flow_step: "DISCOVERING",
        };
      }),
    submit: (id, answer) =>
      Effect.suspend(() => {
        const entry = live.get(id);
        if (entry === undefined)
          return Effect.fail(refused(404, "not_found", "No such connection."));
        if (answer.interaction_id !== `i-${entry.interaction}`) {
          return Effect.fail(refused(400, "stale_interaction", "That screen has moved on."));
        }
        if (staleOnce) {
          // The page re-rendered between the read and the submit: a new pause, same screen.
          staleOnce = false;
          entry.interaction += 1;
          return Effect.fail(refused(400, "stale_interaction", "That screen has moved on."));
        }
        submissions.push({ id, answer });
        const screen = (sites[entry.connection.domain] ?? [])[entry.screen];
        entry.interaction += 1;
        entry.settling = 1;
        if (screen === undefined) return Effect.void;
        const passed =
          "fields" in screen
            ? "field_values" in answer &&
              Object.entries(screen.expect).every(
                ([field, value]) => answer.field_values[field] === value,
              )
            : "selected_choice_id" in answer && answer.selected_choice_id === screen.expect;
        if (passed) {
          entry.screen += 1;
          entry.rejected = new Set();
        } else if ("fields" in screen && "field_values" in answer) {
          entry.rejected = new Set(
            Object.keys(screen.expect).filter(
              (field) => answer.field_values[field] !== screen.expect[field],
            ),
          );
        } else {
          // A route the site doesn't take ends the flow.
          entry.connection = {
            ...entry.connection,
            flow_status: "FAILED",
            error_code: "unsupported_auth_method",
            error_message: "The site doesn't support that route.",
          };
        }
        return Effect.void;
      }),
  };

  return {
    api,
    submissions,
    logins,
    connections: () => [...live.values()].map((entry) => entry.connection),
    /** The site's session ran out, and Kernel's health check saw it. */
    expire: (id: string) => {
      const entry = live.get(id);
      if (entry !== undefined) {
        entry.connection = {
          ...entry.connection,
          status: "NEEDS_AUTH",
          flow_status: null,
          flow_step: null,
        };
      }
    },
    /** The next submit lands on a pause that already moved on. */
    staleNextSubmit: () => {
      staleOnce = true;
    },
  };
};
