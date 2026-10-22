// Retry On Error — SillyTavern extension
//
// Retries a chat/completion request when:
//   1. fetch() throws a network error, OR
//   2. the response comes back with a non-2xx HTTP status, OR
//   3. the response is HTTP 200 but the body is actually an error payload
//      (SillyTavern's backend very often relays upstream 429 / provider errors
//      as a 200 with {"error": ...} in the body, or as an SSE "error" event —
//      this is the main reason a status-only check never fires), OR
//   4. the AI's reply text is under the configured minimum word count.
//
// Streaming: streams are NEVER fully buffered by default. The extension peeks
// at the start of the live stream only until it can reach a verdict:
//   - an error (SSE "error" event, {"error": ...} payload, non-SSE JSON error)
//     => discard the stream and retry;
//   - the first real text token => commit, replay the peeked chunks and pipe
//     the rest of the live body straight through, token by token.
// Short-reply checking needs the whole reply, so for streams it is a separate
// opt-in ("Hold streams to check min length"); it is off by default.
//
// If the caller passed an AbortSignal (SillyTavern's "Stop" button does this),
// an abort is never retried — it's immediately propagated so Stop still stops.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_on_error';
const EXT_VERSION = '2.4.0';

const defaultSettings = {
    enabled: true,
    maxRetries: 5,
    delayMs: 2000,
    minWords: 40,
    inspectStreams: true,
    holdStreamsForMinWords: false,
    customErrors: '',
    errorEntries: [],
    scanChars: 300,
    peekMaxMs: 15000,
    debug: false,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    const st = extension_settings[MODULE_NAME];
    // Migrate the v2.3 single textarea (one phrase per line) into separate entries.
    if (st.customErrors && String(st.customErrors).trim()) {
        for (const lineRaw of String(st.customErrors).split(/\r?\n/)) {
            const line = lineRaw.trim();
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/^\/(.+)\/([gimsuy]*)$/);
            st.errorEntries.push(m
                ? { text: m[1], mode: 'regex', flags: m[2].replace(/[gy]/g, '') || 'i', enabled: true }
                : { text: line, mode: 'text', flags: 'i', enabled: true });
        }
        st.customErrors = '';
    }
    if (!Array.isArray(st.errorEntries)) st.errorEntries = [];
    return st;
}

function log(...args) {
    console.log('[Retry On Error]', ...args);
}

function debugLog(...args) {
    if (getSettings().debug) console.log('[Retry On Error][debug]', ...args);
}

function toast(type, message) {
    try {
        if (typeof toastr !== 'undefined' && toastr[type]) {
            toastr[type](message, 'Retry On Error');
        }
    } catch {
        // ignore
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Only these requests get retry behavior. Everything else (settings saves,
// thumbnails, background polls, presets, etc.) passes through untouched.
const GENERATION_URL_PATTERNS = [
    '/api/backends/',
    '/api/novelai/generate',
    '/api/horde/generate',
    '/generate',
    '/chat/completions',
    '/v1/completions',
    '/completions',
    '/messages',
];

function isGenerationRequest(url) {
    const path = String(url || '').split('?')[0];
    return GENERATION_URL_PATTERNS.some((p) => path.includes(p));
}

function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
}

function extractUrl(input) {
    if (typeof input === 'string') return input;
    if (input && input.url) return input.url;
    try {
        return String(input);
    } catch {
        return '(unknown)';
    }
}

// Normalize (input, init) into something we can replay safely on every retry.
// Returns null when the request can't be replayed (streamed request body, or
// an already-consumed Request object) — those pass straight through.
async function makeReplayable(input, init) {
    const bodyInit = init && init.body;

    if (typeof Request !== 'undefined' && input instanceof Request) {
        if (input.bodyUsed) return null;
        let bodyText = null;
        if (input.method && input.method !== 'GET' && input.method !== 'HEAD') {
            try {
                bodyText = await input.clone().text();
            } catch {
                return null;
            }
        }
        const headers = {};
        input.headers.forEach((v, k) => {
            headers[k] = v;
        });
        return {
            url: input.url,
            bodyText,
            replay: () =>
                originalFetch(input.url, {
                    method: input.method,
                    headers,
                    body: bodyText,
                    credentials: input.credentials,
                    mode: input.mode,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    signal: (init && init.signal) || input.signal,
                }),
        };
    }

    if (bodyInit && typeof ReadableStream !== 'undefined' && bodyInit instanceof ReadableStream) {
        return null;
    }

    return {
        url: extractUrl(input),
        bodyText: typeof bodyInit === 'string' ? bodyInit : null,
        replay: () => originalFetch(input, init),
    };
}

function requestAsksForStream(bodyText) {
    if (typeof bodyText !== 'string') return false;
    return /"stream"\s*:\s*true/i.test(bodyText);
}


// ─── Custom error entries ───────────────────────────────────────────
// Each entry: { text, mode: 'text' | 'regex', flags, enabled }.
// 'text'  = case-insensitive "contains".
// 'regex' = a regular expression with the given flags.
function compileEntries(entries) {
    const out = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || e.enabled === false) continue;
        const text = String(e.text ?? '').trim();
        if (!text) continue;
        if (e.mode === 'regex') {
            try {
                const re = new RegExp(text, String(e.flags || 'i').replace(/[gy]/g, ''));
                out.push({ label: `/${text}/${e.flags || 'i'}`, test: (t) => re.test(t) });
                continue;
            } catch {
                // invalid regex: fall back to plain text below
            }
        }
        const needle = text.toLowerCase();
        out.push({ label: text, test: (t) => t.toLowerCase().includes(needle) });
    }
    return out;
}

