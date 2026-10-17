# Watch the agent's browser

In a Signalbox Cloud thread, agents browse in the cloud: real sites open in your own cloud browser, signed in as you, and the agent's dev servers open in a browser on the thread's machine. You can watch either one live and take over when the agent needs a hand.

## Watch

Open **Previews → Agent's browser** in the thread header. On mobile it's in the header's globe menu. The panel shows a live copy of the page the agent is on, and switches tabs with the agent. Pick a tab to keep watching that one instead.

The copy is rebuilt from the page itself rather than streamed as video, so it stays sharp and scrolls like the real site. Pages that draw on a canvas, like maps and games, update about once a second. Click a link in the copy to open it in a tab of your own, signed in as you; the agent's tab stays where it is.

Watching costs nothing. When the agent pauses for a minute, your cloud browser rests and the panel shows the last state. The panel also stops watching while it's hidden, while you're in another tab or app, and after five minutes with no activity from you. It picks up again when you come back.

## Take over

Click **Take over** to drive the page yourself, for example to fill in something only you know. The agent waits while you drive, and **Hand back** lets it continue from wherever you left the page. If you stop interacting for two minutes, or close the panel, the agent gets the tab back on its own.

Taking over works while the agent is working on the thread. After the turn ends, the thread's machine and your cloud browser close shortly after.

## Payments

Agents never pay for you. They fill in a checkout up to the point of paying, then hand the tab to you and wait: when they ask, when they're about to submit a page with card fields, or when they land on a bank's 3-D Secure check. Sign-ins, codes and CAPTCHAs never come to you this way.

You get a **Finish the payment** request on your phone and in the app. **Open the browser** shows the agent's tab: take over, pay, then answer **Done** or **Failed** right there. The agent reads nothing from the tab while it's yours, and carries on once you answer. When the cart lives in your account, you can also pay in your own browser and answer the same way.

The agent keeps its browser open only while it waits, for up to 30 minutes. To change what happens, for example to decline payments over a limit, customize the **Payment** automation.

## Steps

Every step the agent takes in the browser, and every stretch you drove, is kept with the thread. Card numbers and passwords are masked in it. Pick a step in the panel to see the page as it was when that step finished, even after the machine has stopped. Pages are rebuilt from what was recorded, so images and styles that a site has since changed may look different.

Steps stay in the browser panel. They're never added to the conversation, so the agent only sees what it looked at itself.

## Open a dev server

Choose a dev server from **Previews** to open it in your browser. If the thread's machine has stopped, opening the preview starts it and the dev server again. You do not need to send another message. Keep the tab open while you use it; after the last preview closes, the machine stops after its normal idle period.

You must be signed in as someone who can see the thread. A shared preview link asks for your own sign-in.
