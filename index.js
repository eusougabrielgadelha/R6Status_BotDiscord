// index.js
// ------------------------------------------------------------
// Bot R6 Tracker — Relatórios & Rankings (TRN) com Slash + Prefixo
// Agendamentos: diário (relatório), semanal/mensal (rankings) por guild
// Persistência: SQLite (jogadores e horários)
// Scraping: Cheerio diretamente do perfil TRN
// ⚙️ Anti-403: Playwright headless "farmer" para obter cookies reais
// ------------------------------------------------------------

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  Partials,
} from 'discord.js';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import * as cheerio from 'cheerio';

// -------------------------------
// .env
// -------------------------------
const {
  DISCORD_TOKEN,
  GUILD_ID,
  GUILD_IDS,
  PREFIX = '!',
} = process.env;

const TZ = process.env.TZ || process.env.TIMEZONE || 'America/Sao_Paulo';

if (!DISCORD_TOKEN) {
  console.error('❌ Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

// -------------------------------
// DB (SQLite)
// -------------------------------
const db = new Database('r6bot.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  guild_id TEXT NOT NULL,
  username TEXT NOT NULL,
  PRIMARY KEY (guild_id, username)
);

CREATE TABLE IF NOT EXISTS schedules (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  time_str TEXT NOT NULL,     -- "HH:mm" (24h)
  PRIMARY KEY (guild_id)
);
`);

const qInsertPlayer   = db.prepare('INSERT OR IGNORE INTO players (guild_id, username) VALUES (?, ?)');
const qDeletePlayer   = db.prepare('DELETE FROM players WHERE guild_id = ? AND username = ?');
const qListPlayers    = db.prepare('SELECT username FROM players WHERE guild_id = ? ORDER BY username COLLATE NOCASE');
const qUpsertSchedule = db.prepare(`
  INSERT INTO schedules (guild_id, channel_id, time_str)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, time_str=excluded.time_str
`);
const qGetSchedule    = db.prepare('SELECT channel_id, time_str FROM schedules WHERE guild_id = ?');
const qDelSchedule    = db.prepare('DELETE FROM schedules WHERE guild_id = ?');
const qAllSchedules   = db.prepare('SELECT guild_id FROM schedules');

// -------------------------------
// Util: UA pool
// -------------------------------
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// -------------------------------
// Playwright Cookie Farmer (dinâmico)
// -------------------------------
const PW_OPTS = {
  headless: String(process.env.TRN_HEADLESS || 'true').toLowerCase() !== 'false',
  ttlMin: Number(process.env.TRN_COOKIE_TTL_MIN || 30),
  cfWaitMs: Number(process.env.TRN_CF_WAIT_MS || 4000),
  navTimeoutMs: Number(process.env.TRN_NAV_TIMEOUT_MS || 25000),
};

let _farmerState = {
  cookie: null,
  ua: null,
  fetchedAt: 0, // epoch ms
};

async function loadPlaywright() {
  try {
    // import dinâmico para não travar caso o pacote não esteja instalado
    const mod = await import('playwright');
    return mod;
  } catch (e) {
    console.warn('⚠️ Playwright não instalado. Defina TRN_COOKIE no .env ou instale: npm i playwright');
    return null;
  }
}

function cookieExpired() {
  if (!_farmerState.cookie) return true;
  const ageMin = (Date.now() - _farmerState.fetchedAt) / 60000;
  return ageMin >= PW_OPTS.ttlMin;
}

async function refreshCookiesWithPlaywright(sampleProfile = 'gabrielgadelham') {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('Playwright indisponível');

  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  const ua = pickUA();

  console.log('🧪 Iniciando Playwright (headless:', PW_OPTS.headless, ') para obter cookies…');
  const browser = await pw.chromium.launch({ headless: PW_OPTS.headless, args });
  const context = await browser.newContext({ userAgent: ua });
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(PW_OPTS.navTimeoutMs);

    // Passo 1: homepage (gera cookies de CF/consent)
    await page.goto('https://tracker.gg/r6siege', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(PW_OPTS.cfWaitMs);

    // Passo 2: visitar um perfil real para garantir que a sessão passa no challenge
    // (usa um nick sample, pode ser qualquer válido)
    const url = `https://tracker.gg/r6siege/profile/ubisoft/${encodeURIComponent(sampleProfile)}/overview`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(PW_OPTS.cfWaitMs);

    const cookies = await context.cookies();
    const jar = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (!jar) throw new Error('Nenhum cookie obtido');

    _farmerState.cookie = jar;
    _farmerState.ua = ua;
    _farmerState.fetchedAt = Date.now();

    console.log(`✅ Cookies obtidos (${cookies.length} entradas). UA: ${ua.slice(0, 40)}…`);
    return { cookie: jar, ua };
  } finally {
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

async function getCookieJar(force = false) {
  // 1) Se tem TRN_COOKIE no .env, usa ele (manual vence o farmer)
  const manual = process.env.TRN_COOKIE?.trim();
  if (manual) return { cookie: manual, ua: pickUA(), source: 'env' };

  // 2) Farmer automático
  if (force || cookieExpired()) {
    try {
      const r = await refreshCookiesWithPlaywright();
      return { cookie: r.cookie, ua: r.ua, source: 'farmer' };
    } catch (e) {
      console.warn('⚠️ Falha ao gerar cookies com Playwright:', e?.message || e);
      // ainda podemos tentar sem cookie (pode cair em 403, mas tentaremos mesmo assim)
      return { cookie: '', ua: pickUA(), source: 'none' };
    }
  }
  return { cookie: _farmerState.cookie, ua: _farmerState.ua || pickUA(), source: 'farmer-cache' };
}

// -------------------------------
// Scraper TRN (perfil público)
// -------------------------------
const MONTHS_EN = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function toISOFromLabel(label, now = DateTime.now().setZone(TZ)) {
  const m = /^\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s*$/.exec(label || '');
  if (!m) return null;
  let year = now.year;
  const month = MONTHS_EN[m[1]];
  const day = Number(m[2]);
  let dt = DateTime.fromObject({ year, month, day }, { zone: TZ });
  if (now.month === 1 && month === 12) dt = dt.minus({ years: 1 });
  return dt.toISODate();
}

async function fetchOnce(url, ua, cookie) {
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': new URL(url).origin + '/',
    'Origin': new URL(url).origin,
  };
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(url, { headers, redirect: 'follow' });
  const text = await res.text();

  return { status: res.status, ok: res.ok, html: text };
}

function looksLikeChallenge(html) {
  return /cf-browser-verification|Attention Required|Just a moment|__cf_chl_captcha_tk__|why_captcha/i.test(html);
}

/**
 * fetchProfileHtml(username)
 * - tenta r6.tracker.network e tracker.gg
 * - usa TRN_COOKIE (manual) ou cookies do Playwright farmer
 * - em 403/429/challenge, força refresh dos cookies e re-tenta
 */
async function fetchProfileHtml(username) {
  const cookie   = process.env.TRN_COOKIE?.trim();
  const basePref = (process.env.TRN_BASE || 'auto').toLowerCase();

  // plataforma base (pc|xbox|psn). aceitamos alguns aliases
  const PLATFORM_ALIASES = {
    ubisoft: 'pc', ubi: 'pc', uplay: 'pc',
    pc: 'pc',
    xbox: 'xbox', xbl: 'xbox',
    ps: 'psn', psn: 'psn', playstation: 'psn'
  };
  const platIn = (process.env.TRN_PLATFORM || 'pc').toLowerCase();
  const plat = PLATFORM_ALIASES[platIn] || 'pc';

  const nameEnc = encodeURIComponent(username);

  // ==== NOVOS CANDIDATES ====
  // tracker.gg — caminho "ubisoft" (funciona para vários perfis)
  const uTrkUbiOverview = `https://tracker.gg/r6siege/profile/ubisoft/${nameEnc}/overview`;
  // tracker.gg — caminho por plataforma normal
  const uTrkPlatOverview = `https://tracker.gg/r6siege/profile/${plat}/${nameEnc}/overview`;
  // r6.tracker.network — caminho “ubi” (matches)
  const uR6UbiMatches = `https://r6.tracker.network/r6siege/profile/ubi/${nameEnc}/matches`;
  // r6.tracker.network — caminho por plataforma normal
  const uR6PlatProfile = `https://r6.tracker.network/profile/${plat}/${nameEnc}`;

  let candidates;
  if (basePref === 'tracker') {
    candidates = [uTrkUbiOverview, uTrkPlatOverview, uR6UbiMatches, uR6PlatProfile];
  } else if (basePref === 'r6') {
    candidates = [uR6PlatProfile, uR6UbiMatches, uTrkPlatOverview, uTrkUbiOverview];
  } else {
    // auto (recomendado)
    candidates = [uTrkUbiOverview, uTrkPlatOverview, uR6UbiMatches, uR6PlatProfile];
  }
  // remove duplicatas
  candidates = [...new Set(candidates)];

  // pool de User-Agents reais
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  let lastErr;
  for (const url of candidates) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const ua = UAS[(attempt - 1) % UAS.length];
      const headers = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': new URL(url).origin + '/',
        'Origin':  new URL(url).origin,
      };
      if (cookie) headers['Cookie'] = cookie;

      try {
        const res = await fetch(url, { headers, redirect: 'follow' });
        if (res.status === 403 || res.status === 429 || res.status === 503) {
          lastErr = new Error(`HTTP ${res.status}`);
          await delay(600 * attempt + Math.floor(Math.random() * 400));
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          break; // tenta o próximo candidate
        }
        const html = await res.text();
        if (/cf-browser-verification|Attention Required|Just a moment/i.test(html)) {
          lastErr = new Error('Cloudflare challenge');
          await delay(700 * attempt);
          continue;
        }
        return { url, html };
      } catch (e) {
        lastErr = e;
        await delay(500 * attempt);
      }
    }
  }

  const hint = cookie
    ? 'Verifique se TRN_COOKIE ainda é válido (pode expirar).'
    : 'Configure TRN_COOKIE ou ative o Playwright para farmar cookies.';
  throw new Error(`Falha ao carregar perfil ${username}: ${lastErr?.message || 'bloqueado'} — ${hint}`);
}

