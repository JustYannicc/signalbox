# Dogfood agent brief

You're one of several agents executing the dogfood map, #384 ("Map: develop Signalbox with Signalbox"). Your job ends when your issue's PR is **merge-ready**, not when it is open.

Read first, in order: #384's body (its standing rules apply here), your issue with its comments and the issues it links, `AGENTS.md`, and [shared rules](shared-rules.md).

## Standards

- **Architecture:** #225 (folder model), #284/#285 (spans and metrics with person, org, folder, thread and automation dimensions, never content), #345 (strict lint), #381 (state-machine and demo coverage).
- **Tools as documented:** Alchemy, Effect v4 and evlog the way their docs intend, with no workarounds. Invoke `effect-v4` for Effect code and `impeccable` for UI.
- **Infrastructure** goes through Alchemy (#298/#404).
- **Upstream fixes:** a fix that belongs upstream (T3 Code, Alchemy, our Executor service, evlog…) also goes upstream as a PR with a demo people can try. Signalbox carries the fix either way; never wait on upstream. List each upstream PR URL in your report; the coordinator gives it a babysitter thread.
- **Tests:** every behavior change ships with focused tests, test-first for bug fixes.

## Deliver

1. **Branch** from a freshly fetched `origin/main`.
2. **Open a ready-for-review PR** (not a draft) with a conventional-commit title. The body covers the problem, the approach and the verification, and ends with the harness attribution line. Commits end with the `Co-Authored-By` trailer of the model doing the work.
3. **Link it** with `link_pull_request`, and comment on your issue.
4. **Verify on the PR's cloud preview** yourself wherever the change is observable there. UI changes need before (prod) and after (preview) screenshots in the PR. Mobile changes are walked on both iOS and Android with the `test-t3-mobile` skill.
5. **Get it merge-ready:** CI green on the latest head, bot findings verified and fixed or answered, evidence posted, and a merged-tree check against current `main` done locally. Merge `main` into the PR only for a real conflict or a stale-branch failure.
6. **Hand it over:** message the coordinator "ready to merge #N at <sha>". The coordinator merges after its own live check, so leave the merge button alone. Take on no new scope until the PR is merged or explicitly handed off.

## Escalate

- **Product decisions** that neither your issue nor #384 answers: file an issue labeled `wayfinder:decision` that links both, with options and a recommendation, and report back. The owner decides.
- **Owner-only steps** (a secret, an account, a signature): prepare them down to one approval at most, and report exactly what the owner has to do.

## Report back

The PR link, what changed, the live evidence, upstream PR URLs, anything that needs the owner, what you stopped, and "Not checked:".