// Make a raw JSON/SSE payload easier to match: also look at the decoded string
// values (so a phrase containing quotes, newlines or unicode escapes still matches).
function haystacksFor(...parts) {
    const out = [];
    for (const p of parts) {
        if (typeof p !== 'string' || !p) continue;
        out.push(p);
        if (p.includes('\\')) {
            try {
                out.push(JSON.parse('"' + p.replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'));
            } catch {
                // ignore
            }
        }
        // Collect every JSON string value found in SSE `data:` lines / a JSON body.
        const strings = [];
        const collect = (v) => {
            if (typeof v === 'string') strings.push(v);
            else if (Array.isArray(v)) v.forEach(collect);
            else if (v && typeof v === 'object') Object.values(v).forEach(collect);
        };
        for (const line of p.split(/\r?\n/)) {
            const m = line.match(/^data:\s*(.*)$/);
            const candidate = (m ? m[1] : line).trim();
            if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
            try { collect(JSON.parse(candidate)); } catch { /* ignore */ }
        }
        if (strings.length) out.push(strings.join('\n'));
        // Concatenate streamed text deltas so a phrase split across tokens still matches.
        const joined = strings.join('');
        if (joined && joined !== strings.join('\n')) out.push(joined);
    }
    return out;
}

// Returns the first matching entry label, or null. Checks every haystack.
function findCustomErrorMatch(entries, ...parts) {
    const compiled = compileEntries(entries);
    if (!compiled.length) return null;
    const stacks = haystacksFor(...parts);
    for (const hay of stacks) {
        for (const entry of compiled) {
            try {
                if (entry.test(hay)) return entry.label;
            } catch {
                // ignore a broken entry
            }
        }
    }
    return null;
}

function countWords(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
}

// Does this parsed object represent an error, even inside a 200 response?
function errorMessageFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;

    const err = obj.error ?? obj.err;
    if (err) {
        if (typeof err === 'string') return err;
        if (typeof err === 'object') {
            return err.message || err.type || err.code || JSON.stringify(err).slice(0, 200);
        }
        return 'error';
    }

    // SillyTavern sometimes relays: { message: "...", quota_error: true } etc.
    if (obj.quota_error || obj.rate_limited) return obj.message || 'rate limited';
    if (typeof obj.message === 'string' && obj.message && obj.choices === undefined && obj.content === undefined) {
        // A bare {message: "..."} body from the ST backend is an error relay.
        return obj.message;
    }
    if (typeof obj.detail === 'string' && obj.detail) return obj.detail;
    return null;
}

// Returns the reply text if we can positively identify it, or null if the
// shape is unrecognized OR it's a structured tool/function call with no text.
function extractTextFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (choice) {
        if (choice.delta) {
            if (typeof choice.delta.content === 'string') return choice.delta.content;
            if (Array.isArray(choice.delta.content)) {
                return choice.delta.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
            }
            if (choice.delta.tool_calls || choice.delta.function_call) return null;
        }
        if (choice.message) {
            if (typeof choice.message.content === 'string') return choice.message.content;
            if (Array.isArray(choice.message.content)) {
                return choice.message.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
            }
            if (choice.message.tool_calls || choice.message.function_call) return null;
        }
        if (typeof choice.text === 'string') return choice.text;
    }
    // Claude / Anthropic streaming + non-streaming
    if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
    if (Array.isArray(obj.content)) {
        const joined = obj.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
        if (joined) return joined;
    }
    if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].text === 'string') {
        return obj.results[0].text; // KoboldAI-style
    }
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    return null; // unrecognized shape — don't guess, skip the word-count check
}

