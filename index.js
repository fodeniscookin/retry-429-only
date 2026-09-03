// Retry On Error — SillyTavern extension
// Retries a request when it fails via:
//  1. Network errors (fetch throws)
//  2. Configurable HTTP error statuses (429, 500, 502, 503, 504, ...)
//  3. A body-keyword scan — catches providers that return an error message
//     inside a 200-status JSON body (e.g. "provider temporarily unavailable"),
//     which a status-code check alone would never catch.
//
// The body scan is skipped for streaming (SSE) responses so it never
// consumes/breaks a real streaming generation — it only inspects
// non-streaming JSON bodies, which is what most "wrapped error" responses
// look like.

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_on_error';

const defaultSettings = {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    respectRetryAfter: true,
    jitter: true,
    retryOnNetworkError: true,
    retryableStatuses: '429,500,502,503,504',
    retryOnBodyKeywords: true,
    bodyKeywords: 'temporarily unavailable,rate limit,rate-limited,overloaded',
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

function getRetryableStatusSet(settings) {
    return new Set(
        settings.retryableStatuses
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => !Number.isNaN(n)),
    );
}

function getKeywordList(settings) {
    return settings.bodyKeywords
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt, settings, retryAfterHeader) {
    if (settings.respectRetryAfter && retryAfterHeader) {
        const asSeconds = Number(retryAfterHeader);
        if (!Number.isNaN(asSeconds)) {
            return Math.min(asSeconds * 1000, settings.maxDelayMs);
        }
        const asDate = new Date(retryAfterHeader).getTime();
        if (!Number.isNaN(asDate)) {
            const diff = asDate - Date.now();
            if (diff > 0) return Math.min(diff, settings.maxDelayMs);
        }
    }
    let delay = Math.min(settings.baseDelayMs * Math.pow(2, attempt), settings.maxDelayMs);
    if (settings.jitter) {
        delay = delay * (0.75 + Math.random() * 0.5);
    }
    return delay;
}

function log(...args) {
    console.log('[Retry On Error]', ...args);
}

function toast(message, type = 'info') {
    try {
        if (typeof toastr !== 'undefined') {
            toastr[type](message, 'Retry On Error');
        }
    } catch {
        // toastr not available, ignore
    }
}

function isStreamingResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('text/event-stream');
}

async function bodyMatchesKeyword(response, keywords) {
    if (keywords.length === 0) return false;
    if (isStreamingResponse(response)) return false; // never consume a real stream

    try {
        // clone so the original body is still readable by whoever called fetch()
        const text = await response.clone().text();
        const lower = text.toLowerCase();
        return keywords.some((kw) => lower.includes(kw));
    } catch {
        return false; // if we can't read it, don't block on it
    }
}

let originalFetch = null;

function installFetchPatch() {
    if (originalFetch) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        const settings = getSettings();

        if (!settings.enabled) {
            return originalFetch(input, init);
        }

        const retryableStatuses = getRetryableStatusSet(settings);
        const keywords = getKeywordList(settings);
        let attempt = 0;

        while (true) {
            let response;
            let networkError = null;

            try {
                response = await originalFetch(input, init);
            } catch (err) {
                networkError = err;
            }

            let matchedKeyword = false;
            if (!networkError && settings.retryOnBodyKeywords && !retryableStatuses.has(response.status)) {
                matchedKeyword = await bodyMatchesKeyword(response, keywords);
            }

            const shouldRetryNetworkError = networkError && settings.retryOnNetworkError;
            const shouldRetryStatus = response && retryableStatuses.has(response.status);
            const shouldRetryBody = response && matchedKeyword;

            if (!shouldRetryNetworkError && !shouldRetryStatus && !shouldRetryBody) {
                if (networkError) throw networkError;
                return response;
            }

            if (attempt >= settings.maxRetries) {
                const reason = networkError
                    ? networkError.message
                    : shouldRetryBody
                        ? 'matched error keyword in body'
                        : `HTTP ${response.status}`;
                log(`Gave up after ${attempt} retries (${reason}).`);
                toast(`Still failing after ${attempt} retries (${reason}) — giving up.`, 'error');
                if (networkError) throw networkError;
                return response;
            }

            const retryAfterHeader = response ? response.headers.get('retry-after') : null;
            const delay = computeDelay(attempt, settings, retryAfterHeader);
            attempt += 1;

            const reason = networkError
                ? networkError.message
                : shouldRetryBody
                    ? 'matched error keyword in body'
                    : `HTTP ${response.status}`;
            log(`Failed (${reason}). Retry ${attempt}/${settings.maxRetries} in ${Math.round(delay)}ms.`);
            toast(`Request failed (${reason}). Retrying in ${Math.round(delay / 1000)}s… (${attempt}/${settings.maxRetries})`, 'warning');

            await sleep(delay);
        }
    };

    log('fetch() patched — retries on network errors, configured HTTP statuses, and body-keyword matches.');
}

