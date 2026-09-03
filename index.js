// Retry On Error — SillyTavern extension
// Retries a request when it fails via:
//  1. Network errors (fetch throws) — EXCLUDING user-initiated aborts (Stop button)
//  2. Configurable HTTP error statuses (429, 500, 502, 503, 504, ...)
//  3. A body-keyword scan for errors wrapped in a 200-status JSON body
//
// IMPORTANT: if the caller passed an AbortSignal (SillyTavern does this for
// its "Stop" button) and that signal is aborted, we never retry — we
// immediately propagate the abort so Stop actually stops generation.
//
// v1.1.0 — Adds a persistent log dashboard. Every retry attempt, final
// success after retries, and final failure is logged to extension_settings
// and viewable in a dashboard panel accessible from the nav menu.

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'retry_on_error';
const MAX_LOG_ENTRIES = 500;

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
    logs: [],
    maxLogEntries: MAX_LOG_ENTRIES,
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
    // Ensure logs is always an array
    if (!Array.isArray(extension_settings[MODULE_NAME].logs)) {
        extension_settings[MODULE_NAME].logs = [];
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

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
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

// ─── Log Storage ───────────────────────────────────────────────────

function addLogEntry(entry) {
    const settings = getSettings();
    entry.id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    entry.timestamp = new Date().toISOString();
    settings.logs.unshift(entry);
    // Trim to max entries
    const max = settings.maxLogEntries || MAX_LOG_ENTRIES;
    if (settings.logs.length > max) {
        settings.logs = settings.logs.slice(0, max);
    }
    saveSettingsDebounced();
    // If dashboard is open, refresh it
    if ($('#retry-dashboard-panel').is(':visible')) {
        renderDashboardLogs();
    }
}

function clearLogs() {
    const settings = getSettings();
    settings.logs = [];
    saveSettingsDebounced();
    renderDashboardLogs();
}

// ─── Toast ─────────────────────────────────────────────────────────

function toastFinalFailure(message) {
    try {
        if (typeof toastr === 'undefined') return;
        toastr.error(message, 'Retry On Error', { timeOut: 6000 });
    } catch {
        // toastr not available, ignore
    }
}

// ─── Fetch Patch Helpers ───────────────────────────────────────────

function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 20);
}

function isStreamingResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('text/event-stream');
}

async function bodyMatchesKeyword(response, keywords) {
    if (keywords.length === 0) return false;
    if (isStreamingResponse(response)) return false;

    try {
        const text = await response.clone().text();
        const lower = text.toLowerCase();
        return keywords.some((kw) => lower.includes(kw));
    } catch {
        return false;
    }
}

function extractUrl(input) {
    if (typeof input === 'string') return input;
    if (input && input.url) return input.url;
    if (input && input.href) return input.href;
    try {
        return String(input);
    } catch {
        return '(unknown)';
    }
}

// ─── Fetch Patch with Logging ──────────────────────────────────────

let originalFetch = null;