// Plain-text heuristic for errors relayed outside JSON (proxies, gateways, Cloudflare pages).
function looksLikeErrorText(text) {
    const t = String(text || '').slice(0, 600);
    return /\b(429|too many requests|rate[\s_-]?limit|quota|resource[\s_-]?exhausted|overloaded|exceeded|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|\b50[0234]\b)\b/i.test(t)
        || /^\s*<(!doctype|html)/i.test(t);
}

// Inspect a full response body (JSON or SSE). Returns
// { error: string|null, text: string|null }.
function inspectBody(bodyText, contentType) {
    const trimmed = (bodyText || '').trim();
    if (!trimmed) return { error: 'empty response body', text: '' };

    const looksLikeSse = (contentType && contentType.includes('event-stream')) || /^data:\s*/m.test(trimmed);

    if (looksLikeSse) {
        let combined = '';
        let anyTextFound = false;
        let error = null;
        let sawErrorEvent = false;

        for (const line of trimmed.split(/\r?\n/)) {
            const eventMatch = line.match(/^event:\s*(.*)$/);
            if (eventMatch) {
                sawErrorEvent = /error/i.test(eventMatch[1]);
                continue;
            }
            const m = line.match(/^data:\s*(.*)$/);
            if (!m) continue;
            const payload = m[1].trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed = null;
            try {
                parsed = JSON.parse(payload);
            } catch {
                // Non-JSON data line: an error if flagged by an `event: error`, or if it reads like one.
                if ((sawErrorEvent || looksLikeErrorText(payload)) && !error) error = payload.slice(0, 200);
                continue;
            }

            const errMsg = errorMessageFromObject(parsed);
            if (errMsg && !error) error = errMsg;
            if (sawErrorEvent && !error) error = payload.slice(0, 200);

            const piece = extractTextFromObject(parsed);
            if (piece !== null) {
                combined += piece;
                anyTextFound = true;
            }
        }
        return { error, text: anyTextFound ? combined : null };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // Not JSON, not SSE: plain text / HTML. Treat as an error only if it reads like one.
        if (looksLikeErrorText(trimmed)) return { error: trimmed.slice(0, 200), text: null };
        return { error: null, text: null };
    }
    return { error: errorMessageFromObject(parsed), text: extractTextFromObject(parsed) };
}

function streamFromText(text) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

