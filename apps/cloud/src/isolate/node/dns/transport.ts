import { dnsError, invalid } from "./errors.ts";
import { decodeResponse, recordTypes, type RecordType } from "./records.ts";

export interface DnsHost {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly readHosts?: () => string;
}

export function createDnsTransport(host: DnsHost) {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    const tracked = promise.finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };
  return {
    query(hostname: string, type: RecordType, signal: AbortSignal, timeout: number) {
      return track(
        (async () => {
          const timed = new AbortController();
          // @effect-diagnostics-next-line globalTimers:off - Node DNS promises need an abortable transport deadline outside an Effect runtime.
          const timer = timeout < 0 ? undefined : setTimeout(() => timed.abort(), timeout);
          const combined = AbortSignal.any([
            signal,
            timed.signal,
            ...(host.signal ? [host.signal] : []),
          ]);
          const syscall = `query${type}`;
          try {
            if (combined.aborted) throw dnsError("ECANCELLED", syscall, hostname);
            const url = new URL("https://cloudflare-dns.com/dns-query");
            url.searchParams.set("name", hostname);
            url.searchParams.set("type", String(recordTypes[type]));
            const response = await host.fetch(url, {
              headers: { accept: "application/dns-json" },
              signal: combined,
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw dnsError("ESERVFAIL", syscall, hostname);
            }
            let result;
            try {
              result = decodeResponse(await response.json());
            } catch {
              throw dnsError("EBADRESP", syscall, hostname);
            }
            if (combined.aborted) throw dnsError("ECANCELLED", syscall, hostname);
            if (result.Status !== 0) {
              const codes: Record<number, string> = {
                1: "EFORMERR",
                2: "ESERVFAIL",
                3: "ENOTFOUND",
                4: "ENOTIMP",
                5: "EREFUSED",
              };
              throw dnsError(codes[result.Status] ?? "EBADRESP", syscall, hostname);
            }
            const answers = (result.Answer ?? []).filter(
              (answer) => type === "ANY" || answer.type === recordTypes[type],
            );
            if (answers.length === 0) throw dnsError("ENODATA", syscall, hostname);
            return answers;
          } catch (error) {
            if (signal.aborted || host.signal?.aborted)
              throw dnsError("ECANCELLED", syscall, hostname);
            if (timed.signal.aborted) throw dnsError("ETIMEOUT", syscall, hostname);
            if (error instanceof Error && "code" in error) throw error;
            throw dnsError("ESERVFAIL", syscall, hostname);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        })(),
      );
    },
    async drain() {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
}

export function resolverOptions(options: { timeout?: number; tries?: number } = {}) {
  const timeout = options.timeout ?? 5000;
  const tries = options.tries ?? 4;
  if (!Number.isInteger(timeout) || timeout < -1 || timeout > 2147483647)
    invalid("timeout", timeout);
  if (!Number.isInteger(tries) || tries < 1 || tries > 100) invalid("tries", tries);
  return { timeout, tries };
}
