# Upstream sync automations

Copies of the two automations that run the upstream sync (#5) in the prod Signalbox folder:

- `sync-upstream.ts` is "Sync upstream T3 Code": every 6 hours an agent merges T3 Code's `main` into a branch, opens a PR and sees it through CI.
- `merge-gate.ts` is "Merge gate": it merges a thread's PR once it is ready, and asks a person first when the change is hard to undo.

Prod is the source of truth. They run in the cloud's automation sandbox, which supplies `workflow` and the `w` API, so the repo's formatter, linter, typecheck and knip skip this folder (`vite.config.ts`, `scripts/tsconfig.json`, `knip.ts`), keeping each copy diffable against prod's source. When you change an automation, save the new version in prod first, then copy its source here.
