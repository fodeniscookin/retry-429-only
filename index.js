// 429 Retry Only — SillyTavern extension
// Retries a request ONLY when the server responds with HTTP 429 (Too Many Requests).
// Does nothing on empty/short responses, timeouts, or other status codes —
// avoids the "double request in flight" problem that shared/free API proxies
// (rate-limited to 1 concurrent request) are sensitive to.

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_429_only';

const defaultSettings = {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 1000,      // starting backoff delay
    maxDelayMs: 30000,      // cap for backoff delay
    respectRetryAfter: true, // honor the Retry-After header if the server sends one
    jitter: true,           // add randomness so retries don't all land at once
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // backfill any new keys added in later versions
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt, settings, retryAfterHeader) {
    if (settings.respectRetryAfter && retryAfterHeader) {
        // Retry-After can be seconds, or an HTTP date
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
        delay = delay * (0.75 + Math.random() * 0.5); // +/-25% jitter
    }
    return delay;
}

function log(...args) {
    console.log('[429 Retry Only]', ...args);
}

function toast(message, type = 'info') {
    try {
        if (typeof toastr !== 'undefined') {
            toastr[type](message, '429 Retry Only');
        }
    } catch {
        // toastr not available, ignore
    }
}

let originalFetch = null;

function installFetchPatch() {
    if (originalFetch) return; // already installed
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        const settings = getSettings();

        if (!settings.enabled) {
            return originalFetch(input, init);
        }

        let attempt = 0;

        while (true) {
            let response;
            try {
                response = await originalFetch(input, init);
            } catch (err) {
                // Network-level failure (not an HTTP status) — not our job, pass it through.
                throw err;
            }

            if (response.status !== 429) {
                return response; // only 429 triggers a retry, everything else passes straight through
            }

            if (attempt >= settings.maxRetries) {
                log(`Gave up after ${attempt} retries (still getting 429).`);
                toast(`Still rate-limited after ${attempt} retries — giving up.`, 'error');
                return response; // hand back the 429 so the caller can handle it
            }

            const retryAfterHeader = response.headers.get('retry-after');
            const delay = computeDelay(attempt, settings, retryAfterHeader);
            attempt += 1;

            log(`Got 429. Retry ${attempt}/${settings.maxRetries} in ${Math.round(delay)}ms.`);
            toast(`Rate limited (429). Retrying in ${Math.round(delay / 1000)}s… (${attempt}/${settings.maxRetries})`, 'warning');

            await sleep(delay);
            // loop and try again with the same input/init
        }
    };

    log('fetch() patched — will retry only on HTTP 429.');
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
    <div class="retry-429-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>429 Retry Only</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="retry429_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    Enable 429 retry
                </label>

                <label>Max retries
                    <input id="retry429_maxRetries" class="text_pole" type="number" min="0" max="50" value="${settings.maxRetries}">
                </label>

                <label>Base delay (ms)
                    <input id="retry429_baseDelayMs" class="text_pole" type="number" min="100" step="100" value="${settings.baseDelayMs}">
                </label>

                <label>Max delay (ms)
                    <input id="retry429_maxDelayMs" class="text_pole" type="number" min="1000" step="1000" value="${settings.maxDelayMs}">
                </label>

                <label class="checkbox_label">
                    <input id="retry429_respectRetryAfter" type="checkbox" ${settings.respectRetryAfter ? 'checked' : ''}>
                    Honor server's Retry-After header when present
                </label>

                <label class="checkbox_label">
                    <input id="retry429_jitter" type="checkbox" ${settings.jitter ? 'checked' : ''}>
                    Add jitter to backoff
                </label>

                <small>Only retries on HTTP 429 (rate limited). Does not touch empty/short responses,
                timeouts, or other errors — safe to use with providers that only allow one request
                in flight at a time.</small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#retry429_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retry429_maxRetries').on('input', function () {
        getSettings().maxRetries = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retry429_baseDelayMs').on('input', function () {
        getSettings().baseDelayMs = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retry429_maxDelayMs').on('input', function () {
        getSettings().maxDelayMs = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#retry429_respectRetryAfter').on('change', function () {
        getSettings().respectRetryAfter = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#retry429_jitter').on('change', function () {
        getSettings().jitter = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

jQuery(async () => {
    getSettings();
    installFetchPatch();
    renderSettingsUI();
});