/**
 * scrapeDailyBlocks(username)
 * → { url, blocks: [ { dateLabel, iso, wins, losses, k, d, hs_pct } ] }
 */
async function scrapeDailyBlocks(username) {
  const { url, html } = await fetchProfileHtml(username);
  const $ = cheerio.load(html);

  const blocks = [];
  $('div.col-span-full.grid.grid-cols-subgrid.gap-5').each((_, section) => {
    const header = $(section).find('header .text-18.font-bold.text-secondary').first().text().trim();
    const iso = toISOFromLabel(header);
    if (!iso) return;

    let wins = 0, losses = 0, kSum = 0, dSum = 0;
    let hsAcc = 0, hsN = 0;

    $(section).find('.v3-match-row').each((__, row) => {
      const $row = $(row);
      const isWin = $row.hasClass('v3-match-row--win');
      if (isWin) wins++; else losses++;

      // K / D
      const kdList = $row.find('.v3-separate-slash .value');
      let k = 0, d = 0;
      if (kdList.length >= 2) {
        k = parseInt($(kdList[0]).text().trim(), 10) || 0;
        d = parseInt($(kdList[1]).text().trim(), 10) || 0;
      } else {
        const kdTxt = $row.find('.stat-name:contains("K/D")').parent().find('.stat-value').first().text().trim();
        const kd = parseFloat(kdTxt.replace(',', '.')) || 0;
        d = kd > 0 ? 1 : 0;
        k = Math.round(kd * d);
      }
      kSum += k;
      dSum += d;

      // HS%
      const hsTxt = $row
        .find('.stat-name:contains("HS")')
        .parent()
        .find('.stat-value')
        .first()
        .text()
        .trim()
        .replace('%', '')
        .replace(',', '.');
      const hs = parseFloat(hsTxt);
      if (!Number.isNaN(hs)) { hsAcc += hs; hsN += 1; }
    });

    const hs_pct = hsN > 0 ? (hsAcc / hsN) : 0;
    blocks.push({ dateLabel: header, iso, wins, losses, k: kSum, d: dSum, hs_pct });
  });

  return { url, blocks };
}

