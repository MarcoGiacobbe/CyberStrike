// V17: dentro il container il browser REALE di hackbrowser deve aprire una
// pagina. Non Chromium a mano: il codice di lancio di stealth.ts, quello che
// usa davvero `bb hunt`.
// Controprova: a HEAD (senza prepareHome) questo test deve fallire, perche'
// il crash e' quello misurato il 2026-09-28 (rc=133, crashpad --database).
import { connect } from "../src/stealth"

const URL = "data:text/html,<h1>BB-OK-DAL-CONTAINER</h1>"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "POSITIVO-OK" : "POSITIVO-KO"}  ${name}${detail ? `  ${detail}` : ""}`)
  if (!ok) failures++
}

// Precondizione reale del bug: HOME esiste, e' scrivibile, ma non ha .config.
const home = process.env.HOME
check("HOME presente", !!home, home ?? "(assente)")
if (home) {
  const { existsSync, mkdirSync, rmSync } = await import("fs")
  const cfg = home + "/.config"
  // La pulizia e' best-effort: se `.config` e' root-owned (creata da Docker col
  // mount di un volume) non si puo' rimuovere da `hunter`, e va bene cosi':
  // quello e' proprio lo stato rotto da cui si parte.
  try {
    if (existsSync(cfg)) rmSync(cfg, { recursive: true, force: true })
  } catch {}
  mkdirSync(home, { recursive: true })
  check("HOME scrivibile", (() => {
    try { mkdirSync(home + "/.probe", { recursive: true }); rmSync(home + "/.probe", { recursive: true, force: true }); return true } catch { return false }
  })())
  // Se `.config` esiste ma non e' scrivabile, il bug e' ancora li': e' esattamente
  // lo stato che faceva crashare Chromium.
  check("HOME/.config assente o scrivibile", !existsSync(cfg) || (() => {
    try { mkdirSync(cfg + "/.probe", { recursive: true }); rmSync(cfg + "/.probe", { recursive: true, force: true }); return true } catch { return false }
  })())
}

let browser: Awaited<ReturnType<typeof connect>> | undefined
try {
  browser = await connect({ headless: true })
  check("browser lanciato senza crash", true)
  const page = await browser.newPage()
  await page.goto(URL, { waitUntil: "domcontentloaded" })
  const text = await page.textContent("h1")
  check("pagina resa", text === "BB-OK-DAL-CONTAINER", `h1=${JSON.stringify(text)}`)
  await page.close()
} catch (e) {
  check("browser lanciato senza crash", false, String(e).split("\n")[0])
} finally {
  await browser?.close().catch(() => {})
}

console.log(failures === 0 ? "\nV17: PASS" : `\nV17: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
