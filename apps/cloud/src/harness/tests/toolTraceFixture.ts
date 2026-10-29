import { createHarnessToolTraceLedger, type HarnessToolTraceOptions } from "../HarnessToolTrace.ts";

export const wrapperPrefix =
  "shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval ";
export const wrapperSuffix = " < /dev/null && pwd -P >| /tmp/cwd-result";

export function wrappedCommand(command: string) {
  return `${wrapperPrefix}'${command.replaceAll("'", "'\\''")}'${wrapperSuffix}`;
}

export function observedLedger(options: HarnessToolTraceOptions = {}) {
  const ledger = createHarnessToolTraceLedger(options);
  const processes = new Set<string>();
  return {
    ...ledger,
    observeHook(...args: Parameters<typeof ledger.observeHook>) {
      if (!processes.has(args[0])) {
        ledger.observeProcessCapture(args[0], "attached", true, { fixture: "installed" });
        processes.add(args[0]);
      }
      ledger.observeHook(...args);
    },
    finalize(...args: Parameters<typeof ledger.finalize>) {
      for (const processKey of processes)
        ledger.observeProcessCapture(processKey, "drained", true, { fixture: "joined" });
      return ledger.finalize(...args);
    },
  };
}