// ---------- Helpers para o HEADER do dia ----------
function yesterdayLabel(now = DateTime.now().setZone(TZ)) {
  return now.minus({ days: 1 }).setLocale('en-US').toFormat('MMM d'); // "Aug 28"
}

function findHeaderForLabel($, label) {
  let target = null;
  $('header').each((_, el) => {
    const txt =
      $(el).find('div[class*="text-18"][class*="font-bold"][class*="text-secondary"]').first().text().trim();
    if (txt.toLowerCase() === String(label).toLowerCase()) { target = $(el); return false; }
  });
  return target;
}

function readHeaderNumber($, header, key) {
  const name = header
    .find('.stat-hor .name-value .stat-name .truncate')
    .filter((_, el) => $(el).text().trim() === key)
    .first()
    .closest('.name-value');

  if (!name.length) return NaN;
  const raw = name.find('.stat-value .truncate').first().text().trim();
  const clean = raw.replace('%', '').trim().replace(',', '.');
  return Number(clean);
}

function extractDayStatsFromHtml(html, label) {
  const $ = cheerio.load(html);
  const header = findHeaderForLabel($, label);
  if (!header || !header.length) return null;

  let wins = 0, losses = 0;
  header.find('.stat-list .value').each((_, el) => {
    const txt = $(el).text().trim();
    const n = parseInt(txt.replace(/\D+/g, ''), 10) || 0;
    if (/W/i.test(txt)) wins = n;
    if (/L/i.test(txt)) losses = n;
  });

  const kd = readHeaderNumber($, header, 'K/D');
  const k  = readHeaderNumber($, header, 'K');
  const d  = readHeaderNumber($, header, 'D');
  const hs = readHeaderNumber($, header, 'HS%');

  return { wins, losses, k, d, kd, hs };
}

// -------------------------------
// Janelas
// -------------------------------
function filterBlocksByWindow(blocks, start, end) {
  return blocks
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ }).endOf('day');
      return dt >= start.startOf('day') && dt <= end.endOf('day');
    });
}

function filterBlocksByRange(blocks, range, now = DateTime.now().setZone(TZ)) {
  const today = now.startOf('day');
  let start;
  if (range === 'day') start = today;
  else if (range === 'week') start = today.minus({ days: 6 });
  else if (range === 'month') start = today.minus({ days: 29 });
  else start = today;
  const end = today.endOf('day');
  return filterBlocksByWindow(blocks, start, end);
}

function getCanonicalWindow(kind, now = DateTime.now().setZone(TZ)) {
  if (kind === 'day') {
    const start = now.startOf('day');
    return { start, end: start.endOf('day') };
  }
  if (kind === 'week') {
    const prev = now.minus({ weeks: 1 });
    return { start: prev.startOf('week'), end: prev.endOf('week') };
  }
  if (kind === 'month') {
    const prev = now.minus({ months: 1 });
    return { start: prev.startOf('month'), end: prev.endOf('month') };
  }
  const start = now.startOf('day');
  return { start, end: start.endOf('day') };
}

function getYesterdayWindow(now = DateTime.now().setZone(TZ)) {
  const y = now.minus({ days: 1 }).startOf('day');
  return { start: y, end: y.endOf('day') };
}

