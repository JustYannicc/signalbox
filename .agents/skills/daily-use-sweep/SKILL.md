---
name: daily-use-sweep
description: Use prod Signalbox for real daily work in the signalbox folder and report every blocker that would push the owner back to T3 Code or a terminal. Use for daily-use or dogfood sweeps. Reports only; never fixes.
---

# Daily-use blocker sweep

The owner wants to develop Signalbox in Signalbox every day. You **really use prod** (`https://app.signalbox.run` on web, plus the desktop app when a prod build is available) for one part of that daily work in the JustYannicc/signalbox folder, and you report every **blocker**: anything that would stop or slow that work. You fix nothing; the coordinator ranks every report and assigns fixes.

Read `AGENTS.md` (`git show origin/main:AGENTS.md`) and the [shared rules](../../briefs/shared-rules.md) first. Their browser, sign-in, test-model and clean-up rules apply here.

## Ground rules

- **Real account.** You act on the owner's real data. Name every thread you create `[sweep] …`. Leave their things in place, change settings only where your scenario needs it and revert those changes, and stay out of vault values.
- **Cloud only.** You share the coordinator's checkout: leave it untouched, and install, build or start nothing locally.
- **Time box:** about 60–90 minutes of real use. Note each friction the moment it happens, with a timestamp.

## What counts as a blocker

Anything that makes the owner reach for T3 Code or a terminal instead:

- **Broken:** something that doesn't work, a lying or stuck state, or a feature T3 Code has and Signalbox lacks (#786: a missing feature is a bug).
- **Slow:** feedback slower than about 100 ms (#742).
- **Confusing:** a label or flow that misleads, or a step that needs setup or a tutorial.
- **Hidden errors:** an error that shows only in the UI and never reaches logs (#778).

## Report

Your final message lists the blockers. Each one has:

- **Title:** one plain-language line.
- **Where:** the scenario step, plus the URL or thread link.
- **What happened** versus what should happen.
- **Evidence:** a screenshot path (`preview_snapshot` with `save=true`), a thread link, a trace id, or a console error.
- **Frequency:** every turn / several times a day / daily / weekly / rare.
- **Impact:** blocks (no way through) / slows (a workaround exists) / annoys.
- **Existing issue,** found with `gh issue list --search`.
- **Fix owner:** Opus (UI or feel) or Sol (logic or backend).

Then **"Works well:"** (short) and **"Not checked:"** with what you couldn't test and why.

## Clean up

Close your tabs, archive your `[sweep]` threads except ones that produced a real PR, and stop any cloud machine your threads started that doesn't idle out by itself. Say what you cleaned up.
