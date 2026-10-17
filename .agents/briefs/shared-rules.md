# Shared rules for coordinator-launched agents

Every brief in this folder and the `daily-use-sweep` skill rely on these rules. `AGENTS.md` applies on top of them.

## Browser and sign-in

- **Own tab.** Open prod or a preview with `preview_open` and `reuseExistingTab=false`, and pass its `tabId` on every call.
- **Sign-in.** The default browser profile already holds the owner's session. Use "Continue with GitHub", or "Continue with email" when the shared WorkOS session signs you straight in. When a code screen appears instead, stop and tell the coordinator: codes for one account invalidate each other across agents, and AuthKit rate-limits requests.
- **Typed text.** `preview_type` has landed text in the wrong place, even with an explicit `tabId`. Enter text by focusing the field and calling `document.execCommand('insertText', …)` through `preview_evaluate` on your own tab, read the field back, and press Enter only when the read-back matches.
- **New preview hostnames.** Open a preview only after "Deploy preview cloud" succeeded and `dig +short <host> @1.1.1.1` returns an address. An earlier lookup gets the miss cached locally for several minutes; if that happened, wait it out rather than changing system DNS.

## Test turns

In any test thread on prod or a preview, set the model to **Claude Opus 5.5** or **GPT-6.1 Sol** before sending. Fable and Astra are too expensive for testing.

## Machine budget

Many agents share one host, and it overloads when about 20 of them install and test at once.

- **Reuse the worktree's install.** Install again only when the lockfile or a `package.json` changed: once, with `--filter` for the packages you touch, at background priority (`taskpolicy -b nice -n 19 vp i`).
- **One heavy thing at a time.** One dev server, one test run, one typecheck; a typecheck and a test run never overlap. Run vitest with `--maxWorkers=2` and prefix heavy commands with `taskpolicy -b nice -n 19`.
- **Load gate.** Check `uptime` before a larger local suite. Above a 1-minute load of about 20, push and let CI run it.
- **Idle while waiting.** Close local processes while you wait on CI or a deploy.

## Pushing and waiting

- **CI queue.** Each push cancels the PR's running CI and queues a new run, and the queue is the bottleneck. Push to fix a real failure or a real conflict, batching fixes into one push. Branch protection requires only `Check`, not an up-to-date branch, so verify against a moved `main` by merging it in a scratch worktree locally, without pushing.
- **Waiting.** When `watch_pull_request` is available, call it and end your turn; it wakes you. Otherwise stay in the turn and poll (`gh pr checks --watch`, or a backgrounded loop you wait on), and report only once the step finished or failed.

## Clean up before you report

- **Track what you start:** the PID of every dev server, Metro, watcher, language server, typecheck, headless browser, `xcodebuild` and agent-device runner.
- **Stop it by that PID,** or by a port owner that `lsof -nP -iTCP:<port> -sTCP:LISTEN` and its cwd confirm is in your worktree (`AGENTS.md` rule 1).
- **Simulators:** reuse an already-booted one when free (`xcrun simctl list devices booted`); shut down any you booted and delete any you created.
- **Close your browser tabs,** and remove scratch worktrees once their work is merged or pushed.
- **Say what you stopped** in your report.

## Challenge before you report

- **Challenge your own result:** walk the "Hit every surface" list in `AGENTS.md` and ask what a skeptical maintainer would ask first. Check those, or name them as not checked.
- **End every report with "Not checked:"**, listing what you didn't verify and why. An empty list has to be earned.
- **When challenged, check before you answer.** Re-read the code, logs or data, then show what you missed and fix it, or show the evidence that it holds.
