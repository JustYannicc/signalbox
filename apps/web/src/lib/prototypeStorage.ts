/**
 * Prototype state persists in localStorage, so a reload keeps what you clicked.
 * Mock stores use these instead of touching localStorage directly: every key is
 * namespaced under `PROTOTYPE_PREFIX`, so bumping its version (or opening any
 * URL with `?reset-prototype`) drops all prototype state back to the fixtures.
 */
import { useCallback, useSyncExternalStore } from "react";
import { createJSONStorage } from "zustand/middleware";

import { resolveStorage, type StateStorage } from "./storage";

const PROTOTYPE_PREFIX = "signalbox:prototype:v1:";
const RESET_PARAM = "reset-prototype";

const backing = resolveStorage(typeof localStorage === "undefined" ? null : localStorage);

/** Quota or private-mode failures keep the in-memory value; nothing else depends on the write. */
function safely(write: () => void) {
  try {
    write();
  } catch {
    // ignore
  }
}

function resetFromUrl() {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RESET_PARAM)) return;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(PROTOTYPE_PREFIX)) safely(() => localStorage.removeItem(key));
  }
  url.searchParams.delete(RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}
resetFromUrl();

const prefixed: StateStorage = {
  getItem: (name) => backing.getItem(PROTOTYPE_PREFIX + name),
  setItem: (name, value) => safely(() => backing.setItem(PROTOTYPE_PREFIX + name, value)),
  removeItem: (name) => safely(() => backing.removeItem(PROTOTYPE_PREFIX + name)),
};

/** `storage` for a zustand `persist` prototype store. */
export function prototypeStorage<S>() {
  return createJSONStorage<S>(() => prefixed);
}

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function readStored(key: string): { found: boolean; value?: unknown } {
  const raw = prefixed.getItem(key);
  if (typeof raw !== "string") return { found: false };
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch {
    return { found: false };
  }
}

/**
 * Persisted `useLocalStorage` for prototype state: every reader of `key` shares
 * one value and re-renders when it changes. Setting `null` goes back to `initialValue`.
 */
export function usePrototypeState<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((val: T) => T)) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const keyListeners = listeners.get(key) ?? new Set();
      listeners.set(key, keyListeners);
      keyListeners.add(onChange);
      return () => {
        keyListeners.delete(onChange);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => {
    if (!values.has(key)) {
      const stored = readStored(key);
      if (!stored.found) return initialValue;
      values.set(key, stored.value);
    }
    return values.get(key) as T;
  }, [initialValue, key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback(
    (next: T | ((val: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (val: T) => T)(getSnapshot()) : next;
      if (resolved === null) {
        values.delete(key);
        prefixed.removeItem(key);
      } else {
        values.set(key, resolved);
        prefixed.setItem(key, JSON.stringify(resolved));
      }
      for (const onChange of listeners.get(key) ?? []) onChange();
    },
    [getSnapshot, key],
  );

  return [value, setValue];
}
