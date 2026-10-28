import { Actor, log } from 'apify';
import { chromium, BrowserContext, Page } from 'playwright';
import { authenticator } from 'otplib';

interface ActorInput {
    email: string;
    password: string;
    // The 2FA secret. Named "encryptedKey" to match the orchestration's vocabulary,
    // but it is a standard TOTP secret (base32) or an otpauth:// URI.
    encryptedKey: string;
    loginUrl?: string;
    headless?: boolean;
}

interface ActorOutput {
    success: boolean;
    finalUrl: string | null;
    cookieCount: number;
    // The Playwright storage state (cookies + localStorage). This is the object the
    // appointment-booking actor expects in its "storageState" input, verbatim.
    storageState: unknown | null;
    sessionUrl: string | null;
    capturedAt: string;
    error: string | null;
}

const DEFAULT_LOGIN_URL = 'https://app.tjbdigitalservices.com';

// A logged-in GHL dashboard always renders the global-search opener; the appointment
// actor keys off the same element, so we reuse it as the "we're in" signal.
const DASHBOARD_SELECTOR = '#globalSearchOpener';
const DASHBOARD_URL = (url: string) => /\/(dashboard|v2\/location|agency_dashboard)/.test(url);
const LOGGED_OUT_URL = (url: string) => /[/?&](login|logout|oauth)(\/|$|[=&?])/.test(url);

const EMAIL_SELECTORS = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input#email',
    'input[placeholder*="email" i]',
    'input[formcontrolname*="email" i]',
];
const PASSWORD_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input#password',
    'input[placeholder*="password" i]',
    'input[formcontrolname*="password" i]',
];
const SIGNIN_SELECTORS = [
    'button:has-text("Sign in")',
    'button:has-text("Sign In")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button[type="submit"]',
    'input[type="submit"]',
];
// Elements that pick the authenticator/TOTP verification method on the 2FA chooser.
const TOTP_METHOD_SELECTORS = [
    'button:has-text("Authenticator")',
    'button:has-text("Authentication app")',
    'div[role="button"]:has-text("Authenticator")',
    'label:has-text("Authenticator")',
    'li:has-text("Authenticator")',
    '[class*="option"]:has-text("Authenticator")',
    'button:has-text("TOTP")',
    'text=/authenticat(or|ion app)/i',
];
// The code field, whether a single box or the first of several one-char boxes.
const CODE_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name="code" i]',
    'input#code',
    'input[placeholder*="code" i]',
    'input[formcontrolname*="code" i]',
    'input[type="text"][maxlength="6"]',
    'input[type="tel"][maxlength="6"]',
    'input[type="number"][maxlength="6"]',
];
const VERIFY_SELECTORS = [
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Next")',
    'button[type="submit"]',
];
const CODE_ERROR = /invalid|incorrect|wrong|expired|does ?n.?t match|try again/i;

async function retry<T>(fn: () => Promise<T>, { attempts = 3, delayMs = 1000, label = 'operation' } = {}): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            if (i === attempts - 1) throw err;
            log.warning(`${label} failed (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${delayMs}ms...`);
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs *= 2;
        }
    }
    throw new Error('Unreachable');
}

/**
 * Pulls the raw TOTP seed out of whatever form the "encryptedKey" arrives in:
 * a bare base32 secret, a secret with spaces/dashes, or a full otpauth:// URI.
 */
function extractTotpSecret(raw: string): string {
    const trimmed = (raw || '').trim();
    if (!trimmed) throw new Error('encryptedKey (TOTP secret) is empty.');
    if (/^otpauth:\/\//i.test(trimmed)) {
        const secret = new URL(trimmed).searchParams.get('secret');
        if (!secret) throw new Error('otpauth:// URI has no "secret" parameter.');
        return secret.replace(/[\s-]/g, '').toUpperCase();
    }
    return trimmed.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Returns a TOTP code that still has a comfortable margin before it rotates. A
 * code generated with only a couple of seconds left can expire between typing
 * and submission, so if the current 30s window is nearly over we wait for the
 * next one before generating.
 */
async function freshTotp(secret: string): Promise<string> {
    const remaining = authenticator.timeRemaining();
    if (remaining < 6) {
        log.info(`TOTP window has ${remaining}s left — waiting for the next code to avoid expiry mid-submit.`);
        await new Promise((r) => setTimeout(r, (remaining + 1) * 1000));
    }
    const code = authenticator.generate(secret);
    log.info(`Generated TOTP code (valid ~${authenticator.timeRemaining()}s).`);
    return code;
}

/** Saves a screenshot (and optionally the raw HTML) to the key-value store for debugging. */
async function snapshot(page: Page, name: string, withHtml = false): Promise<void> {
    try {
        const store = await Actor.openKeyValueStore();
        await store.setValue(name, await page.screenshot({ type: 'jpeg', quality: 60 }), { contentType: 'image/jpeg' });
        if (withHtml) {
            await store.setValue(`${name}-html`, await page.content(), { contentType: 'text/html' });
        }
        log.info(`Saved debug snapshot: ${name}`);
    } catch (err: any) {
        log.warning(`Could not save snapshot "${name}": ${err.message}`);
    }
}

/** Fills the first visible field matching any of the candidate selectors. */
async function fillFirst(page: Page, selectors: string[], value: string, label: string, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
                await loc.click({ timeout: 5000 }).catch(() => {
                    /* fill still works if the click is intercepted */
                });
                await loc.fill('');
                await loc.fill(value);
                log.info(`Filled ${label} via "${sel}".`);
                return;
            }
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`Could not find ${label} field. Tried: ${selectors.join(', ')}`);
}