// -------------------------------
// Agregação
// -------------------------------
function aggregate(blocks) {
  let totalK = 0, totalD = 0, totalWins = 0, totalLosses = 0;
  let hsShotsEst = 0;

  for (const b of blocks) {
    if (Number.isFinite(b.k)) totalK += b.k;
    if (Number.isFinite(b.d)) totalD += b.d;
    if (Number.isFinite(b.wins)) totalWins += b.wins;
    if (Number.isFinite(b.losses)) totalLosses += b.losses;
    if (Number.isFinite(b.hs_pct) && Number.isFinite(b.k)) {
      hsShotsEst += (b.hs_pct / 100) * b.k;
    }
  }

  const kdRaw = totalD > 0 ? totalK / totalD : (totalK > 0 ? Infinity : 0);
  const kd = Number.isFinite(kdRaw) ? kdRaw : 0;
  const hsPct = totalK > 0 ? (hsShotsEst / totalK) * 100 : 0;

  return { wins: totalWins, losses: totalLosses, k: totalK, d: totalD, kd, hs_pct: hsPct, days: blocks.length };
}

// -------------------------------
function embedReport(rangeTitle, username, url, agg) {
  return new EmbedBuilder()
    .setTitle(`R6 — ${rangeTitle} • ${username}`)
    .setURL(url)
    .addFields(
      { name: 'W/L', value: `${agg.wins} W • ${agg.losses} L`, inline: true },
      { name: 'K/D', value: (agg.kd ?? 0).toFixed(2), inline: true },
      { name: 'K · D', value: `${agg.k} · ${agg.d}`, inline: true },
      { name: 'HS%', value: `${(agg.hs_pct ?? 0).toFixed(1)}%`, inline: true },
      { name: 'Dias', value: `${agg.days}`, inline: true },
    )
    .setTimestamp(new Date());
}

function embedRanking(rangeTitle, rankings) {
  const fmt = (title, arr, f) =>
    `**${title}**\n` + (arr.length ? arr.map((r, i) => `${i === 0 ? '🏆 ' : ''}${f(r)}`).join('\n') : '—');

  const desc = [
    fmt('Quem mais matou', rankings.mostKills,  (r)=> `**${r.username}** — ${r.k}`),
    fmt('Quem mais morreu', rankings.mostDeaths,(r)=> `**${r.username}** — ${r.d}`),
    fmt('Melhor K/D',       rankings.bestKD,    (r)=> `**${r.username}** — ${r.kd.toFixed(2)}`),
    fmt('Melhor HS%',       rankings.bestHS,    (r)=> `**${r.username}** — ${r.hs_pct.toFixed(1)}%`),
    fmt('Quem mais venceu', rankings.mostWins,  (r)=> `**${r.username}** — ${r.wins}`),
  ].join('\n\n');

  return new EmbedBuilder()
    .setTitle(`R6 — Ranking ${rangeTitle}`)
    .setDescription(desc)
    .setTimestamp(new Date());
}

// -------------------------------
// Coleta (1 jogador / guild, com janelas)
// -------------------------------
async function collectForUserInWindow(username, start, end) {
  const { url, blocks } = await scrapeDailyBlocks(username);
  const filtered = filterBlocksByWindow(blocks, start, end);
  const agg = aggregate(filtered);
  return { username, url, agg, count: filtered.length };
}

async function collectForUser(username, range) {
  const { url, blocks } = await scrapeDailyBlocks(username);
  const filtered = filterBlocksByRange(blocks, range);
  const agg = aggregate(filtered);
  return { username, url, agg, count: filtered.length };
}

async function collectForGuild(guildId, range) {
  const rows = qListPlayers.all(guildId);
  const results = [];
  for (const r of rows) {
    try {
      const one = await collectForUser(r.username, range);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: e?.message || String(e) });
    }
  }
  return results;
}

async function collectForGuildWindow(guildId, start, end) {
  const rows = qListPlayers.all(guildId);
  const results = [];
  for (const r of rows) {
    try {
      const one = await collectForUserInWindow(r.username, start, end);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: e?.message || String(e) });
    }
  }
  return results;
}

// ---------- Coleta baseada no HEADER de ontem ----------
async function collectYesterdayForUser(username) {
  const { url, html } = await fetchProfileHtml(username);
  const label = yesterdayLabel();
  const stats = extractDayStatsFromHtml(html, label);
  if (!stats) throw new Error(`Sem bloco de "${label}"`);
  const agg = {
    wins: stats.wins,
    losses: stats.losses,
    k: stats.k,
    d: stats.d,
    kd: Number.isFinite(stats.kd) ? stats.kd : (stats.d > 0 ? stats.k / stats.d : 0),
    hs_pct: Number.isFinite(stats.hs) ? stats.hs : 0,
    days: 1,
  };
  return { username, url, agg, count: 1 };
}

async function collectYesterdayForGuild(guildId) {
  const rows = qListPlayers.all(guildId);
  const results = [];
  const label = yesterdayLabel();
  for (const r of rows) {
    try {
      const one = await collectYesterdayForUser(r.username);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: `Sem dados para ${label}` });
    }
  }
  return results;
}