function rebuildResponse(bodyText, response, asStream) {
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(asStream ? streamFromText(bodyText) : bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}


// Peek at the start of a live streaming response without destroying
// streaming. Reads chunks until we can decide: error found, first real text
// token seen, stream ended, or the peek budget ran out. Returns
//   { verdict: 'error'|'ok'|'ended'|'timeout', error, text, chunks, reader, done }
// `chunks` are the raw Uint8Arrays read so far (to be replayed), `reader` is
// the still-open reader (when not done) to be piped through afterwards.
async function peekStream(response, signal, maxMs, peekCfg = { entries: [], scanChars: 0 }) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let seen = '';
    let done = false;
    const started = Date.now();

    const verdictFor = (final) => {
        const { error, text } = inspectBodyPartial(seen, response.headers.get('content-type') || '', final);
        if (error) return { verdict: 'error', error, text };
        // Custom entries are matched against the raw payload AND the extracted text, so
        // they fire on error JSON/SSE events and unknown shapes, not only on reply text.
        const hit = findCustomErrorMatch(peekCfg.entries, seen, text || '');
        if (hit) return { verdict: 'error', error: `matched custom error "${hit}"`, text };
        const hasEntries = compileEntries(peekCfg.entries).length > 0;
        if (text !== null && text.trim().length > 0) {
            // Keep reading (still buffered, nothing shown yet) until enough text has been
            // scanned, so phrases near the start of a reply are caught before display.
            if (!final && hasEntries && peekCfg.scanChars > 0 && text.length < peekCfg.scanChars) return null;
            return { verdict: 'ok', error: null, text };
        }
        // Reasoning / thinking / tool-call deltas prove the upstream is generating
        // normally, so commit and let them stream live instead of waiting for content.
        if (/"(reasoning_content|reasoning|thinking|thought|tool_calls|function_call)"\s*:\s*(\[|\{|"[^"])/i.test(seen)) {
            return { verdict: 'ok', error: null, text };
        }
        return null;
    };

    while (true) {
        if (signal && signal.aborted) {
            try { reader.cancel(); } catch { /* ignore */ }
            throw new DOMException('Aborted', 'AbortError');
        }
        const remaining = maxMs - (Date.now() - started);
        if (remaining <= 0) return { verdict: 'timeout', error: null, text: null, chunks, reader, done: false };

        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), remaining);
        });
        let result;
        try {
            result = await Promise.race([reader.read(), timeout]);
        } finally {
            clearTimeout(timer);
        }
        if (result.timedOut) return { verdict: 'timeout', error: null, text: null, chunks, reader, done: false };

        if (result.done) {
            done = true;
            const v = verdictFor(true);
            if (v) return { ...v, chunks, reader, done };
            const { error, text } = inspectBody(seen, response.headers.get('content-type') || '');
            if (error) return { verdict: 'error', error, text, chunks, reader, done };
            if (text === null && /^data:/m.test(seen) && !/"tool_calls"|"function_call"|"reasoning|"thinking|"thought/i.test(seen)) {
                return { verdict: 'error', error: 'stream ended with no content', text: null, chunks, reader, done };
            }
            return { verdict: 'ended', error: null, text, raw: seen, chunks, reader, done };
        }

        chunks.push(result.value);
        seen += decoder.decode(result.value, { stream: true });
        const v = verdictFor(false);
        if (v) return { ...v, chunks, reader, done };
    }
}

// Like inspectBody but tolerant of a truncated tail (partial last line).
function inspectBodyPartial(partialText, contentType, final) {
    let t = partialText;
    if (!final) {
        const lastNl = t.lastIndexOf('\n');
        t = lastNl === -1 ? '' : t.slice(0, lastNl + 1);
    }
    if (!t.trim()) return { error: null, text: null };
    const r = inspectBody(t, contentType);
    // A bare non-SSE, non-JSON blob that is still arriving: no verdict yet.
    return r;
}