function installFetchPatch() {
    if (originalFetch) return;
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input, init) {
        const settings = getSettings();

        if (!settings.enabled) {
            return originalFetch(input, init);
        }

        const externalSignal = init && init.signal ? init.signal : null;
        const retryableStatuses = getRetryableStatusSet(settings);
        const keywords = getKeywordList(settings);
        const url = extractUrl(input);
        let attempt = 0;
        const attemptHistory = [];
        const startTime = Date.now();

        while (true) {
            if (externalSignal && externalSignal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            let response;
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

            let matchedKeyword = false;
            if (!networkError && settings.retryOnBodyKeywords && !retryableStatuses.has(response.status)) {
                matchedKeyword = await bodyMatchesKeyword(response, keywords);
            }

            const shouldRetryNetworkError = networkError && settings.retryOnNetworkError;
            const shouldRetryStatus = response && retryableStatuses.has(response.status);
            const shouldRetryBody = response && matchedKeyword;

            if (!shouldRetryNetworkError && !shouldRetryStatus && !shouldRetryBody) {
                // Success — but was it retried?
                if (attempt > 0) {
                    const reason = 'succeeded after ' + attempt + ' retries';
                    log(`Success after ${attempt} retries.`);
                    attemptHistory.push({
                        attempt: attempt,
                        result: 'success',
                        status: response ? response.status : null,
                        delayMs: 0,
                        timestamp: new Date().toISOString(),
                    });
                    addLogEntry({
                        type: 'success',
                        url: url,
                        method: (init && init.method) || 'GET',
                        status: response ? response.status : 200,
                        retries: attempt,
                        reason: reason,
                        totalDurationMs: Date.now() - startTime,
                        attempts: attemptHistory,
                    });
                }
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
                toastFinalFailure(`Still failing after ${attempt} retries (${reason}) — giving up.`);

                attemptHistory.push({
                    attempt: attempt + 1,
                    result: 'gave_up',
                    status: response ? response.status : null,
                    error: reason,
                    delayMs: 0,
                    timestamp: new Date().toISOString(),
                });

                addLogEntry({
                    type: 'fail',
                    url: url,
                    method: (init && init.method) || 'GET',
                    status: response ? response.status : 0,
                    retries: attempt,
                    reason: reason,
                    totalDurationMs: Date.now() - startTime,
                    attempts: attemptHistory,
                });

                if (networkError) throw networkError;
                return response;
            }

            const retryAfterHeader = response ? response.headers.get('retry-after') : null;
            const delay = computeDelay(attempt, settings, retryAfterHeader);

            const failReason = networkError
                ? networkError.message
                : shouldRetryBody
                    ? 'matched error keyword in body'
                    : `HTTP ${response.status}`;

            log(`Failed (${failReason}). Retry ${attempt + 1}/${settings.maxRetries} in ${Math.round(delay)}ms.`);

            attemptHistory.push({
                attempt: attempt + 1,
                result: 'retrying',
                status: response ? response.status : null,
                error: failReason,
                delayMs: Math.round(delay),
                retryAfterHeader: retryAfterHeader,
                timestamp: new Date().toISOString(),
            });

            attempt += 1;

            try {
                await sleep(delay, externalSignal);
            } catch (err) {
                throw err;
            }
        }
    };

    log('fetch() patched — retries on network errors, configured HTTP statuses, and body-keyword matches. Aborts (Stop button) are always respected. Logging enabled.');
}

function uninstallFetchPatch() {
    if (originalFetch) {
        window.fetch = originalFetch;
        originalFetch = null;
        log('fetch() restored to original.');
    }
}

// ─── Dashboard ─────────────────────────────────────────────────────

let dashboardFilter = 'all';

function buildDashboardHTML() {
    return `
    <div id="retry-dashboard-panel">
        <div class="retry-dashboard-inner">
            <div class="retry-dashboard-header">
                <div class="retry-dashboard-title">
                    <i class="fa-solid fa-rotate-right"></i> Retry On Error — Dashboard
                </div>
                <button class="retry-dashboard-close" id="retry_dashboard_close">
                    <i class="fa-solid fa-xmark"></i> Close
                </button>
            </div>

            <div class="retry-dashboard-stats" id="retry_dashboard_stats">
                <!-- Filled dynamically -->
            </div>

            <div class="retry-dashboard-filters">
                <button class="retry-filter-btn active" data-filter="all">All</button>
                <button class="retry-filter-btn" data-filter="success">Successes</button>
                <button class="retry-filter-btn" data-filter="fail">Failures</button>
                <button class="retry-clear-btn" id="retry_dashboard_clear">
                    <i class="fa-solid fa-trash"></i> Clear Logs
                </button>
            </div>

            <div class="retry-log-list" id="retry_dashboard_log_list">
                <!-- Filled dynamically -->
            </div>
        </div>
    </div>`;
}

function getFilteredLogs() {
    const settings = getSettings();
    let logs = settings.logs;
    if (dashboardFilter !== 'all') {
        logs = logs.filter((e) => e.type === dashboardFilter);
    }
    return logs;
}

function renderDashboardStats() {
    const settings = getSettings();
    const logs = settings.logs;
    const successes = logs.filter((e) => e.type === 'success').length;
    const failures = logs.filter((e) => e.type === 'fail').length;
    const totalRetries = logs.reduce((sum, e) => sum + (e.retries || 0), 0);

    $('#retry_dashboard_stats').html(`
        <div class="retry-stat-card success">
            <span class="retry-stat-value">${successes}</span>
            <span class="retry-stat-label">Succeeded</span>
        </div>
        <div class="retry-stat-card fail">
            <span class="retry-stat-value">${failures}</span>
            <span class="retry-stat-label">Failed</span>
        </div>
        <div class="retry-stat-card retries">
            <span class="retry-stat-value">${totalRetries}</span>
            <span class="retry-stat-label">Total Retries</span>
        </div>
        <div class="retry-stat-card">
            <span class="retry-stat-value">${logs.length}</span>
            <span class="retry-stat-label">Total Events</span>
        </div>
    `);
}

function formatTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString();
    } catch {
        return iso;
    }
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function renderDashboardLogs() {
    renderDashboardStats();
    const logs = getFilteredLogs();

    if (logs.length === 0) {
        $('#retry_dashboard_log_list').html(
            '<div class="retry-log-empty">No log entries yet. Retries will appear here when they occur.</div>',
        );
        return;
    }

    const html = logs
        .map((entry, index) => {
            const typeClass = entry.type === 'success' ? 'success' : 'fail';
            const iconClass =
                entry.type === 'success'
                    ? 'fa-solid fa-check-circle success'
                    : 'fa-solid fa-times-circle fail';
            const badgeText =
                entry.type === 'success'
                    ? `${entry.retries} retries`
                    : `gave up after ${entry.retries}`;
            const shortUrl = entry.url.length > 80 ? entry.url.slice(0, 77) + '...' : entry.url;

            const attemptsHtml =
                entry.attempts && entry.attempts.length > 0
                    ? `
                <div class="retry-log-attempts">
                    <div style="font-size:0.8em;opacity:0.6;margin-bottom:4px;">Attempt History:</div>
                    ${entry.attempts
                        .map((a) => {
                            const aIcon =
                                a.result === 'success'
                                    ? '<i class="fa-solid fa-check" style="color:#4caf50;"></i>'
                                    : a.result === 'gave_up'
                                        ? '<i class="fa-solid fa-flag" style="color:#f44336;"></i>'
                                        : '<i class="fa-solid fa-rotate-right" style="color:#ff9800;"></i>';
                            const statusStr = a.status ? `HTTP ${a.status}` : 'network error';
                            const delayStr = a.delayMs > 0 ? `wait ${a.delayMs}ms` : '';
                            return `
                        <div class="retry-log-attempt">
                            <span class="retry-log-attempt-num">${aIcon} #${a.attempt}</span>
                            <span style="flex:1;">${escapeHtml(a.error || statusStr)}</span>
                            <span class="retry-log-attempt-delay">${delayStr}</span>
                            <span style="opacity:0.4;font-size:0.9em;">${escapeHtml(formatTime(a.timestamp))}</span>
                        </div>`;
                        })
                        .join('')}
                </div>`
                    : '';

            return `
            <div class="retry-log-entry ${typeClass}" data-index="${index}">
                <div class="retry-log-summary" onclick="window.__retryToggleExpand(${index})">
                    <span class="retry-log-status-icon ${typeClass}"><i class="${iconClass}"></i></span>
                    <span class="retry-log-badge">${escapeHtml(badgeText)}</span>
                    <span class="retry-log-url" title="${escapeHtml(entry.url)}">${escapeHtml(shortUrl)}</span>
                    <span class="retry-log-time">${escapeHtml(formatTime(entry.timestamp))}</span>
                </div>
                <div class="retry-log-detail" id="retry-log-detail-${index}">
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">URL</span>
                        <span class="retry-log-detail-value mono">${escapeHtml(entry.url)}</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Method</span>
                        <span class="retry-log-detail-value">${escapeHtml(entry.method)}</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">HTTP Status</span>
                        <span class="retry-log-detail-value">${entry.status || 'N/A'}</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Result</span>
                        <span class="retry-log-detail-value" style="color:${entry.type === 'success' ? '#4caf50' : '#f44336'};">
                            ${entry.type === 'success' ? 'Succeeded after retries' : 'Failed — gave up'}
                        </span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Reason</span>
                        <span class="retry-log-detail-value">${escapeHtml(entry.reason)}</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Retry Count</span>
                        <span class="retry-log-detail-value">${entry.retries}</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Total Duration</span>
                        <span class="retry-log-detail-value">${entry.totalDurationMs}ms</span>
                    </div>
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">Timestamp</span>
                        <span class="retry-log-detail-value">${escapeHtml(formatTime(entry.timestamp))}</span>
                    </div>
                    ${attemptsHtml}
                </div>
            </div>`;
        })
        .join('');

    $('#retry_dashboard_log_list').html(html);
}

