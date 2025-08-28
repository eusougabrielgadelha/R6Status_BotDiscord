// scrape.js (ESM)
import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const EXTRA_WAIT = Number(process.env.EXTRA_WAIT_MS || 12000);
const HEADFUL    = !!process.env.HEADFUL;
const EXE        = process.env.CHROME_EXE || undefined;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryDismissOverlays(page) {
  const selectors = [
    'button[aria-label="Accept all"]',
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
    'button:has-text("Aceitar")',
    '.cc-allow', '.osano-cm-accept',
  ];
  for (const sel of selectors) {
    try { const el = await page.$(sel); if (el) { await el.click({delay:50}); await sleep(800);} } catch {}
  }
}

export async function scrapeDailyBlocks(username) {
  const url = `https://r6.tracker.network/r6siege/profile/ubi/${encodeURIComponent(username)}/overview`;

  const browser = await puppeteerExtra.launch({
    headless: !HEADFUL ? 'new' : false,
    executablePath: EXE, // use Chrome se CHROME_EXE estiver setado
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-gpu',
      '--lang=en-US,en;q=0.9,pt-BR;q=0.8','--window-size=1366,900'
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8' });

    await page.goto(url, { waitUntil: ['domcontentloaded','networkidle2'], timeout: 90000 });
    await tryDismissOverlays(page);

    // espera “na marra” a hidratação do JS
    await sleep(EXTRA_WAIT);

    // scroll simples para garantir lazy load de blocos
    for (let i=0;i<3;i++){ await page.evaluate(()=>window.scrollBy(0, window.innerHeight)); await sleep(800); }

    const blocks = await page.evaluate(() => {
      function toNumber(s, suffix) {
        if (s == null) return null;
        return Number(String(s).replace(suffix||'','').replace('%','').trim());
      }
      function readStatWithin(root, label) {
        const labs = Array.from(root.querySelectorAll('.name-value .stat-name .truncate'));
        const lab = labs.find(el => el.textContent?.trim() === label);
        if (!lab) return null;
        const cont = lab.closest('.name-value');
        const val  = cont?.querySelector('.stat-value span');
        return val?.textContent?.trim() ?? null;
      }

      const headers = Array.from(document.querySelectorAll('header'));
      const out = [];

      for (const h of headers) {
        const dateEl = h.querySelector('.text-18');
        const dateLabel = dateEl?.textContent?.trim() || null;

        const winsRaw   = h.querySelector('.value.text-green')?.textContent?.trim() || null; // "1 W"
        const lossesRaw = h.querySelector('.value.text-red')?.textContent?.trim()   || null; // "3 L"
        const kdRaw = readStatWithin(h, 'K/D');
        const kRaw  = readStatWithin(h, 'K');
        const dRaw  = readStatWithin(h, 'D');
        const hsRaw = readStatWithin(h, 'HS%');

        // ignora headers sem conteúdo útil
        if (!winsRaw && !lossesRaw && !kdRaw && !kRaw && !dRaw && !hsRaw) continue;

        out.push({
          dateLabel,
          wins_raw: winsRaw, losses_raw: lossesRaw,
          wins:   toNumber(winsRaw, ' W'),
          losses: toNumber(lossesRaw, ' L'),
          kd:     kdRaw ? Number(kdRaw) : null,
          k:      toNumber(kRaw),
          d:      toNumber(dRaw),
          hs_pct: toNumber(hsRaw),
        });
      }
      return out;
    });

    return { url, blocks };
  } finally {
    // se estiver em HEADFUL para depurar, você pode comentar este close e fechar manualmente
    if (!HEADFUL) await browser.close();
  }
}