// Build a Response that replays already-read chunks, then keeps piping the
// live reader, so the consumer still gets tokens in real time.
function resumeStreamResponse(response, chunks, reader, alreadyDone) {
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    let i = 0;
    const body = new ReadableStream({
        async pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(chunks[i++]);
                return;
            }
            if (alreadyDone) {
                controller.close();
                return;
            }
            try {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (err) {
                controller.error(err);
            }
        },
        cancel(reason) {
            try { return reader.cancel(reason); } catch { return undefined; }
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// ─── Fetch Patch ─────────────────────────────────────────────────────

let originalFetch = null;

function installFetchPatch() {
    if (originalFetch) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        const settings = getSettings();
        const requestUrl = extractUrl(input);

        if (!settings.enabled || !isGenerationRequest(requestUrl)) {
            return originalFetch(input, init);
        }

        const replayable = await makeReplayable(input, init);
        if (!replayable) {
            debugLog('Not replayable, passing through:', requestUrl);
            return originalFetch(input, init);
        }

        const externalSignal = (init && init.signal) || (input && input.signal) || null;
        const wantsStream = requestAsksForStream(replayable.bodyText);
        const minWords = Math.max(0, Number(settings.minWords) || 0);
        let attempt = 0;

        debugLog('Intercepting generation request:', requestUrl, wantsStream ? '(streaming)' : '(non-streaming)');

        while (true) {
            if (externalSignal && externalSignal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            let response = null;
            let networkError = null;

            try {
                response = await replayable.replay();
            } catch (err) {
                networkError = err;
            }

            if (isAbortError(networkError) || (externalSignal && externalSignal.aborted)) {
                if (networkError) throw networkError;
                throw new DOMException('Aborted', 'AbortError');
            }

            let finalResponse = response;
            let bodyError = null;
            let wordCount = null;
            let replyText = null;
            let rawText = null;

            if (!networkError) {
                const contentType = response.headers.get('content-type') || '';
                const isStreamResponse = (wantsStream || contentType.includes('event-stream')) && !!response.body;

                if (isStreamResponse && response.ok && settings.inspectStreams && !settings.holdStreamsForMinWords) {
                    // Live stream: peek only until a verdict, then pass through.
                    try {
                        const peek = await peekStream(response, externalSignal, Math.max(1000, Number(settings.peekMaxMs) || 15000), { entries: settings.errorEntries, scanChars: Math.max(0, Number(settings.scanChars) || 0) });
                        bodyError = peek.error;
                        if (peek.verdict === 'ended' && peek.text !== null) { wordCount = countWords(peek.text); replyText = peek.text; }
                        if (peek.raw) rawText = peek.raw;
                        if (peek.verdict === 'error') {
                            try { peek.reader.cancel(); } catch { /* ignore */ }
                        } else {
                            finalResponse = resumeStreamResponse(response, peek.chunks, peek.reader, peek.done);
                        }
                        debugLog('Peeked stream:', { verdict: peek.verdict, bodyError, wordCount });
                        if (peek.verdict === 'timeout') log('Stream gave no verdict within the peek window; passing it through unchanged.');
                    } catch (err) {
                        if (isAbortError(err)) throw err;
                        debugLog('Peek failed, passing response through:', err);
                    }
                } else if (!isStreamResponse || settings.inspectStreams) {
                    // Non-streaming reply, or the user opted into holding streams for the length check.
                    let bodyText = null;
                    try {
                        bodyText = await response.clone().text();
                    } catch {
                        bodyText = null;
                    }

                    if (bodyText !== null) {
                        const { error, text } = inspectBody(bodyText, contentType);
                        bodyError = error;
                        rawText = bodyText;
                        if (text !== null) { wordCount = countWords(text); replyText = text; }
                        finalResponse = rebuildResponse(bodyText, response, isStreamResponse);
                        debugLog('Inspected response:', {
                            status: response.status,
                            bodyError,
                            wordCount,
                            streamed: isStreamResponse,
                        });
                    }
                }
            }

            let customHit = null;
            if (!networkError && (replyText !== null || rawText !== null)) customHit = findCustomErrorMatch(settings.errorEntries, rawText || '', replyText || '');
            if (customHit && !bodyError) bodyError = `matched custom error "${customHit}"`;

            const isHttpError = !networkError && !response.ok;
            const isShortReply = minWords > 0 && wordCount !== null && wordCount < minWords;
            const shouldRetry = !!networkError || isHttpError || !!bodyError || isShortReply;

            if (!shouldRetry) {
                if (networkError) throw networkError;
                return finalResponse;
            }

            const reason = networkError
                ? networkError.message
                : isHttpError
                    ? `HTTP ${response.status}${bodyError ? ' — ' + bodyError : ''}`
                    : bodyError
                        ? `error in response: ${bodyError}`
                        : `reply was only ${wordCount} words (min ${minWords})`;

            if (attempt >= settings.maxRetries) {
                log(`Gave up after ${attempt} retries (${reason}).`);
                toast('error', `Still failing after ${attempt} retries (${reason}) — giving up.`);
                if (networkError) throw networkError;
                return finalResponse;
            }

            attempt += 1;
            log(`Failed (${reason}). Retry ${attempt}/${settings.maxRetries} in ${settings.delayMs}ms.`);
            toast('info', `${reason} — retry ${attempt}/${settings.maxRetries}…`);
            await sleep(settings.delayMs, externalSignal);
        }
    };

    log('fetch() patched — retries on network errors, HTTP errors, in-body errors, and short replies.');
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
            );
        }
    });
}

// ─── Settings UI ───────────────────────────────────────────────────

