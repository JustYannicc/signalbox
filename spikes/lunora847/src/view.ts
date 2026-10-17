import { Effect, Stream } from "effect";
import { CatalogSync } from "./CatalogSync.js";
export const view = Effect.gen(function* () {
  const catalog = yield* CatalogSync;
  const status = document.querySelector<HTMLOutputElement>("#connection")!;
  const folders = document.querySelector<HTMLElement>("#folders")!;
  const threads = document.querySelector<HTMLElement>("#threads")!;
  const sidebar = Stream.runForEach(catalog.sidebar, (rows) =>
    Effect.sync(() => {
      folders.replaceChildren(
        ...rows.map((row) => {
          const item = document.createElement("li");
          item.textContent = row.title;
          if (row.key === "a") item.setAttribute("aria-current", "page");
          return item;
        }),
      );
    }),
  );
  const list = Stream.runForEach(catalog.threads("a"), (rows) =>
    Effect.sync(() => {
      threads.replaceChildren(
        ...rows.map((row) => {
          const item = document.createElement("li");
          const title = document.createElement("span");
          title.textContent = row.title;
          const detail = document.createElement("small");
          detail.textContent = `${row.status} · revision ${row.revision}`;
          const button = document.createElement("button");
          button.textContent = row.status === "running" ? "Stop" : "Run";
          button.onclick = () => {
            button.disabled = true;
            Effect.runPromise(catalog.update(row.key, row.revision + 1)).catch((cause) => {
              status.value = String(cause);
              button.disabled = false;
            });
          };
          item.appendChild(title);
          item.appendChild(detail);
          item.appendChild(button);
          return item;
        }),
      );
      if (!rows.length) threads.textContent = "No threads in this synthetic folder.";
    }),
  );
  yield* Effect.all(
    [
      sidebar,
      list,
      Stream.runForEach(catalog.connection, (value) =>
        Effect.sync(() => {
          status.value = value;
        }),
      ),
    ],
    { concurrency: 3 },
  );
}).pipe(
  Effect.catch((cause) =>
    Effect.sync(() => {
      document.querySelector<HTMLOutputElement>("#connection")!.value =
        `Sync failed: ${String(cause)}`;
    }),
  ),
);
