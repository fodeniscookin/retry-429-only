# Retry On Error

A minimal SillyTavern extension that automatically retries a chat/text
generation request when:

1. **`fetch()` throws a network error** (dropped connection, DNS failure, etc.)
2. **the server responds with any non-2xx HTTP status** (429, 500, 502, ...)
3. **the reply comes back under 40 words** — catches short/truncated/refusal-style
   replies

That's it. No dashboards, no logs, no keyword lists, no URL pattern config —
just enable/disable, max retries, and delay between retries.

## What it does

- Patches `window.fetch`, scoped only to chat/text-generation endpoints
  (`/api/backends/`, `/chat/completions`, `/v1/completions`, `/completions`).
  Everything else (settings saves, presets, background polls, etc.) passes
  through completely untouched.
- On failure, waits the configured delay and retries, up to your configured
  max retries. After that it gives up and hands the last response back to
  SillyTavern so its normal error handling still kicks in.
- Respects SillyTavern's "Stop" button — an aborted request is never retried.
- **Keeps real streaming live, and still catches errors.** For streaming
  requests the extension peeks at the *start* of the live stream only until it
  can decide: an error (SSE `error` event, `{"error": ...}` payload, or a JSON
  error body sent with HTTP 200, which is how 429/quota errors usually arrive)
  discards the stream and retries; the first real text token commits, and the
  rest of the stream is piped straight through token by token. You do **not**
  need to disable streaming for error detection.
- **Minimum length and streams.** The word-count check needs the whole reply,
  so it always applies to non-streaming replies, but for streams it is opt-in
  via "Hold streams to enforce minimum length" (off by default), because it
  requires buffering the full reply. An error that appears *after* text has
  already started streaming can't be retried (the text is already on screen)
  and is passed through.
- Doesn't guess: a tool/function-call response (no text content) or any JSON
  shape it doesn't recognize is left alone rather than being miscounted as
  "0 words" and retried for no reason.

## Install

1. Copy this folder into your SillyTavern install at:
   `SillyTavern/public/scripts/extensions/third-party/retry-429-only/`
   (the folder should directly contain `manifest.json` and `index.js`)
2. Restart SillyTavern (or reload the page).
3. Open the Extensions panel (the puzzle-piece icon) — you'll see a
   "Retry On Error" drawer with three settings:
   - **Enable retry on error** — turn the whole thing on/off
   - **Max retries** — how many times to retry before giving up (default 5)
   - **Time between retries (ms)** — flat delay before each retry (default 2000ms)

## Changelog

### v2.2.0 — error detection without giving up streaming

- Streams are no longer fully buffered to inspect them. The extension peeks at
  the beginning of the live stream, retries on in-body / SSE errors before
  anything is shown, then passes the rest through in real time.
- New setting: "Hold streams to enforce minimum length" (off by default) for
  anyone who wants the short-reply check on streams at the cost of live display.
- Peek is bounded (15s) so a slow first token never hangs the request.

### v2.0.1 — streaming & false-positive fixes

- **Fixed real streaming being fully buffered.** v2.0.0 read the *entire*
  response body before returning it, on every request, so a real SSE stream
  would freeze for its whole duration and then dump all at once instead of
  arriving token-by-token. Genuine live streams are now detected up front and
  never buffered at all.
- **Fixed false-positive retries** on tool/function-call responses and on any
  JSON shape the extension doesn't recognize — these no longer get treated as
  "0 words" and retried; only a response we can positively identify as short
  text triggers the word-count retry.

### v2.0.0 — minimal rewrite

- Replaced the earlier, more complex version (dashboards, logs, keyword
  matching, URL pattern config, backoff/jitter) with this minimal version:
  just enable/disable, max retries, and delay between retries.
- Retry conditions simplified to: any network error, any non-2xx HTTP
  status, or a reply under 40 words.