function buildSettingsHtml() {
    const settings = getSettings();
    return `
    <div class="retry-on-error-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Retry On Error <span style="opacity:0.55;font-weight:normal;font-size:0.8em;">v${EXT_VERSION}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="retryerr_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    Enable retry on error
                </label>

                <label>Max retries
                    <input id="retryerr_maxRetries" class="text_pole" type="number" min="0" max="50" value="${settings.maxRetries}">
                </label>

                <label>Time between retries (ms)
                    <input id="retryerr_delayMs" class="text_pole" type="number" min="0" step="100" value="${settings.delayMs}">
                </label>

                <label>Minimum reply length (words, 0 = off)
                    <input id="retryerr_minWords" class="text_pole" type="number" min="0" max="1000" value="${settings.minWords}">
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_inspectStreams" type="checkbox" ${settings.inspectStreams ? 'checked' : ''}>
                    Detect errors in streamed replies (keeps live token-by-token streaming; only peeks at the start of the stream)
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_holdStreams" type="checkbox" ${settings.holdStreamsForMinWords ? 'checked' : ''}>
                    Hold streams to enforce minimum length (buffers the whole reply, so it appears at once instead of live)
                </label>

                <div class="retryerr_entries_header"><b>Custom error entries</b>
                    <small>If a reply (or raw JSON/SSE response) contains any enabled entry, the request is retried, even if the reply is longer than the minimum word count.</small>
                </div>
                <div id="retryerr_entries"></div>
                <div class="flex-container" style="gap:6px;margin:6px 0;">
                    <input id="retryerr_newEntry" class="text_pole" type="text" placeholder="Type an error / phrase to catch..." style="flex:1;">
                    <select id="retryerr_newMode" class="text_pole" style="width:auto;">
                        <option value="text">Text</option>
                        <option value="regex">Regex</option>
                    </select>
                    <button id="retryerr_addEntry" class="menu_button" type="button" title="Add entry"><i class="fa-solid fa-plus"></i> Add</button>
                </div>

                <details>
                    <summary>Test an entry against a response</summary>
                    <textarea id="retryerr_testInput" class="text_pole textarea_compact" rows="4" placeholder="Paste a raw JSON or SSE response here (e.g. data: {&quot;error&quot;:{&quot;message&quot;:&quot;429&quot;}})"></textarea>
                    <button id="retryerr_testBtn" class="menu_button" type="button">Test</button>
                    <small id="retryerr_testResult"></small>
                </details>

                <label>Phrase scan window for streams (characters)
                    <input id="retryerr_scanChars" class="text_pole" type="number" min="0" max="5000" step="50" value="${settings.scanChars}">
                </label>
                <small>Streams are held back (briefly, nothing shown) until this many characters have been scanned for your phrases, so a refusal at the start of a reply is retried invisibly. Later in the reply it can only be caught if "Hold streams" is on. 0 = off.</small>

                <label class="checkbox_label">
                    <input id="retryerr_debug" type="checkbox" ${settings.debug ? 'checked' : ''}>
                    Debug logging in browser console
                </label>

                <small>Retries on network errors, any non-2xx HTTP status, error payloads
                returned with a 200 status (common for 429 / quota errors), and replies
                shorter than the minimum. Only applies to chat/text generation requests.</small>
            </div>
        </div>
    </div>`;
}

