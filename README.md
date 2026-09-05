# 429 Retry Only

A minimal SillyTavern extension that retries a request **only** when the
server responds with HTTP 429 (rate limited). It does nothing for empty/short
responses, timeouts, or any other error — so it won't cause the
"double request in flight" problem that shared/free API proxies (which often
allow only one concurrent request per key) are sensitive to.

## What it does

- Patches `window.fetch` so any 429 response triggers an automatic retry
  with exponential backoff (+ optional jitter).
- If the server sends a `Retry-After` header, it's honored by default.
- Gives up and returns the 429 to the caller after your configured max
  retries, so SillyTavern's normal error handling still kicks in eventually.
- Everything else (200s, 500s, empty streams, etc.) passes straight through
  untouched — this extension does not try to detect or "fix" short responses.

## Install

1. Copy this folder into your SillyTavern install at:
   `SillyTavern/public/scripts/extensions/third-party/retry-429-only/`
   (the folder should directly contain `manifest.json` and `index.js`)
2. Restart SillyTavern (or reload the page).
3. Open the Extensions panel (the puzzle-piece icon) — you'll see a
   "429 Retry Only" section with settings:
   - **Max retries** — how many times to retry before giving up (default 5)
   - **Base delay (ms)** — starting backoff delay (default 1000ms)
   - **Max delay (ms)** — cap on backoff delay (default 30000ms)
   - **Honor Retry-After** — use the server's suggested wait time if provided
   - **Jitter** — randomizes delay slightly so retries don't all land at once

## Why this instead of "retry on empty/short response"

Retrying because a response was empty/short means firing a *new* request
while the old one might not have fully closed server-side — on a
concurrency-limited backend (like a shared free-tier proxy), that reads as
two simultaneous requests and gets rejected. Retrying only on 429 avoids
that: you already know the server rejected the request outright, so there's
nothing still "in flight" to collide with.

If short responses are a real issue separately, that's better solved via
`max_tokens` / response length settings on the model side, not an
auto-retry.


## v1.2.0 — bug fixes

- **Fixed streaming breakage.** v1.1.3's body-keyword scan awaited
  `response.clone().text()` on any response whose content-type wasn't exactly
  `text/event-stream` — which buffered the ENTIRE generation before SillyTavern
  ever saw the response, turning streaming into a single whole-block dump.
  The scan now runs only on JSON bodies (complete by definition) and never
  buffers anything that might be a stream.
- **Fixed mystery "max retries" failures.** Two causes: (a) the patch applied
  retry logic + failure toasts to EVERY fetch SillyTavern makes, so random
  background 500s surfaced as retry-exhausted toasts; retry logic is now
  scoped to chat-generation URLs only (configurable). (b) `Request` objects
  had their body consumed by the first attempt, so every retry sent an empty
  body and got rejected — retries now replay from a pristine clone.
- **Fixed "0 successes" in the dashboard.** Only success-after-retry was ever
  logged; first-try successes are now logged too (toggleable).


## v1.2.1 — settings panel visibility fix

- **Fixed the settings drawer sometimes never appearing at all** (no gear
  icon, no entry in the Extensions flyout). The previous code injected the
  settings UI exactly once, synchronously, at startup, with no check that
  SillyTavern's extensions panel container already existed in the DOM and no
  retry if it didn't — on some devices/load orders the container isn't built
  yet at that point, so the injection silently landed on an empty selector
  and nothing ever showed up. Injection is now retried on a timer and backed
  by a MutationObserver, matching the retry pattern already used elsewhere in
  this extension for its dashboard button.


## v1.2.2 — load fix

- Fixed a missing comma in the default settings object that caused a JavaScript
  syntax error and prevented SillyTavern from loading the extension at all.
- Bumped the manifest version to make the repaired release easy to identify when
  troubleshooting cached extension files.