/** Clicks the first visible element matching any candidate selector. Returns false if none appear. */
async function clickFirst(page: Page, selectors: string[], label: string, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of selectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
                await loc.click({ timeout: 5000 });
                log.info(`Clicked ${label} via "${sel}".`);
                return true;
            }
        }
        await page.waitForTimeout(400);
    }
    log.warning(`No ${label} element appeared within ${timeoutMs}ms.`);
    return false;
}

async function isDashboard(page: Page): Promise<boolean> {
    if (DASHBOARD_URL(page.url())) return true;
    return page
        .locator(DASHBOARD_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false);
}

async function waitForDashboard(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isDashboard(page)) return true;
        await page.waitForTimeout(500).catch(() => {
            /* page may be mid-navigation */
        });
    }
    return false;
}

/** True once a field to type the TOTP code into is on screen. */
async function codeFieldVisible(page: Page): Promise<boolean> {
    for (const sel of CODE_SELECTORS) {
        if (
            await page
                .locator(sel)
                .first()
                .isVisible()
                .catch(() => false)
        ) {
            return true;
        }
    }
    // Several one-character boxes are a code field too.
    return (await page.locator('input[maxlength="1"]').count()) >= 4;
}

/**
 * The 2FA screen offers email / phone / authenticator. If a code field is not
 * already showing, pick the authenticator (TOTP) option and confirm it.
 */
async function selectTotpMethod(page: Page): Promise<void> {
    if (await codeFieldVisible(page)) {
        log.info('Code field already visible — no method chooser to handle.');
        return;
    }
    log.info('Looking for the authenticator/TOTP verification option...');
    const picked = await clickFirst(page, TOTP_METHOD_SELECTORS, 'authenticator method option', 10000);
    if (picked) {
        await page.waitForTimeout(800);
        // Some flows need a Continue/Confirm after choosing the method.
        if (!(await codeFieldVisible(page))) {
            await clickFirst(page, VERIFY_SELECTORS, 'method confirm button', 5000);
        }
    } else {
        log.warning('Could not find an explicit authenticator option — assuming the code field will be shown.');
    }
}

/** Types the 6-digit code into a single field or into separate one-char boxes. */
async function enterCode(page: Page, code: string): Promise<boolean> {
    for (const sel of CODE_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
            await loc.click();
            await loc.fill('');
            await loc.fill(code);
            log.info(`Entered code via "${sel}".`);
            return true;
        }
    }

    const boxes = page.locator('input[maxlength="1"]');
    const count = await boxes.count();
    if (count >= code.length) {
        for (let i = 0; i < code.length; i++) {
            await boxes.nth(i).fill(code[i]);
        }
        log.info(`Entered code across ${code.length} single-digit boxes.`);
        return true;
    }

    // Last resort: type into whatever is focused.
    log.warning('No recognised code field — typing the code into the focused element.');
    await page.keyboard.type(code, { delay: 60 });
    return true;
}

