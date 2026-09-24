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
// Streaming: streamed replies are inspected too. Because an SSE body can only
// be judged after it has been read, inspection buffers the stream, then hands
// the caller a fresh streaming response. That is the only way to detect
// in-stream errors and short replies at all; it can be turned off in settings
// (Inspect streamed replies), in which case streams are passed through
// completely untouched and only network errors / HTTP status are checked.
//
// If the caller passed an AbortSignal (SillyTavern's "Stop" button does this),
// an abort is never retried — it's immediately propagated so Stop still stops.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_on_error';
const EXT_VERSION = '2.1.0';

const defaultSettings = {
    enabled: true,
    maxRetries: 5,
    delayMs: 2000,
    minWords: 40,
    inspectStreams: true,
    debug: false,
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
                if (sawErrorEvent && !error) error = payload.slice(0, 200);
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

            if (!networkError) {
                const contentType = response.headers.get('content-type') || '';
                const isStreamResponse = wantsStream || contentType.includes('event-stream');
                const shouldInspect = !isStreamResponse || settings.inspectStreams;

                if (shouldInspect) {
                    let bodyText = null;
                    try {
                        bodyText = await response.clone().text();
                    } catch {
                        bodyText = null;
                    }

                    if (bodyText !== null) {
                        const { error, text } = inspectBody(bodyText, contentType);
                        bodyError = error;
                        if (text !== null) wordCount = countWords(text);
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
                    Inspect streamed replies (needed to catch in-stream errors and short replies; the reply appears at once instead of token-by-token)
                </label>

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
