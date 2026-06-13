// @ts-nocheck
// src/tools/browser.ts
// Full browser control via Puppeteer + existing Chrome/Chromium installation.
// No Chromium download needed — uses the system browser.
import { registry } from './registry.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
let _browser = null;
const _pages = new Map(); // sessionId → Page
let _defaultSession = 'default';
/** Resolve the system browser executable path. */
function findChrome() {
    const candidates = [
        process.env['BROWSER_PATH'],
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ].filter(Boolean);
    for (const p of candidates) {
        if (existsSync(p))
            return p;
    }
    throw new Error('No Chrome/Chromium found. Set BROWSER_PATH env or install Chrome.');
}
async function getBrowser() {
    if (_browser)
        return _browser;
    const puppeteer = await import('puppeteer-core');
    _browser = await puppeteer.default.launch({
        executablePath: findChrome(),
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });
    _browser.on('disconnected', () => { _browser = null; _pages.clear(); });
    return _browser;
}
async function getPage(session) {
    const existing = _pages.get(session);
    if (existing && !existing.isClosed())
        return existing;
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    _pages.set(session, page);
    return page;
}
/** Extract readable text from page, stripping scripts/styles. */
async function getPageText(page, maxChars = 8000) {
    return page.evaluate((max) => {
        // Remove noise elements
        document.querySelectorAll('script,style,nav,footer,header,[role="banner"],[role="navigation"]')
            .forEach(el => el.remove());
        const text = document.body?.innerText ?? document.body?.textContent ?? '';
        return text.replace(/\s{3,}/g, '\n\n').trim().slice(0, max);
    }, maxChars);
}

// ── Liveness watchdog for browser operations ─────────────────────────────────
// Instead of a simple timeout, we check if Chrome is actually doing work.
// If the Chrome process is idle (CPU ≈ 0%) for too long, it's stuck.

/**
 * Get the CPU usage percentage of the Chrome browser process.
 * Returns -1 if unable to determine (process not found, etc).
 */
function getChromeCpuUsage(): number {
    if (!_browser) return -1;
    try {
        const pid = _browser.process()?.pid;
        if (!pid) return -1;
        // Get CPU% of the process tree (main + children)
        const output = execSync(
            `ps -p ${pid} -o %cpu= 2>/dev/null || echo "-1"`,
            { timeout: 2000, encoding: 'utf-8' },
        ).trim();
        return parseFloat(output) || 0;
    } catch {
        return -1;
    }
}

/**
 * Wrap a Puppeteer promise with a liveness watchdog.
 * 
 * Instead of a hard timeout, this periodically checks Chrome's CPU usage.
 * The operation is considered "stuck" only if Chrome has been idle
 * (CPU < threshold) for `stallSeconds` consecutive checks.
 * 
 * If Chrome is actively working (CPU > threshold), the watchdog resets
 * and lets the operation continue indefinitely.
 * 
 * @param promise - The Puppeteer operation to monitor
 * @param label - Description for error messages
 * @param stallSeconds - How many seconds of consecutive idleness before aborting (default: 30)
 * @param checkIntervalMs - How often to check CPU (default: 5000ms)
 * @param cpuThreshold - CPU% below which Chrome is considered idle (default: 2%)
 */
async function withLivenessGuard<T>(
    promise: Promise<T>,
    label: string,
    {
        stallSeconds = 30,
        checkIntervalMs = 5000,
        cpuThreshold = 2,
    } = {},
): Promise<T> {
    let consecutiveIdleChecks = 0;
    const maxIdleChecks = Math.ceil(stallSeconds / (checkIntervalMs / 1000));
    let resolved = false;

    return new Promise<T>((resolve, reject) => {
        const timer = setInterval(() => {
            if (resolved) return;

            const cpu = getChromeCpuUsage();
            if (cpu < 0) {
                // Can't determine CPU — don't kill, just skip this check
                return;
            }

            if (cpu < cpuThreshold) {
                consecutiveIdleChecks++;
                if (consecutiveIdleChecks >= maxIdleChecks) {
                    resolved = true;
                    clearInterval(timer);
                    reject(new Error(
                        `[liveness-guard] Browser appears stuck during "${label}": ` +
                        `Chrome CPU < ${cpuThreshold}% for ${stallSeconds}s consecutively. ` +
                        `Aborting to prevent infinite hang.`
                    ));
                }
            } else {
                // Chrome is working — reset the idle counter
                consecutiveIdleChecks = 0;
            }
        }, checkIntervalMs);

        promise.then(
            (val) => { resolved = true; clearInterval(timer); resolve(val); },
            (err) => { resolved = true; clearInterval(timer); reject(err); },
        );
    });
}

