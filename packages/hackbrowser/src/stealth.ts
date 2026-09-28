import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { chromium, type Browser, type LaunchOptions, type BrowserContextOptions } from "playwright"

const PLATFORM_ARGS =
  process.platform === "linux"
    ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-zygote"]
    : []

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-first-run",
  // Stability: prevent renderer throttling/death on window drag/resize/minimize
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-component-update",
  ...PLATFORM_ARGS,
]

/**
 * D PREPARA LA HOME PRIMA DI LANCIARE IL BROWSER.
 *
 * Misurato il 2026-09-28 dentro cyberstrike-bounty:sandbox: Chromium andava in
 * crash con `Trace/breakpoint trap (core dumped)`, rc=133, e in stderr:
 *   `chrome_crashpad_handler: --database is required`
 * Causa: `$HOME` era /home/hunter, directory esistente e scrivibile ma VUOTA.
 * Chromium/crashpad vuole `$HOME/.config` gia' presente e non la crea da solo:
 * se manca muore all'avvio, prima ancora di aprire una pagina. Non e' un
 * problema di shm (--disable-dev-shm-usage c'era gia' e non cambia nulla) ne'
 * di permessi (la home e' scrivibile).
 *
 * Il fix e' qui e non nel launcher dello sandbox perche' lo stesso crash si
 * verifica su qualunque host con una home vuota, non solo in container: se
 * l'utente lancia `cyberstrike bb hunt` fuori dal container deve funzionare
 * uguale. `mkdirSync` ricorsivo e' idempotente e non falla se il percorso
 * esiste gia'.
 */
function prepareHome(): void {
  const home = process.env.HOME
  if (!home) return // Windows / ambienti senza HOME: Chromium usa altre path
  try {
    mkdirSync(join(home, ".config"), { recursive: true })
  } catch {
    // Se la home non e' scrivibile non e' un motivo per non lanciare il
    // browser: si lascia Chromium dire cosa non va invece di fallire qui.
  }
}

export function launchOptions(headless: boolean): LaunchOptions {
  // Headful: maximize to the REAL screen instead of forcing a fixed 1920x1080 window, which
  // overflows (and hides the login bar) on any screen smaller than that. Maximized fits every
  // screen and looks natural. Paired with contextOptions' viewport:null so Chrome — not
  // Playwright — owns the window size.
  const args = headless ? LAUNCH_ARGS : [...LAUNCH_ARGS, "--start-maximized"]
  return { headless, args }
}

/**
 * NOTA sul profilo del browser: non passare `--user-data-dir` a
 * `chromium.launch()`. Playwright lo rifiuta esplicitamente (misurato il
 * 2026-09-28):
 *   Error: launch: Pass userDataDir parameter to
 *   'browserType.launchPersistentContext(userDataDir, options)' instead of
 *   specifying '--user-data-dir' argument
 * E non si puo' tornare indietro facilmente: `launch()` restituisce un
 * `Browser`, il profilo persistente si ottiene solo da
 * `launchPersistentContext()`, che restituisce un `BrowserContext` con firma
 * diversa. I caller di `connect()` usano `browser.newPage()`, quindi passare
 * al persistent context cambierebbe il tipo in ogni chiamata.
 * Conclusione: il default di Playwright va bene. Il crash che si voleva
 * evitare non era del profilo ma di `$HOME/.config` inesistente o non
 * scrivibile, e quello si risolve con `prepareHome()` e con il launcher dello
 * sandbox (che non deve far creare a Docker directory root-owned sotto $HOME).
 */
export function findSystemChrome(): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
  return candidates.find((p) => existsSync(p))
}

export async function connect(opts: { cdp?: string; headless: boolean }): Promise<Browser> {
  prepareHome()
  if (opts.cdp) return chromium.connectOverCDP(opts.cdp)
  const base = launchOptions(opts.headless)
  const chrome = findSystemChrome()
  return chromium.launch({ ...base, executablePath: chrome })
}

export function contextOptions(
  headless = true,
  identity?: { userAgent?: string; extraHeaders?: Record<string, string> },
): BrowserContextOptions {
  // Report the REAL Chrome UA (no spoof). A faked Windows UA over the real macOS/Linux
  // navigator.platform is a glaring cross-check mismatch that makes detection easier, not
  // harder; only automation tells are hidden (INIT_SCRIPT). The real host stays consistent.
  // Exception: bug bounty identity — when the program requires a self-identifying UA,
  // we override (disclosed automation, not stealth).
  const opts: BrowserContextOptions = {
    viewport: headless ? { width: 1920, height: 1080 } : null,
    screen: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  }
  if (identity?.userAgent) opts.userAgent = identity.userAgent
  if (identity?.extraHeaders) {
    opts.extraHTTPHeaders = { ...opts.extraHTTPHeaders, ...identity.extraHeaders }
  }
  return opts
}

export const INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });

for (const key of Object.keys(window)) {
  if (/^cdc_/.test(key)) delete window[key];
}

if (navigator.plugins.length === 0) {
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
}

if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
}

Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

if (!navigator.connection) {
  Object.defineProperty(navigator, 'connection', {
    get: () => ({
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      saveData: false,
    }),
  });
}

Object.defineProperty(screen, 'width', { get: () => 1920 });
Object.defineProperty(screen, 'height', { get: () => 1080 });
Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
// NOTE: window.inner/outerWidth/Height are intentionally NOT spoofed. They must reflect
// the REAL window so (a) the crawler's own geometry stays correct — scanner occlusion /
// offscreen / scroll and the injected panel/login-bar clamp all read innerWidth — and
// (b) they stay consistent with the actual rendered viewport (a faked 1920 over a smaller
// real window is itself a detectable fingerprint mismatch). Monitor size is spoofed via
// screen.* above; the window is launched at 1920x1080 (launchOptions/contextOptions) so on
// a normal host innerWidth is already ~1920 with no spoof needed.

// NOTE: WebGL vendor/renderer are intentionally NOT spoofed. The real GPU string is a
// genuine, self-consistent value; a faked 'Intel Iris OpenGL Engine' (an old macOS GPU
// name, in the outdated non-ANGLE format) contradicts both the platform and modern Chrome's
// 'ANGLE (...)' renderer format, which is more detectable than reporting the truth.

// NOTE: canvas toDataURL is intentionally NOT perturbed. The previous per-call XOR of one
// pixel's alpha mutated the canvas on every read, so the same canvas hashed differently each
// time — an unstable canvas is itself a bot signal (a real canvas is stable). Canvas-noise is
// an anti-TRACKING measure, not anti-bot-detection (not what cleared #76); reporting the real,
// stable canvas is the consistent choice, matching the UA/WebGL/window decisions above.

const origQuery = window.Permissions?.prototype?.query;
if (origQuery) {
  window.Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return origQuery.call(this, params);
  };
}

if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
`