function escapeAttr(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderEntries() {
    const list = getSettings().errorEntries;
    const host = $('#retryerr_entries');
    if (!list.length) {
        host.html('<small><i>No entries yet. Add one below.</i></small>');
        return;
    }
    host.html(list.map((e, i) => `
        <div class="retryerr_entry flex-container" data-i="${i}" style="gap:6px;align-items:center;margin:3px 0;">
            <input class="retryerr_entry_enabled" type="checkbox" ${e.enabled === false ? '' : 'checked'} title="Enabled">
            <input class="retryerr_entry_text text_pole" type="text" value="${escapeAttr(e.text)}" style="flex:1;">
            <select class="retryerr_entry_mode text_pole" style="width:auto;">
                <option value="text" ${e.mode === 'regex' ? '' : 'selected'}>Text</option>
                <option value="regex" ${e.mode === 'regex' ? 'selected' : ''}>Regex</option>
            </select>
            <button class="retryerr_entry_delete menu_button" type="button" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>`).join(''));
}

function wireSettingsInputs() {
    $('#retryerr_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_maxRetries').on('input', function () {
        getSettings().maxRetries = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_delayMs').on('input', function () {
        getSettings().delayMs = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_minWords').on('input', function () {
        getSettings().minWords = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_inspectStreams').on('change', function () {
        getSettings().inspectStreams = $(this).prop('checked');
        saveSettingsDebounced();
    });
    renderEntries();
    const addEntry = () => {
        const text = String($('#retryerr_newEntry').val() || '').trim();
        if (!text) return;
        const mode = $('#retryerr_newMode').val() === 'regex' ? 'regex' : 'text';
        if (mode === 'regex') {
            try { new RegExp(text, 'i'); } catch (e) { toast('error', 'Invalid regex: ' + e.message); return; }
        }
        getSettings().errorEntries.push({ text, mode, flags: 'i', enabled: true });
        saveSettingsDebounced();
        $('#retryerr_newEntry').val('');
        renderEntries();
    };
    $('#retryerr_addEntry').on('click', addEntry);
    $('#retryerr_newEntry').on('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addEntry(); }
    });
    $('#retryerr_entries').on('input', '.retryerr_entry_text', function () {
        const i = Number($(this).closest('.retryerr_entry').data('i'));
        const entry = getSettings().errorEntries[i];
        if (entry) { entry.text = String($(this).val()); saveSettingsDebounced(); }
    });
    $('#retryerr_entries').on('change', '.retryerr_entry_mode', function () {
        const i = Number($(this).closest('.retryerr_entry').data('i'));
        const entry = getSettings().errorEntries[i];
        if (entry) { entry.mode = $(this).val() === 'regex' ? 'regex' : 'text'; saveSettingsDebounced(); }
    });
    $('#retryerr_entries').on('change', '.retryerr_entry_enabled', function () {
        const i = Number($(this).closest('.retryerr_entry').data('i'));
        const entry = getSettings().errorEntries[i];
        if (entry) { entry.enabled = $(this).prop('checked'); saveSettingsDebounced(); }
    });
    $('#retryerr_entries').on('click', '.retryerr_entry_delete', function () {
        const i = Number($(this).closest('.retryerr_entry').data('i'));
        getSettings().errorEntries.splice(i, 1);
        saveSettingsDebounced();
        renderEntries();
    });
    $('#retryerr_testBtn').on('click', function () {
        const sample = String($('#retryerr_testInput').val() || '');
        const parsed = inspectBody(sample, '');
        const hit = findCustomErrorMatch(getSettings().errorEntries, sample, parsed.text || '');
        const msg = hit
            ? `Matched entry: ${hit}  → would RETRY`
            : parsed.error
                ? `No custom entry matched, but built-in detection sees an error ("${parsed.error}")  → would RETRY`
                : 'No entry matched and no built-in error found  → would NOT retry';
        $('#retryerr_testResult').text(msg);
    });
    $('#retryerr_scanChars').on('input', function () {
        getSettings().scanChars = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_holdStreams').on('change', function () {
        getSettings().holdStreamsForMinWords = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_debug').on('change', function () {
        getSettings().debug = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

let settingsInjected = false;

function injectSettingsUI() {
    if (settingsInjected) return true;
    let container = $('#extensions_settings2');
    if (container.length === 0) container = $('#extensions_settings');
    if (container.length === 0) return false;

    container.append(buildSettingsHtml());
    wireSettingsInputs();
    settingsInjected = true;
    log('Settings UI injected into ' + (container.attr('id') || '(unknown container)') + '.');
    return true;
}

function ensureSettingsUIInjected() {
    if (injectSettingsUI()) return;

    let attempts = 0;
    const maxAttempts = 40; // ~20s of polling as a fast path
    const poll = setInterval(() => {
        attempts += 1;
        if (injectSettingsUI() || attempts >= maxAttempts) {
            clearInterval(poll);
        }
    }, 500);

    if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(() => {
            if (injectSettingsUI()) {
                observer.disconnect();
                clearInterval(poll);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
}

// ─── Init ──────────────────────────────────────────────────────────

function safely(label, fn) {
    try {
        fn();
    } catch (err) {
        console.error('[Retry On Error] ' + label + ' failed:', err);
    }
}

jQuery(async () => {
    safely('getSettings', getSettings);
    safely('installFetchPatch', installFetchPatch);
    safely('ensureSettingsUIInjected', ensureSettingsUIInjected);

    log('Initialized.');
    console.log(
        '%c[Retry On Error] v' + EXT_VERSION + ' loaded at ' + new Date().toLocaleTimeString(),
        'background:#222;color:#7CFC00;font-weight:bold;padding:2px 6px;border-radius:3px;',
    );
});