function uninstallFetchPatch() {
    if (originalFetch) {
        window.fetch = originalFetch;
        originalFetch = null;
        log('fetch() restored to original.');
    }
}

function renderSettingsUI() {
    const settings = getSettings();

    const html = `
    <div class="retry-on-error-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Retry On Error</b>
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

                <label>Base delay (ms)
                    <input id="retryerr_baseDelayMs" class="text_pole" type="number" min="100" step="100" value="${settings.baseDelayMs}">
                </label>

                <label>Max delay (ms)
                    <input id="retryerr_maxDelayMs" class="text_pole" type="number" min="1000" step="1000" value="${settings.maxDelayMs}">
                </label>

                <label>Retryable HTTP statuses (comma-separated)
                    <input id="retryerr_retryableStatuses" class="text_pole" type="text" value="${settings.retryableStatuses}">
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_retryOnNetworkError" type="checkbox" ${settings.retryOnNetworkError ? 'checked' : ''}>
                    Also retry on network errors (connection dropped, no response at all)
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_retryOnBodyKeywords" type="checkbox" ${settings.retryOnBodyKeywords ? 'checked' : ''}>
                    Also retry when body text contains an error keyword (catches errors returned with status 200)
                </label>

                <label>Body error keywords (comma-separated, case-insensitive)
                    <input id="retryerr_bodyKeywords" class="text_pole" type="text" value="${settings.bodyKeywords}">
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_respectRetryAfter" type="checkbox" ${settings.respectRetryAfter ? 'checked' : ''}>
                    Honor server's Retry-After header when present (429s)
                </label>

                <label class="checkbox_label">
                    <input id="retryerr_jitter" type="checkbox" ${settings.jitter ? 'checked' : ''}>
                    Add jitter to backoff
                </label>

                <small>Body-keyword scanning is skipped for streaming (SSE) responses so it never
                interferes with an in-progress generation — it only inspects plain JSON error bodies.</small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#retryerr_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_maxRetries').on('input', function () {
        getSettings().maxRetries = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_baseDelayMs').on('input', function () {
        getSettings().baseDelayMs = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_maxDelayMs').on('input', function () {
        getSettings().maxDelayMs = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retryerr_retryableStatuses').on('input', function () {
        getSettings().retryableStatuses = $(this).val();
        saveSettingsDebounced();
    });
    $('#retryerr_retryOnNetworkError').on('change', function () {
        getSettings().retryOnNetworkError = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_retryOnBodyKeywords').on('change', function () {
        getSettings().retryOnBodyKeywords = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_bodyKeywords').on('input', function () {
        getSettings().bodyKeywords = $(this).val();
        saveSettingsDebounced();
    });
    $('#retryerr_respectRetryAfter').on('change', function () {
        getSettings().respectRetryAfter = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retryerr_jitter').on('change', function () {
        getSettings().jitter = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

jQuery(async () => {
    getSettings();
    installFetchPatch();
    renderSettingsUI();
});
              