// Toggle expand for a log entry — exposed globally for inline onclick
window.__retryToggleExpand = function (index) {
    const $entry = $(`.retry-log-entry[data-index="${index}"]`);
    $entry.toggleClass('expanded');
};

function openDashboard() {
    if ($('#retry-dashboard-panel').length === 0) {
        $(document.body).append(buildDashboardHTML());

        $('#retry_dashboard_close').on('click', function () {
            $('#retry-dashboard-panel').hide();
        });

        $('.retry-filter-btn').on('click', function () {
            $('.retry-filter-btn').removeClass('active');
            $(this).addClass('active');
            dashboardFilter = $(this).data('filter');
            renderDashboardLogs();
        });

        $('#retry_dashboard_clear').on('click', function () {
            if (confirm('Clear all retry logs? This cannot be undone.')) {
                clearLogs();
            }
        });
    }
    renderDashboardLogs();
    $('#retry-dashboard-panel').show();
}

// ─── Nav Button ────────────────────────────────────────────────────

function addNavButton() {
    // ST uses #extensionsMenu for the wand dropdown, and #sheld .nav-toggle
    // for the right-side nav. We add a button to the top nav bar that matches
    // existing nav buttons. ST's nav buttons live in #rightNavPanel or the
    // top bar #top-bar. The most reliable approach: add to the extensions
    // menu dropdown (wand menu) since that's where extension actions live.
    //
    // We also add a standalone floating button as a fallback so the dashboard
    // is always accessible even if the wand menu structure changes.

    // Approach 1: Add to extensions wand menu
    const navItem = $(`
        <div id="retry_dashboard_nav" class="menu_button" title="Retry On Error Dashboard" tabindex="0">
            <i class="fa-solid fa-rotate-right"></i>
            <span>Retry Logs</span>
        </div>
    `);

    // Try to add to the extensions menu dropdown
    if ($('#extensionsMenu').length > 0) {
        $('#extensionsMenu').append(navItem);
    }

    // Approach 2: Also add a button in the extensions settings panel
    const settingsButton = $(`
        <div class="marginBot10">
            <div class="menu_button menu_button_icon" id="retry_dashboard_open_btn" style="width:100%;text-align:center;">
                <i class="fa-solid fa-chart-bar"></i>
                <span>Open Retry Dashboard</span>
            </div>
        </div>
    `);

    // Insert after the retry-on-error settings drawer
    // (added in renderSettingsUI, we append after it)

    // Click handlers for both
    $(document).on('click', '#retry_dashboard_nav, #retry_dashboard_open_btn', function (e) {
        e.preventDefault();
        openDashboard();
    });

    // Store the settings button to be appended in renderSettingsUI
    window.__retrySettingsButton = settingsButton;
}

// ─── Settings UI ───────────────────────────────────────────────────

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

                <hr>
                <div class="marginBot10">
                    <div class="menu_button menu_button_icon" id="retry_dashboard_open_btn" style="width:100%;text-align:center;cursor:pointer;">
                        <i class="fa-solid fa-chart-bar"></i>
                        <span>Open Retry Dashboard</span>
                    </div>
                </div>

                <label>Max log entries
                    <input id="retryerr_maxLogEntries" class="text_pole" type="number" min="50" max="10000" step="50" value="${settings.maxLogEntries}">
                </label>

                <small>Hitting SillyTavern's Stop button always cancels retries immediately —
                this extension never fights the abort signal. No notification appears while
                retries are in progress — only one, if every retry attempt is exhausted and it
                finally gives up. All retry events (successes and failures) are logged to the
                dashboard — click "Open Retry Dashboard" to view them in detail.</small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // Wire up settings inputs
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
    $('#retryerr_maxLogEntries').on('input', function () {
        getSettings().maxLogEntries = Number($(this).val());
        saveSettingsDebounced();
    });

    // Dashboard open button (in settings panel)
    $('#retry_dashboard_open_btn').on('click', function (e) {
        e.preventDefault();
        openDashboard();
    });
}

// ─── Init ──────────────────────────────────────────────────────────

jQuery(async () => {
    getSettings();
    installFetchPatch();
    renderSettingsUI();
    addNavButton();
    log('Initialized. Logs array has', getSettings().logs.length, 'entries.');
});
