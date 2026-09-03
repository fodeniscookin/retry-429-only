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
        safeRenderDashboardLogs();
    }
}

function clearLogs() {
    const settings = getSettings();
    settings.logs = [];
    saveSettingsDebounced();
    safeRenderDashboardLogs();
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

// SillyTavern's own housekeeping endpoints. Retrying/logging these can cause
// a feedback loop: a log entry triggers saveSettingsDebounced() -> fetch ->
// which would itself be logged, forever.
const INTERNAL_URL_PATTERNS = [
    '/api/settings/save',
    '/api/settings/get',
    '/api/chats/save',
    '/csrf-token',
];

function isInternalRequest(url) {
    return INTERNAL_URL_PATTERNS.some((p) => url.includes(p));
}

// A request whose body is a stream (or a consumed Request object) cannot be
// replayed, so retrying it would send an empty body.
function isReplayable(input, init) {
    const body = init && init.body;
    if (body && typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
    if (typeof Request !== 'undefined' && input instanceof Request && input.bodyUsed) return false;
    return true;
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

        const requestUrl = extractUrl(input);

        if (!settings.enabled || isInternalRequest(requestUrl) || !isReplayable(input, init)) {
            return originalFetch(input, init);
        }

        const externalSignal = init && init.signal ? init.signal : null;
        const retryableStatuses = getRetryableStatusSet(settings);
        const keywords = getKeywordList(settings);
        const url = requestUrl;
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

// ─── Critical CSS (injected from JS) ───────────────────────────────
// style.css may fail to load (manifest/caching issues, custom CSS order).
// Without it the panel renders as an unstyled block at the bottom of the
// page and looks like "nothing happened". These rules are self-contained
// and use !important so nothing in the theme can hide the panel.
function injectCriticalCss() {
    if (document.getElementById('retry-dashboard-critical-css')) return;
    const css = `
#retry-dashboard-panel {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 2147483000 !important;
    background: rgba(0,0,0,0.88) !important;
    overflow-y: auto !important;
    opacity: 1 !important;
    visibility: visible !important;
    pointer-events: auto !important;
}
#retry-dashboard-panel[hidden] { display: none !important; }
#retry-dashboard-panel .retry-dashboard-inner {
    max-width: 1100px; margin: 40px auto; padding: 20px;
    color: var(--SmartThemeBodyColor, #e0e0e0);
}
#retry-dashboard-panel .retry-dashboard-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; padding-bottom: 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, #333);
}
#retry-dashboard-panel .retry-dashboard-close,
#retry-dashboard-panel .retry-filter-btn,
#retry-dashboard-panel .retry-clear-btn {
    cursor: pointer; background: rgba(255,255,255,0.08);
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 8px; padding: 6px 14px;
    color: var(--SmartThemeBodyColor, #e0e0e0);
}
#retry-dashboard-panel .retry-dashboard-stats,
#retry-dashboard-panel .retry-dashboard-filters {
    display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;
}
#retry-dashboard-panel .retry-log-entry {
    background: rgba(0,0,0,0.3);
    border: 1px solid var(--SmartThemeBorderColor, #444);
    border-radius: 8px; margin-bottom: 8px; overflow: hidden;
}
#retry-dashboard-panel .retry-log-summary {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer;
}
#retry-dashboard-panel .retry-log-detail { display: none; padding: 0 14px 14px 44px; }
#retry-dashboard-panel .retry-log-entry.expanded .retry-log-detail { display: block; }
#retry-dashboard-panel .retry-log-empty { opacity: 0.6; padding: 20px; text-align: center; }
`;
    const style = document.createElement('style');
    style.id = 'retry-dashboard-critical-css';
    style.textContent = css;
    document.head.appendChild(style);
}


let dashboardFilter = 'all';

function buildDashboardHTML() {
    return `
    <div id="retry-dashboard-panel" hidden>
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
            const entryUrl = entry.url || '(unknown)';
            const shortUrl = entryUrl.length > 80 ? entryUrl.slice(0, 77) + '...' : entryUrl;

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
                <div class="retry-log-summary">
                    <span class="retry-log-status-icon ${typeClass}"><i class="${iconClass}"></i></span>
                    <span class="retry-log-badge">${escapeHtml(badgeText)}</span>
                    <span class="retry-log-url" title="${escapeHtml(entryUrl)}">${escapeHtml(shortUrl)}</span>
                    <span class="retry-log-time">${escapeHtml(formatTime(entry.timestamp))}</span>
                </div>
                <div class="retry-log-detail" id="retry-log-detail-${index}">
                    <div class="retry-log-detail-row">
                        <span class="retry-log-detail-label">URL</span>
                        <span class="retry-log-detail-value mono">${escapeHtml(entryUrl)}</span>
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

// Toggle expand for a log entry (delegated — CSP-safe, no inline onclick)
$(document).on('click', '.retry-log-summary', function () {
    $(this).closest('.retry-log-entry').toggleClass('expanded');
});

function ensureDashboardPanel() {
    injectCriticalCss();
    if (document.getElementById('retry-dashboard-panel') === null) {
        $(document.body).append(buildDashboardHTML());

        $(document).on('click', '#retry_dashboard_close', function () {
            closeDashboard();
        });

        // Use document-level delegated handlers so they survive re-renders
        $(document).on('click', '.retry-filter-btn', function () {
            $('.retry-filter-btn').removeClass('active');
            $(this).addClass('active');
            dashboardFilter = $(this).data('filter');
            safeRenderDashboardLogs();
        });

        $(document).on('click', '#retry_dashboard_clear', function () {
            if (confirm('Clear all retry logs? This cannot be undone.')) {
                clearLogs();
            }
        });

        $(document).on('keydown.retryDashboard', function (e) {
            if (e.key === 'Escape') closeDashboard();
        });

        log('Dashboard panel built and event handlers attached.');
    }
    return document.getElementById('retry-dashboard-panel');
}

function safeRenderDashboardLogs() {
    try {
        renderDashboardLogs();
    } catch (err) {
        // A single malformed log entry must never keep the panel from opening.
        console.error('[Retry On Error] Failed to render logs:', err);
        $('#retry_dashboard_log_list').html(
            '<div class="retry-log-empty">Could not render the log list (' +
            escapeHtml(err && err.message ? err.message : String(err)) +
            ').<br>Use "Clear Logs" to reset it.</div>',
        );
    }
}

function openDashboard() {
    try {
        log('openDashboard() called');
        const panel = ensureDashboardPanel();
        if (!panel) throw new Error('panel could not be created');

        // Show the panel FIRST. Rendering the log list happens afterwards so a
        // rendering error can never leave the panel invisible ("nothing happens").
        // Re-parent to <html> so a transformed/overflow-hidden <body> (common on
        // mobile themes) cannot clip or hide the fixed overlay.
        document.documentElement.appendChild(panel);
        panel.removeAttribute('hidden');
        panel.style.cssText =
            'display:block;position:fixed;top:0;left:0;right:0;bottom:0;width:100%;' +
            'height:100vh;height:100dvh;max-height:100dvh;' +
            'z-index:2147483000;background:rgba(0,0,0,0.92);overflow-y:auto;' +
            '-webkit-overflow-scrolling:touch;opacity:1;visibility:visible;pointer-events:auto;';

        safeRenderDashboardLogs();

        const rect = panel.getBoundingClientRect();
        log('Dashboard opened. size=', Math.round(rect.width) + 'x' + Math.round(rect.height),
            'computedDisplay=', getComputedStyle(panel).display);
    } catch (err) {
        console.error('[Retry On Error] openDashboard failed:', err);
        try {
            if (typeof toastr !== 'undefined') {
                toastr.error(String(err && err.message ? err.message : err), 'Retry Dashboard failed to open');
            } else {
                alert('Retry Dashboard failed to open: ' + err);
            }
        } catch { /* ignore */ }
    }
}

function closeDashboard() {
    const panel = document.getElementById('retry-dashboard-panel');
    if (panel) {
        panel.style.display = 'none';
        panel.setAttribute('hidden', 'hidden');
    }
}

// Escape hatch for debugging: run openRetryDashboard() in the browser console.
window.openRetryDashboard = openDashboard;
window.closeRetryDashboard = closeDashboard;

// ─── Nav Button ────────────────────────────────────────────────────

function addNavButton() {
    // Add a floating button to the bottom-right of the screen.
    // This is the most reliable access point — it doesn't depend on
    // #extensionsMenu existing at init time, and it's always visible.
    const floatingBtn = $(`
        <div id="retry_dashboard_fab"
             style="position:fixed;bottom:20px;right:20px;z-index:9999;
                    cursor:pointer;background:var(--black30a,rgba(0,0,0,0.5));
                    border:1px solid var(--SmartThemeBorderColor,#555);
                    border-radius:50%;width:48px;height:48px;
                    display:flex;align-items:center;justify-content:center;
                    color:var(--SmartThemeBodyColor,#e0e0e0);font-size:1.2em;
                    transition:background 0.2s;box-shadow:0 2px 8px rgba(0,0,0,0.3);"
             title="Retry On Error Dashboard">
            <i class="fa-solid fa-rotate-right"></i>
        </div>
    `);

    $(document).on('click', '#retry_dashboard_fab', function (e) {
        e.preventDefault();
        e.stopPropagation();
        log('Floating button clicked.');
        openDashboard();
    });

    // Append floating button — try immediately, retry if body not ready
    function appendFloating() {
        if (document.body) {
            $(document.body).append(floatingBtn);
            log('Floating dashboard button appended.');
        } else {
            setTimeout(appendFloating, 200);
        }
    }
    appendFloating();

    // Also try to add to the extensions wand menu, but with retry logic
    // since #extensionsMenu might not exist yet at init time.
    function tryAddToWandMenu(retries) {
        if (retries <= 0) return;
        if ($('#extensionsMenu').length > 0 && $('#retry_dashboard_nav').length === 0) {
            const navItem = $(`
                <div id="retry_dashboard_nav" class="list-group-item flex-container flexGap5 interactable"
                     title="Retry On Error Dashboard" tabindex="0"
                     style="cursor:pointer;display:flex;align-items:center;gap:6px;">
                    <i class="fa-solid fa-rotate-right"></i>
                    <span>Retry Logs</span>
                </div>
            `);
            $('#extensionsMenu').append(navItem);
            log('Nav button added to extensions wand menu.');
        } else {
            setTimeout(() => tryAddToWandMenu(retries - 1), 500);
        }
    }
    tryAddToWandMenu(40);
    // The wand menu can be re-created by SillyTavern; keep re-adding the item.
    setInterval(() => {
        if ($('#extensionsMenu').length > 0 && $('#retry_dashboard_nav').length === 0) {
            tryAddToWandMenu(1);
        }
    }, 3000);

    // Native capture-phase listener: fires before any other handler and works
    // even if a theme/extension stops propagation on the wand menu.
    if (!window.__retryNavListener) {
        window.__retryNavListener = true;
        const captureTrigger = function (e) {
            const target = e.target && e.target.closest
                ? e.target.closest('#retry_dashboard_nav, #retry_dashboard_open_btn, #retry_dashboard_fab')
                : null;
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            log('Dashboard trigger clicked (capture):', target.id);
            const menu = document.getElementById('extensionsMenu');
            if (menu) menu.style.display = 'none';
            openDashboard();
        };
        document.addEventListener('click', captureTrigger, true);
        // Some mobile webviews (Brave/Android) swallow the synthetic click on
        // menu_button divs — touchend guarantees the dashboard still opens.
        document.addEventListener('touchend', captureTrigger, true);
    }

    // Delegated click handler for BOTH the settings-panel button and the
    // wand-menu item. The wand-menu item previously had no handler at all,
    // which is why clicking the dashboard icon did nothing.
    $(document).on('click', '#retry_dashboard_open_btn, #retry_dashboard_nav', function (e) {
        e.preventDefault();
        e.stopPropagation();
        log('Dashboard button clicked:', this.id);
        // Close the wand menu / options popup if it is open.
        $('#extensionsMenu').hide();
        $('#options').hide();
        openDashboard();
    });

    // Keyboard accessibility for the wand-menu item.
    $(document).on('keydown', '#retry_dashboard_nav', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });
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

    // Dashboard open button handler is delegated in addNavButton() —
    // no direct binding needed here.
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
    safely('injectCriticalCss', injectCriticalCss);
    safely('installFetchPatch', installFetchPatch);
    // Settings UI must never be able to take the nav/dashboard buttons down
    // with it — each step is isolated.
    safely('renderSettingsUI', renderSettingsUI);
    safely('addNavButton', addNavButton);

    // Safety net: if anything above raced with SillyTavern's own DOM setup,
    // make sure the floating dashboard button still ends up on the page.
    setTimeout(() => {
        if (document.getElementById('retry_dashboard_fab') === null) {
            safely('addNavButton (retry)', addNavButton);
        }
    }, 4000);

    log('Initialized. Logs array has', getSettings().logs.length, 'entries.');
});