// -------------------------------
// Rankings (ordenações)
// -------------------------------
function buildRankings(collected) {
  const flat = collected
    .filter(c => !c.error)
    .map(c => ({ username: c.username, ...c.agg }));

  const by = (k) => (a,b)=> (b[k] - a[k]);

  return {
    mostKills:  [...flat].sort(by('k')).slice(0, 5),
    mostDeaths: [...flat].sort(by('d')).slice(0, 5),
    bestKD:     [...flat].sort((a,b)=> b.kd - a.kd).slice(0, 5),
    bestHS:     [...flat].sort((a,b)=> b.hs_pct - a.hs_pct).slice(0, 5),
    mostWins:   [...flat].sort(by('wins')).slice(0, 5),
  };
}

// -------------------------------
// Cron por guild (3 tarefas)
// -------------------------------
const guildCrons = new Map(); // { guildId: { daily, weekly, monthly } }

function parseHHmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s||'').trim());
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function stopCronsForGuild(guildId) {
  const entry = guildCrons.get(guildId);
  if (!entry) return;
  entry.daily?.stop?.();
  entry.weekly?.stop?.();
  entry.monthly?.stop?.();
  guildCrons.delete(guildId);
}

async function installCronsForGuild(client, guildId) {
  const row = qGetSchedule.get(guildId);
  if (!row) return;
  const { channel_id, time_str } = row;
  const parsed = parseHHmm(time_str);
  if (!parsed) return;

  stopCronsForGuild(guildId);

  const dailyExpr   = `${parsed.mm} ${parsed.hh} * * *`;
  const weeklyExpr  = `${parsed.mm} ${parsed.hh} * * 1`;
  const monthlyExpr = `${parsed.mm} ${parsed.hh} 1 * *`;

  const daily = cron.schedule(dailyExpr, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const { start, end } = getCanonicalWindow('day');
      const results = await collectForGuildWindow(guildId, start, end);
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      for (const r of results) {
        if (r.error) await ch.send(`❌ Falha em **${r.username}** — ${r.err || 'erro'}`);
        else await ch.send({ embeds: [embedReport('Hoje', r.username, r.url, r.agg)] });
      }
    } catch (e) {
      console.error('Falha no cron diário:', e);
    }
  }, { timezone: TZ });

  const weekly = cron.schedule(weeklyExpr, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const now = DateTime.now().setZone(TZ);
      const { start, end } = getCanonicalWindow('week', now);
      const results = await collectForGuildWindow(guildId, start, end);
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking(`— Semana Anterior (${start.toFormat('dd/LL')}–${end.toFormat('dd/LL')})`, rk)] });
    } catch (e) {
      console.error('Falha no cron semanal:', e);
    }
  }, { timezone: TZ });

  const monthly = cron.schedule(monthlyExpr, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const now = DateTime.now().setZone(TZ);
      const { start, end } = getCanonicalWindow('month', now);
      const results = await collectForGuildWindow(guildId, start, end);
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking(`— Mês Anterior (${start.toFormat('LL/yyyy')})`, rk)] });
    } catch (e) {
      console.error('Falha no cron mensal:', e);
    }
  }, { timezone: TZ });

  guildCrons.set(guildId, { daily, weekly, monthly });
  console.log(`🕒 Cronos instalados para guild ${guildId} @ ${time_str} (${TZ}) [daily/weekly/monthly]`);
}

async function installAllCrons(client) {
  const rows = qAllSchedules.all();
  for (const r of rows) await installCronsForGuild(client, r.guild_id);
}