// ── Tool handler ─────────────────────────────────────────────────────────────
registry.register({
    name: 'browser',
    description: [
        'Control a headless Chrome browser. Supports multi-step web interaction.',
        'Actions:',
        '  navigate  — Go to URL, returns page title + text content',
        '  content   — Get current page text without navigating',
        '  click     — Click an element by CSS selector',
        '  type      — Type text into an input field (CSS selector)',
        '  eval      — Run JavaScript in the page, returns result',
        '  screenshot — Take a screenshot, returns base64 PNG',
        '  back      — Go back in browser history',
        '  close     — Close the browser session',
        'Use session param to maintain multiple independent browser tabs.',
        'Tip: Use navigate → eval/click/type for multi-step workflows like logging in or filling forms.',
    ].join('\n'),
    schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['navigate', 'content', 'click', 'type', 'eval', 'screenshot', 'back', 'close'],
                description: 'Browser action to perform',
            },
            url: {
                type: 'string',
                description: 'URL for navigate action',
            },
            selector: {
                type: 'string',
                description: 'CSS selector for click/type actions',
            },
            text: {
                type: 'string',
                description: 'Text to type for type action',
            },
            js: {
                type: 'string',
                description: 'JavaScript expression to evaluate for eval action',
            },
            session: {
                type: 'string',
                description: 'Browser session/tab name (default: "default"). Use different names for parallel tabs.',
            },
            waitFor: {
                type: 'string',
                description: 'CSS selector to wait for after navigation (optional)',
            },
            maxChars: {
                type: 'number',
                description: 'Max characters of page text to return (default: 8000)',
            },
        },
        required: ['action'],
    },
    handler: async (params) => {
        const action = params['action'];
        const session = params['session'] ?? _defaultSession;
        const maxChars = Number(params['maxChars'] ?? 8000);
        try {
            // ── close ──────────────────────────────────────────────────────────────
            if (action === 'close') {
                const page = _pages.get(session);
                if (page && !page.isClosed())
                    await page.close();
                _pages.delete(session);
                // If no pages left, close browser too
                if (_pages.size === 0 && _browser) {
                    await _browser.close();
                    _browser = null;
                }
                return { type: 'text', text: `Session "${session}" closed.` };
            }
            const page = await getPage(session);
            // ── navigate ───────────────────────────────────────────────────────────
            if (action === 'navigate') {
                const url = params['url'];
                if (!url)
                    return { type: 'error', error: 'url is required for navigate' };
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                const waitFor = params['waitFor'];
                if (waitFor) {
                    await page.waitForSelector(waitFor, { timeout: 5000 }).catch(() => { });
                }
                const title = await page.title();
                const text = await withLivenessGuard(
                    getPageText(page, maxChars),
                    `getPageText after navigate to ${url}`,
                );
                return { type: 'text', text: `[${title}]\n\n${text}` };
            }
            // ── content ────────────────────────────────────────────────────────────
            if (action === 'content') {
                const title = await page.title();
                const text = await withLivenessGuard(
                    getPageText(page, maxChars),
                    'getPageText (content action)',
                );
                return { type: 'text', text: `[${title}]\n\n${text}` };
            }
            // ── click ──────────────────────────────────────────────────────────────
            if (action === 'click') {
                const selector = params['selector'];
                if (!selector)
                    return { type: 'error', error: 'selector is required for click' };
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
                const title = await page.title();
                const text = await withLivenessGuard(
                    getPageText(page, maxChars),
                    `getPageText after click ${selector}`,
                );
                return { type: 'text', text: `[Clicked: ${selector}]\n[${title}]\n\n${text}` };
            }
            // ── type ───────────────────────────────────────────────────────────────
            if (action === 'type') {
                const selector = params['selector'];
                const text = params['text'];
                if (!selector)
                    return { type: 'error', error: 'selector is required for type' };
                await page.waitForSelector(selector, { timeout: 5000 });
                await page.click(selector);
                await page.type(selector, text ?? '', { delay: 30 });
                return { type: 'text', text: `Typed into ${selector}.` };
            }
            // ── eval ───────────────────────────────────────────────────────────────
            if (action === 'eval') {
                const js = params['js'];
                if (!js)
                    return { type: 'error', error: 'js is required for eval' };
                const result = await withLivenessGuard(
                    page.evaluate((code) => eval(code), js),
                    `eval: ${js.slice(0, 80)}`,
                    { stallSeconds: 45 }, // eval may do complex work, give more time
                );
                const output = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
                return { type: 'text', text: output };
            }
            // ── screenshot ─────────────────────────────────────────────────────────
            if (action === 'screenshot') {
                const buf = await page.screenshot({ type: 'png', fullPage: false });
                const b64 = buf.toString('base64');
                // Return as multimodal envelope — full image for LLM vision analysis
                return {
                    type: 'multimodal',
                    content: [
                        { type: 'text', text: `[Screenshot captured: ${buf.length} bytes, PNG]` },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'auto' } },
                    ],
                    textSummary: `[Screenshot taken, ${buf.length} bytes PNG. Image sent to vision model for analysis.]`,
                };
            }
            // ── back ───────────────────────────────────────────────────────────────
            if (action === 'back') {
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
                const title = await page.title();
                const text = await withLivenessGuard(
                    getPageText(page, maxChars),
                    'getPageText after back',
                );
                return { type: 'text', text: `[Back → ${title}]\n\n${text}` };
            }
            return { type: 'error', error: `Unknown action: ${action}` };
        }
        catch (err) {
            return { type: 'error', error: `Browser error (${action}): ${err.message}` };
        }
    },
    toolset: ['default'],
    requiresApproval: false,
    executionMode: 'sequential', // browser actions are stateful, must be sequential
});
