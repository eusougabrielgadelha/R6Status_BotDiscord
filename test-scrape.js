// test-scrape.js (ESM + stealth + debug)
// Uso:
//   set HEADFUL=1 && set EXTRA_WAIT_MS=12000 && set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe && node test-scrape.js gabrielgadelham

import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

puppeteerExtra.use(StealthPlugin());

const username   = process.argv[2] || 'gabrielgadelham';
const EXTRA_WAIT = Number(process.env.EXTRA_WAIT_MS || 12000);
const HEADFUL    = !!process.env.HEADFUL;
const EXE        = process.env.CHROME_EXE || undefined;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function saveDebug(page, tag='debug') {
  try {
    await page.screenshot({ path: `${tag}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`${tag}.html`, html, 'utf8');
    console.log(`Salvei ${tag}.png e ${tag}.html`);
  } catch (e) {
    console.log('Falha ao salvar debug:', e.message);
  }
}

async function run() {
  const url = `https://r6.tracker.network/r6siege/profile/ubi/${encodeURIComponent(username)}/overview`;

  const browser = await puppeteerExtra.launch({
    headless: !HEADFUL ? 'new' : false,
    executablePath: EXE,   // usa Chrome se informado; senão, Chromium do puppeteer
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--lang=en-US,en;q=0.9,pt-BR;q=0.8',
      '--window-size=1366,900',
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8' });

    console.log('Abrindo:', url);
    await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 90000 });

    // Se houver overlay/banners, tente fechar
    const clickCandidates = [
      'button[aria-label="Accept all"]',
      'button:has-text("Accept All")',
      'button:has-text("I agree")',
      'button:has-text("Aceitar")',
      'button.cookie-accept',
      '.cc-allow', '.osano-cm-accept', '#onetrust-accept-btn-handler',
    ];
    for (const sel of clickCandidates) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ delay: 50 }); await sleep(800); }
      } catch {}
    }

    // Espera "na marra" o preenchimento
    console.log('Aguardando render (EXTRA_WAIT =', EXTRA_WAIT, 'ms)…');
    await sleep(EXTRA_WAIT);

    // Rolagens para disparar lazy-loading, se houver
    for (let i=0;i<3;i++){
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(800);
    }

    // Tenta encontrar o PRIMEIRO BLOCO DIÁRIO baseado na estrutura que você enviou
    const data = await page.evaluate(() => {
      // 1) Primeiro tente pegar o <header> que tenha um .text-18 com mês abreviado (ex.: "Aug 27")
      const month = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
      const reDate = new RegExp(`\\b${month}\\s+\\d{1,2}\\b`);
      const headers = Array.from(document.querySelectorAll('header'));
      let root = null;
      for (const h of headers) {
        const dateEl = h.querySelector('.text-18');
        const t = (dateEl?.textContent || '').trim();
        if (reDate.test(t)) { root = h; break; }
      }
      // fallback: se não achou, pega o primeiro header
      if (!root) root = headers[0] || document.body;

      const q  = (sel, r=root) => r.querySelector(sel);
      const qa = (sel, r=root) => Array.from(r.querySelectorAll(sel));

      function readStatWithin(label) {
        const labs = qa('.name-value .stat-name .truncate');
        const lab = labs.find(el => el.textContent?.trim() === label);
        if (!lab) return null;
        const cont = lab.closest('.name-value');
        const val = cont?.querySelector('.stat-value span');
        return val?.textContent?.trim() ?? null;
      }

      function toNumber(s, suffix) {
        if (s == null) return null;
        return Number(String(s).replace(suffix || '', '').replace('%','').trim());
      }

      const dateText  = q('.text-18')?.textContent?.trim() || null;
      const winsRaw   = q('.value.text-green')?.textContent?.trim() || null; // "1 W"
      const lossesRaw = q('.value.text-red')?.textContent?.trim() || null;   // "3 L"
      const kdRaw     = readStatWithin('K/D');
      const kRaw      = readStatWithin('K');
      const dRaw      = readStatWithin('D');
      const hsRaw     = readStatWithin('HS%');

      return {
        dateText,
        raw: { winsRaw, lossesRaw, kdRaw, kRaw, dRaw, hsRaw },
        parsed: {
          wins:   toNumber(winsRaw, ' W'),
          losses: toNumber(lossesRaw, ' L'),
          kd:     kdRaw ? Number(kdRaw) : null,
          k:      toNumber(kRaw),
          d:      toNumber(dRaw),
          hs_pct: toNumber(hsRaw)
        }
      };
    });

    // Se vier vazio, salva debug p/ entendermos o HTML real que chegou
    const allNull = !data?.raw?.winsRaw && !data?.raw?.kdRaw && !data?.raw?.kRaw && !data?.raw?.dRaw && !data?.raw?.hsRaw;
    if (allNull) {
      console.log('⚠️ Não achei os elementos. Vou salvar screenshot e HTML pra inspecionar…');
      await saveDebug(page, 'debug1');
    }

    console.log({
      username,
      url,
      date: data?.dateText || null,
      ...data
    });
  } catch (e) {
    console.error('Erro no scraping:', e);
  } finally {
    if (!HEADFUL) await browser.close();
  }
}

run();