// -------------------------------
// Discord client + slash
// -------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName('cadastrar')
    .setDescription('Cadastrar um jogador (nick Ubisoft) para rastrear')
    .addStringOption(o => o.setName('nick').setDescription('Nick na Ubisoft').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('programar')
    .setDescription('Programar envios: diário (relatório), semanal e mensal (rankings) no mesmo horário')
    .addChannelOption(o =>
      o.setName('canal').setDescription('Canal de destino').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addStringOption(o =>
      o.setName('horario').setDescription('Horário HH:mm (24h) no fuso configurado').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('cancelar_programacao')
    .setDescription('Cancelar todos os envios programados desta guild')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('daily_report')
    .setDescription('Relatório de HOJE (todos ou 1 nick específico)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional, 1 jogador)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('weekly_report')
    .setDescription('Relatório dos ÚLTIMOS 7 DIAS (todos ou 1 nick específico)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional, 1 jogador)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('monthly_report')
    .setDescription('Relatório dos ÚLTIMOS 30 DIAS (todos ou 1 nick específico)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional, 1 jogador)').setRequired(false)),

  new SlashCommandBuilder().setName('daily_ranking').setDescription('Ranking de HOJE'),
  new SlashCommandBuilder().setName('yesterday_ranking').setDescription('Ranking de ONTEM'),
  new SlashCommandBuilder().setName('weekly_ranking').setDescription('Ranking dos ÚLTIMOS 7 DIAS'),
  new SlashCommandBuilder().setName('monthly_ranking').setDescription('Ranking dos ÚLTIMOS 30 DIAS'),
].map(c => c.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const app = await client.application?.fetch();
  const appId = app?.id || client.user.id;

  const list = (GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length) {
    for (const gid of list) {
      await rest.put(Routes.applicationGuildCommands(appId, gid), { body: slashCommands });
      console.log(`✅ Comandos registrados na guild ${gid}.`);
    }
  } else if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: slashCommands });
    console.log(`✅ Comandos registrados na guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
    console.log('🌐 Comandos registrados globalmente (podem demorar a aparecer).');
  }
}

client.once('ready', async () => {
  console.log(`✅ Logado como ${client.user.tag}`);
  for (const g of client.guilds.cache.values()) {
    console.log(`- ${g.name} (${g.id})`);
  }
  await registerSlashCommands();
  await installAllCrons(client);
});

// -------------------------------
// Helper de confirmação (slash)
// -------------------------------
async function confirm(ix, message, { ephemeral = false, edit = false } = {}) {
  const payload = typeof message === 'string' ? { content: message } : message;
  if (edit) return ix.editReply(payload);
  if (ix.deferred || ix.replied) return ix.followUp({ ...payload, ephemeral });
  return ix.reply({ ...payload, ephemeral });
}

// -------------------------------
// Handler: SLASH
// -------------------------------
client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;

  const name = ix.commandName;
  const guildId = ix.guildId;

  if (name === 'cadastrar') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem cadastrar jogadores.', { ephemeral: true });
      return;
    }
    const nick = ix.options.getString('nick', true).trim();
    if (!nick) {
      await confirm(ix, 'Uso: `/cadastrar nick`', { ephemeral: true });
      return;
    }
    qInsertPlayer.run(guildId, nick);
    const total = qListPlayers.all(guildId).length;
    await confirm(ix, `✅ **${nick}** cadastrado.\n📚 Jogadores: **${total}**.`, { ephemeral: true });
    return;
  }

  if (name === 'programar') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem programar.', { ephemeral: true });
      return;
    }
    const channel = ix.options.getChannel('canal', true);
    const horario = ix.options.getString('horario', true);
    const parsed = parseHHmm(horario);
    if (!parsed) {
      await confirm(ix, '⚠️ Use **HH:mm** (24h), ex.: `23:55`.', { ephemeral: true });
      return;
    }
    await confirm(ix, `🗓️ Agendando **${horario} ${TZ}** em ${channel}…`, { ephemeral: true });
    qUpsertSchedule.run(guildId, channel.id, horario);
    await installCronsForGuild(client, guildId);
    await confirm(ix, `✅ Programado!\n• Canal: ${channel}\n• Horário base: **${horario} ${TZ}**\n• Envia: diário (relatório), **segunda** (ranking semanal da semana anterior) e **1º dia** (ranking mensal do mês anterior).`, { ephemeral: true });
    return;
  }

  if (name === 'cancelar_programacao') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem cancelar programação.', { ephemeral: true });
      return;
    }
    stopCronsForGuild(guildId);
    qDelSchedule.run(guildId);
    await confirm(ix, '🛑 Programações **canceladas** para esta guild.', { ephemeral: true });
    return;
  }

  if (name === 'yesterday_ranking') {
    await ix.deferReply();
    const label = yesterdayLabel();
    try {
      const results = await collectYesterdayForGuild(guildId);
      if (!results.length) {
        await confirm(ix, '⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick` primeiro.', { edit: true });
        return;
      }
      const ok = results.filter(r => !r.error);
      if (!ok.length) {
        await confirm(ix, `⚠️ Ninguém jogou **${label}**.`, { edit: true });
        return;
      }
      const rk = buildRankings(results);
      await confirm(ix, { embeds: [embedRanking('— Ontem', rk)] }, { edit: true });
    } catch (e) {
      console.error(e);
      await confirm(ix, '❌ Não consegui gerar agora. Tente novamente.', { edit: true });
    }
    return;
  }

  const rangeMap = {
    daily_report:   'day',
    weekly_report:  'week',
    monthly_report: 'month',
    daily_ranking:   'day',
    weekly_ranking:  'week',
    monthly_ranking: 'month',
  };

  if (name in rangeMap) {
    const range = rangeMap[name];
    await ix.deferReply();

    const label = range === 'day' ? 'de hoje' :
                  range === 'week' ? 'dos últimos 7 dias' :
                  'dos últimos 30 dias';

    const isReport = name.endsWith('report');

    const nickOpt = isReport ? ix.options.getString('nick') : null;
    if (isReport && nickOpt) {
      const nick = nickOpt.trim();
      await confirm(ix, `🔎 Recebi **/${name}** — gerando relatório ${label} de **${nick}**…`);
      try {
        const r = await collectForUser(nick, range);
        const title = range === 'day' ? 'Hoje' : range === 'week' ? 'Últimos 7 dias' : 'Últimos 30 dias';
        await confirm(ix, { embeds: [embedReport(title, r.username, r.url, r.agg)] }, { edit: true });
        await confirm(ix, `✅ Relatório ${label} de **${nick}** concluído.`);
      } catch (e) {
        console.error(e);
        await confirm(ix, `❌ Falha ao gerar para **${nick}** — ${e?.message || 'erro'}`, { edit: true });
      }
      return;
    }

    await confirm(ix, `🔎 Recebi **/${name}** — gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
    try {
      const results = await collectForGuild(guildId, range);
      if (!results.length) {
        await confirm(ix, '⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick` primeiro.', { edit: true });
        return;
      }
      const total = results.length;
      const ok = results.filter(r => !r.error).length;
      const fail = total - ok;

      if (isReport) {
        const title = range === 'day' ? 'Hoje' : range === 'week' ? 'Últimos 7 dias' : 'Últimos 30 dias';
        for (const r of results) {
          if (r.error) await confirm(ix, `❌ Falha em **${r.username}** — ${r.err || 'erro'}`);
          else await confirm(ix, { embeds: [embedReport(title, r.username, r.url, r.agg)] });
        }
        await confirm(ix, `✅ Relatório ${label} concluído. **${ok}/${total}** (erros: ${fail}).`, { edit: true });
      } else {
        const rk = buildRankings(results);
        const title = range === 'day' ? '— Hoje' : range === 'week' ? '— Últimos 7 dias' : '— Últimos 30 dias';
        await confirm(ix, { embeds: [embedRanking(title, rk)] }, { edit: true });
        await confirm(ix, `✅ Ranking ${label} gerado. Considerados: **${ok}/${total}** (erros: ${fail}).`);
      }
    } catch (e) {
      console.error(e);
      await confirm(ix, '❌ Não consegui gerar agora. Tente novamente.', { edit: true });
    }
    return;
  }
});

