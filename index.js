// Retry On Error — SillyTavern extension (minimal edition)
//
// Retries a chat/completion request when:
//   1. fetch() throws a network error, OR
//   2. the response comes back with a non-2xx HTTP status ("any error"), OR
//   3. the AI's reply text is under 40 words (short/truncated/refusal-style replies)
//
// Settings are intentionally just: enable/disable, max retries, delay between
// retries. Everything else (dashboards, logs, keyword lists, URL pattern
// config, jitter, Retry-After handling, etc.) has been removed on purpose.
//
// If the caller passed an AbortSignal (SillyTavern's "Stop" button does this),
// an abort is never retried — it's immediately propagated so Stop still stops.
//
// NOTE on streaming: a genuine live SSE stream (request has "stream":true,
// or the response's content-type is text/event-stream) is never buffered or
// otherwise touched — real-time token-by-token display is fully preserved.
// For streaming responses only network errors and non-2xx HTTP status are
// checked (both are known before any body is read); the "under 40 words"
// check only applies to non-streaming replies, since checking it would
// require reading the whole reply before it could be displayed at all.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_on_error';
const EXT_VERSION = '2.0.1';
const MIN_WORDS = 40;

const defaultSettings = {
    enabled: true,
    maxRetries: 5,
    delayMs: 2000,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function log(...args) {
    console.log('[Retry On Error]', ...args);
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Only these requests get retry behavior. Everything else (settings saves,
// thumbnails, background polls, presets, etc.) passes through untouched.
const GENERATION_URL_PATTERNS = ['/api/backends/', '/chat/completions', '/v1/completions', '/completions'];

function isGenerationRequest(url) {
    return GENERATION_URL_PATTERNS.some((p) => url.includes(p));
}

function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
}

// A request whose body is a stream (or a consumed Request object) can't be
// safely replayed on retry.
function isReplayable(input, init) {
    const body = init && init.body;
    if (body && typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
    if (typeof Request !== 'undefined' && input instanceof Request && input.bodyUsed) return false;
    return true;
}

function isStreamingRequest(init) {
    const body = init && init.body;
    if (typeof body !== 'string') return false;
    return /"stream"\s*:\s*true/i.test(body);
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

// Pull the actual reply text out of a chat-completion / text-completion
// response body, whether it's a single JSON object or a buffered SSE stream.
// Returns null if the body isn't a format we recognize (word-count check is
// then skipped, but error/network retry still applies).
function extractReplyText(bodyText, contentType) {
    const trimmed = (bodyText || '').trim();
    if (!trimmed) return '';

    const looksLikeSse = (contentType && contentType.includes('event-stream')) || /^data:\s*/m.test(trimmed);

    if (looksLikeSse) {
        let combined = '';
        let anyTextFound = false;
        for (const line of trimmed.split(/\r?\n/)) {
            const m = line.match(/^data:\s*(.*)$/);
            if (!m) continue;
            const payload = m[1].trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const piece = extractTextFromObject(JSON.parse(payload));
                if (piece !== null) {
                    combined += piece;
                    anyTextFound = true;
                }
            } catch {
                // ignore malformed/partial chunk
            }
        }
        return anyTextFound ? combined : null;
    }

    try {
        return extractTextFromObject(JSON.parse(trimmed));
    } catch {
        return null;
    }
}

// Returns the reply text if we can positively identify it, or null if the
// shape is unrecognized OR it's a structured tool/function call with no text
// (a tool call isn't "a short reply" — treating it as 0 words would trigger
// pointless retries on perfectly valid responses).
function extractTextFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (choice) {
        if (choice.delta) {
            if (typeof choice.delta.content === 'string') return choice.delta.content;
            if (choice.delta.tool_calls || choice.delta.function_call) return null;
        }
        if (choice.message) {
            if (typeof choice.message.content === 'string') return choice.message.content;
            if (choice.message.tool_calls || choice.message.function_call) return null;
        }
        if (typeof choice.text === 'string') return choice.text;
    }
    if (Array.isArray(obj.results) && obj.results[0] && typeof obj.results[0].text === 'string') {
        return obj.results[0].text; // KoboldAI-style
    }
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    return null; // unrecognized shape — don't guess, skip the word-count check
}

function countWords(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
}

// ─── Fetch Patch ─────────────────────────────────────────────────────

let originalFetch = null;

function installFetchPatch() {
    if (originalFetch) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        const settings = getSettings();
        const requestUrl = extractUrl(input);

        if (!settings.enabled || !isGenerationRequest(requestUrl) || !isReplayable(input, init)) {
            return originalFetch(input, init);
        }

        const externalSignal = init && init.signal ? init.signal : null;
        let attempt = 0;

        while (true) {
            if (externalSignal && externalSignal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            let response = null;
            let networkError = null;

            try {
                response = await originalFetch(input, init);
            } catch (err) {
                networkError = err;
            }

            if (isAbortError(networkError) || (externalSignal && externalSignal.aborted)) {
                if (networkError) throw networkError;
                throw new DOMException('Aborted', 'AbortError');
            }

            let finalResponse = response;
            let wordCount = null;

            // A genuine live stream must NEVER be buffered here — reading it
            // fully before returning would turn real-time token-by-token
            // streaming into a multi-second freeze-then-dump-everything-at-once.
            // We detect "this is a real stream" from the OUTGOING request (the
            // caller asked for stream:true) OR the response's own content-type,
            // and if so we skip body inspection entirely: only HTTP status and
            // network errors are checked (both available without touching the
            // body), and the original, untouched, still-lazy response is what
            // gets returned/streamed onward.
            const looksStreaming =
                !networkError &&
                (isStreamingRequest(init) || (response.headers.get('content-type') || '').includes('event-stream'));

            if (!networkError && !looksStreaming) {
                // Non-streaming reply: safe to buffer once so we can (a) count
                // words and (b) still hand the caller a fresh, fully-readable
                // Response either way.
                let bodyText = null;
                try {
                    bodyText = await response.clone().text();
                } catch {
                    bodyText = null;
                }

                if (bodyText !== null) {
                    const extracted = extractReplyText(bodyText, response.headers.get('content-type') || '');
                    if (extracted !== null) {
                        wordCount = countWords(extracted);
                    }
                    finalResponse = new Response(bodyText, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                }
            }

            const isHttpError = !networkError && !response.ok;
            const isShortReply = wordCount !== null && wordCount < MIN_WORDS;
            const shouldRetry = !!networkError || isHttpError || isShortReply;

            if (!shouldRetry) {
                if (networkError) throw networkError;
                return finalResponse;
            }

            if (attempt >= settings.maxRetries) {
                const reason = networkError
                    ? networkError.message
                    : isHttpError
                        ? `HTTP ${response.status}`
                        : `reply was only ${wordCount} words`;
                log(`Gave up after ${attempt} retries (${reason}).`);
                try {
                    if (typeof toastr !== 'undefined') {
                        toastr.error(`Still failing after ${attempt} retries (${reason}) — giving up.`, 'Retry On Error');
                    }
                } catch {
                    // ignore
                }
                if (networkError) throw networkError;
                return finalResponse;
            }

            const reason = networkError
                ? networkError.message
                : isHttpError
                    ? `HTTP ${response.status}`
                    : `reply was only ${wordCount} words (min ${MIN_WORDS})`;
            log(`Failed (${reason}). Retry ${attempt + 1}/${settings.maxRetries} in ${settings.delayMs}ms.`);

            attempt += 1;
            await sleep(settings.delayMs, externalSignal);
        }
    };

    log('fetch() patched — retries on network errors, HTTP error statuses, and replies under ' + MIN_WORDS + ' words.');
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

                <small>Retries on network errors, any non-2xx HTTP error, or a reply
                under ${MIN_WORDS} words. Only applies to chat/text generation requests.</small>
            </div>
        </div>
    </div>`;
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

    // Container wasn't there yet — retry on a timer AND watch the DOM
    // directly, so a lazily-built Extensions panel still gets caught.
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