async function buildContext(input: ActorInput): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
    const headless = input.headless !== false && process.env.HEADLESS !== 'false';
    const sharedArgs = ['--disable-blink-features=AutomationControlled', '--disable-gpu'];
    const cloudArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--disable-software-rasterizer',
        '--disable-translate',
        '--disable-hang-monitor',
    ];

    log.info(`Launching Chromium (${headless ? 'headless' : 'headed'}, ${Actor.isAtHome() ? 'cloud' : 'local'})...`);
    const browser = await chromium.launch({
        headless,
        args: Actor.isAtHome() ? [...sharedArgs, ...cloudArgs] : sharedArgs,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    return { context, close: () => browser.close() };
}

// --- Main execution ---
await Actor.init();

const input = await Actor.getInput<ActorInput>();

if (!input?.email || !input?.password || !input?.encryptedKey) {
    throw new Error('Input must contain "email", "password" and "encryptedKey".');
}

const loginUrl = (input.loginUrl || DEFAULT_LOGIN_URL).trim();
const secret = extractTotpSecret(input.encryptedKey);
// GHL uses standard 6-digit / 30s TOTP; a window of 1 tolerates minor clock skew.
authenticator.options = { digits: 6, step: 30, window: 1 };

log.info('Starting GHL session login', { loginUrl, email: input.email });

const { context, close } = await buildContext(input);

const output: ActorOutput = {
    success: false,
    finalUrl: null,
    cookieCount: 0,
    storageState: null,
    sessionUrl: null,
    capturedAt: new Date().toISOString(),
    error: null,
};

try {
    const page = await context.newPage();

    log.info('Navigating to login page...');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(2000);

    // Already signed in (e.g. a warm profile)? Skip straight to capture.
    if (await isDashboard(page)) {
        log.info('Already on a dashboard — no login needed.');
    } else {
        await snapshot(page, 'step-1-login-page');

        log.info('Entering email and password...');
        await fillFirst(page, EMAIL_SELECTORS, input.email, 'email');
        await fillFirst(page, PASSWORD_SELECTORS, input.password, 'password');

        if (!(await clickFirst(page, SIGNIN_SELECTORS, 'Sign in button'))) {
            // No button matched — submit the form with Enter as a fallback.
            log.info('No Sign in button matched — pressing Enter to submit.');
            await page.keyboard.press('Enter');
        }

        // Give the page a moment to either land on the dashboard (no 2FA) or the 2FA screen.
        await page.waitForTimeout(3000);
        await snapshot(page, 'step-2-after-signin', true);

        if (await isDashboard(page)) {
            log.info('Logged in without a 2FA prompt.');
        } else {
            log.info('Handling 2FA (TOTP)...');
            await selectTotpMethod(page);
            await snapshot(page, 'step-3-2fa-screen', true);

            // Enter the code, submit, and retry with a fresh code if it is rejected
            // (clock skew or a code that rotated at the boundary).
            const reached = await retry(
                async () => {
                    const code = await freshTotp(secret);
                    await enterCode(page, code);
                    // Many 6-box inputs auto-submit on the last digit; a Verify button
                    // covers the single-field flows.
                    await clickFirst(page, VERIFY_SELECTORS, 'Verify button', 5000);

                    const ok = await waitForDashboard(page, 20000);
                    if (ok) return true;

                    const errText = await page
                        .locator(`text=${CODE_ERROR}`)
                        .first()
                        .textContent()
                        .catch(() => null);
                    throw new Error(
                        errText ? `2FA rejected: "${errText.trim()}"` : 'Dashboard not reached after submitting code.',
                    );
                },
                { attempts: 3, delayMs: 2000, label: 'submit TOTP code' },
            );
            if (!reached) throw new Error('2FA did not complete.');
        }
    }

    // Confirm we really are in before capturing.
    if (!(await waitForDashboard(page, 30000))) {
        await snapshot(page, 'error-no-dashboard', true);
        if (LOGGED_OUT_URL(page.url())) {
            throw new Error(`Still on a login/logout URL after the flow: ${page.url()}`);
        }
        throw new Error(`Dashboard was never reached (final URL: ${page.url()}).`);
    }

    log.info(`Dashboard reached: ${page.url()}`);
    // Let any post-login tokens settle into cookies/localStorage before the snapshot.
    await page.waitForTimeout(3000);

    const storageState = await context.storageState();
    output.success = true;
    output.finalUrl = page.url();
    output.cookieCount = storageState.cookies.length;
    output.storageState = storageState;

    // Save the session to the key-value store so n8n can fetch it at a stable URL,
    // and push it to the dataset so it is also in the run's output.
    const store = await Actor.openKeyValueStore();
    await store.setValue('SESSION', storageState);
    output.sessionUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/SESSION`;

    log.info(`Session captured: ${storageState.cookies.length} cookies, ${storageState.origins.length} origin(s).`);
    log.info(`Session available at: ${output.sessionUrl}`);
} catch (err: any) {
    output.error = err.message;
    log.error(`Login failed: ${err.message}`);
    await snapshot(await context.pages()[0], 'error-final', true).catch(() => {
        /* best effort */
    });
} finally {
    await Actor.pushData(output);
    await close().catch(() => {
        /* already closing */
    });
}

await Actor.exit();