// -------------------------------
// Handler: PREFIXO
// -------------------------------
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content?.trim();
  if (!content || !content.startsWith(PREFIX)) return;

  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd  = (args.shift() || '').toLowerCase();

  const isAdmin = msg.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  const send = (m) => msg.channel.send(m);

  if (cmd === 'cadastrar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cadastrar`.');
    const nick = args.join(' ').trim();
    if (!nick) return send('Uso: `!cadastrar <nick-ubisoft>`');
    qInsertPlayer.run(msg.guild.id, nick);
    const total = qListPlayers.all(msg.guild.id).length;
    return send(`✅ **${nick}** cadastrado. Jogadores agora: **${total}**.`);
  }

  if (cmd === 'remover') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!remover`.');
    const nick = args.join(' ').trim();
    if (!nick) return send('Uso: `!remover <nick-ubisoft>`');
    const info = qDeletePlayer.run(msg.guild.id, nick);
    if (info.changes) return send(`🗑️ **${nick}** removido.`);
    return send(`⚠️ **${nick}** não estava cadastrado.`);
  }

  if (cmd === 'programar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!programar`.');
    if (args.length < 2) return send('Uso: `!programar #canal HH:mm`');

    const chMention = msg.mentions.channels.first();
    let target = chMention;
    if (!target) {
      const first = args[0];
      const byId = msg.guild.channels.cache.get(first);
      if (byId?.isTextBased()) target = byId;
      if (!target) {
        target = msg.guild.channels.cache.find(
          c => c.isTextBased() && c.name.toLowerCase() === first.replace(/^#/, '').toLowerCase()
        );
      }
    }
    const horario = args[1];
    const parsed = parseHHmm(horario || '');
    if (!target?.isTextBased() || !parsed) {
      return send('Uso: `!programar #canal HH:mm` (ex.: `!programar #r6-status 23:55`)');
    }

    await send(`🗓️ Agendando envios base **${horario} ${TZ}** em ${target}…`);
    qUpsertSchedule.run(msg.guild.id, target.id, horario);
    await installCronsForGuild(client, msg.guild.id);
    return send(`✅ Programado!\n• Canal: ${target}\n• Horário base: **${horario} ${TZ}**\n• Envia: diário (relatório), **segunda** (ranking semanal da semana anterior) e **1º dia** (ranking mensal do mês anterior).`);
  }

  if (cmd === 'cancelar-programação' || cmd === 'cancelar_programacao' || cmd === 'cancelarprogramacao') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cancelar-programação`.');
    stopCronsForGuild(msg.guild.id);
    qDelSchedule.run(msg.guild.id);
    return send('🛑 Programações **canceladas** para este servidor.');
  }

  if (cmd === 'yesterday_ranking') {
    const label = yesterdayLabel();
    await send('🔎 Gerando ranking **de ontem**…');
    try {
      const results = await collectYesterdayForGuild(msg.guild.id);
      if (!results.length) return send('⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick` ou `!cadastrar <nick>`.');
      const ok = results.filter(r => !r.error);
      if (!ok.length) return send(`⚠️ Ninguém jogou **${label}**.`);
      const rk = buildRankings(results);
      await send({ embeds: [embedRanking('— Ontem', rk)] });
      return;
    } catch (e) {
      console.error(e);
      return send('❌ Não consegui gerar agora. Tente novamente em alguns minutos.');
    }
  }

  const rangeMap = {
    'daily_report':   'day',
    'weekly_report':  'week',
    'monthly_report': 'month',
    'daily_ranking':   'day',
    'weekly_ranking':  'week',
    'monthly_ranking': 'month',
  };

  if (cmd in rangeMap) {
    const range = rangeMap[cmd];
    const isReport = cmd.endsWith('report');
    const label = range === 'day' ? 'de hoje'
               : range === 'week' ? 'dos últimos 7 dias'
               : 'dos últimos 30 dias';

    const singleNick = isReport && args.length ? args.join(' ').trim() : null;

    if (singleNick) {
      await send(`🔎 Recebi **${PREFIX}${cmd} ${singleNick}** — gerando relatório ${label} de **${singleNick}**…`);
      try {
        const r = await collectForUser(singleNick, range);
        const title = range === 'day' ? 'Hoje' : range === 'week' ? 'Últimos 7 dias' : 'Últimos 30 dias';
        await send({ embeds: [embedReport(title, r.username, r.url, r.agg)] });
        await send(`✅ Relatório ${label} de **${singleNick}** concluído.`);
      } catch (e) {
        console.error(e);
        await send(`❌ Falha ao gerar para **${singleNick}** — ${e?.message || 'erro'}`);
      }
      return;
    }

    await send(`🔎 Recebi **${PREFIX}${cmd}** — gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
    try {
      const results = await collectForGuild(msg.guild.id, range);
      if (!results.length) return send('⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick` ou `!cadastrar <nick>`.');

      const total = results.length;
      const ok = results.filter(r => !r.error).length;
      const fail = total - ok;

      if (isReport) {
        const title = range === 'day' ? 'Hoje' : range === 'week' ? 'Últimos 7 dias' : 'Últimos 30 dias';
        for (const r of results) {
          if (r.error) await send(`❌ Falha em **${r.username}** — ${r.err || 'erro'}`);
          else await send({ embeds: [embedReport(title, r.username, r.url, r.agg)] });
        }
        await send(`✅ Relatório ${label} concluído. **${ok}/${total}** (erros: ${fail}).`);
      } else {
        const rk = buildRankings(results);
        const title = range === 'day' ? '— Hoje' : range === 'week' ? '— Últimos 7 dias' : '— Últimos 30 dias';
        await send({ embeds: [embedRanking(title, rk)] });
        await send(`✅ Ranking ${label} gerado. Considerados: **${ok}/${total}** (erros: ${fail}).`);
      }
    } catch (e) {
      console.error(e);
      await send('❌ Não consegui gerar agora. Tente novamente em alguns minutos.');
    }
    return;
  }

  if (cmd === 'help' || cmd === 'ajuda') {
    const eb = new EmbedBuilder()
      .setTitle('R6 — Ajuda (comandos por prefixo)')
      .setDescription([
        `Prefixo atual: **${PREFIX}**`,
        `Comandos abaixo têm equivalentes em slash (ex.: \`/daily_report\`).`,
        `Alguns exigem permissão de **Manage Server** (admins).`,
      ].join('\n'))
      .addFields(
        {
          name: `1) Cadastrar jogador (ADMIN)`,
          value: [
            `**Uso:** \`${PREFIX}cadastrar <nick-ubisoft>\``,
            `O **nick** é o que aparece na URL do TRN.`,
            `→ \`${PREFIX}cadastrar gabrielgadelham\``,
          ].join('\n'),
          inline: false
        },
        {
          name: `2) Programar envios (ADMIN)`,
          value: [
            `**Uso:** \`${PREFIX}programar #canal HH:mm\``,
            `Cria 3 rotinas no mesmo horário:`,
            `• **Diário:** relatório do dia, todos os dias;`,
            `• **Ontem:** use \`${PREFIX}yesterday_ranking\` sob demanda;`,
            `• **Semanal:** toda **segunda**, ranking da **semana anterior** (seg-dom);`,
            `• **Mensal:** todo **dia 1**, ranking do **mês anterior**.`,
            `Ex.: \`${PREFIX}programar #r6-status 23:55\``,
          ].join('\n'),
          inline: false
        },
        {
          name: `3) Cancelar programação (ADMIN)`,
          value: `**Uso:** \`${PREFIX}cancelar-programação\` (ou \`${PREFIX}cancelar_programacao\`) — interrompe todos os envios agendados.`,
          inline: false
        },
        {
          name: `4) Relatórios (TODOS)`,
          value: [
            `**Hoje:** \`${PREFIX}daily_report [nick]\``,
            `**Semana (7d):** \`${PREFIX}weekly_report [nick]\``,
            `**Mês (30d):** \`${PREFIX}monthly_report [nick]\``,
            `Com \`[nick]\` → relatório só daquele jogador; sem \`[nick]\` → todos os cadastrados.`,
          ].join('\n'),
          inline: false
        },
        {
          name: `5) Rankings (TODOS)`,
          value: [
            `**Hoje:** \`${PREFIX}daily_ranking\``,
            `**Ontem:** \`${PREFIX}yesterday_ranking\``,
            `**Semana (7d):** \`${PREFIX}weekly_ranking\``,
            `**Mês (30d):** \`${PREFIX}monthly_ranking\``,
            `Categorias: Quem mais matou • Quem mais morreu • Melhor K/D • Melhor HS% • Quem mais venceu`,
          ].join('\n'),
          inline: false
        },
        {
          name: 'Dicas',
          value: [
            `• O site pode demorar 10–15s para renderizar.`,
            `• KD = **K_total/D_total**; HS% ponderado por **kills**.`,
            `• Para muitas pessoas, o bot manda vários embeds em sequência.`,
          ].join('\n'),
          inline: false
        }
      )
      .setTimestamp(new Date());
    return send({ embeds: [eb] });
  }
});

// -------------------------------
client.login(DISCORD_TOKEN);
