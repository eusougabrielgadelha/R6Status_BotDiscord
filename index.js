// index.js
// ------------------------------------------------------------
// Bot R6 Tracker — Relatórios & Rankings (TRN) com Slash + Prefixo
// Agendamentos: diário (relatório), semanal/mensal (rankings) por guild
// Persistência: SQLite (jogadores e horários)
// Scraping: Cheerio diretamente do perfil TRN
// Anti-403: Cookie manual (TRN_COOKIE) + Farmer Playwright automático
// ------------------------------------------------------------

import dotenv from 'dotenv';
dotenv.config({ quiet: true }); // silencia logs do dotenv

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
  APP_ID,
  GUILD_ID,         // opcional (registro de slash em uma guild)
  GUILD_IDS,        // opcional (lista separada por vírgula)
  PREFIX = '!',
  TZ: TZ_ENV,
  // Anti-403 / Playwright
  TRN_COOKIE,                 // cookie manual (prioritário, se presente)
  TRN_BASE = 'auto',          // auto|tracker|r6
  TRN_PLATFORM = 'pc',        // pc|xbox|psn (ou aliases)
  TRN_SAMPLE_PROFILE,         // opcional, perfil usado para "farmar" cookie
  TRN_HEADLESS = 'true',      // "true" recomendado em servidor
  TRN_COOKIE_TTL_MIN = '30',  // minutos para refarmar cookies
  TRN_CF_WAIT_MS = '12000',    // espera adicional para passar Cloudflare
  TRN_NAV_TIMEOUT_MS = '45000', // timeout de navegação (ms)

  // Opcional: apontar Chrome do sistema
  CHROME_EXE,                 // ex.: /snap/bin/chromium
  EXTRA_WAIT_MS = '15000',
} = process.env;

const TZ = TZ_ENV || 'America/Sao_Paulo';

if (!DISCORD_TOKEN) {
  console.error('❌ Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

// -------------------------------
/* DB (SQLite) */
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
// Util Playwright: cookie cache em memória
// -------------------------------
let COOKIE_CACHE = {
  value: (TRN_COOKIE || '').trim() || null,
  expiresAt: 0,
};

function cookieValid() {
  return !!COOKIE_CACHE.value && Date.now() < COOKIE_CACHE.expiresAt;
}

function setCookieCache(cookieStr) {
  const ttlMin = Math.max(1, parseInt(TRN_COOKIE_TTL_MIN, 10) || 30);
  COOKIE_CACHE.value = cookieStr || null;
  COOKIE_CACHE.expiresAt = cookieStr ? Date.now() + ttlMin * 60 * 1000 : 0;
  if (COOKIE_CACHE.value) {
    console.log(`🍪 Cookie TRN atualizado (TTL ~${ttlMin}min).`);
  }
}

// Lazy import do Playwright (só quando necessário)
async function ensurePlaywright() {
  try {
    // tenta 'playwright' completo
    const pw = await import('playwright');
    return pw;
  } catch {
    try {
      // tenta 'playwright-core'
      const pwc = await import('playwright-core');
      return pwc;
    } catch (e) {
      console.warn('⚠️ Playwright não instalado. Rode: `npm i playwright && npx playwright install chromium`');
      return null;
    }
  }
}

// Resolve plataforma
const PLATFORM_ALIASES = {
  ubisoft: 'pc', ubi: 'pc', uplay: 'pc',
  pc: 'pc',
  xbox: 'xbox', xbl: 'xbox',
  ps: 'psn', psn: 'psn', playstation: 'psn'
};
const PLATFORM = PLATFORM_ALIASES[String(TRN_PLATFORM || 'pc').toLowerCase()] || 'pc';

// URL candidates (inclui as duas novas que você pediu)
function buildCandidates(username) {
  const nameEnc = encodeURIComponent(username);

  const uTrkUbiOverview = `https://tracker.gg/r6siege/profile/ubisoft/${nameEnc}/overview`;
  const uTrkPlatOverview = `https://tracker.gg/r6siege/profile/${PLATFORM}/${nameEnc}/overview`;
  const uR6UbiMatches = `https://r6.tracker.network/r6siege/profile/ubi/${nameEnc}/matches`;
  const uR6PlatProfile = `https://r6.tracker.network/profile/${PLATFORM}/${nameEnc}`;

  let candidates;
  const basePref = (TRN_BASE || 'auto').toLowerCase();
  if (basePref === 'tracker') {
    candidates = [uTrkUbiOverview, uTrkPlatOverview, uR6UbiMatches, uR6PlatProfile];
  } else if (basePref === 'r6') {
    candidates = [uR6PlatProfile, uR6UbiMatches, uTrkPlatOverview, uTrkUbiOverview];
  } else {
    candidates = [uTrkUbiOverview, uTrkPlatOverview, uR6UbiMatches, uR6PlatProfile];
  }
  return [...new Set(candidates)];
}

// Farme de cookies com Playwright
async function farmTrnCookie() {
  const pw = await ensurePlaywright();
  if (!pw) return null;

  const headless = String(TRN_HEADLESS).toLowerCase() !== 'false';
  const navTimeout = parseInt(TRN_NAV_TIMEOUT_MS, 10) || 25000;
  const cfExtraWait = parseInt(TRN_CF_WAIT_MS, 10) || 4000;

  const sampleProfile = TRN_SAMPLE_PROFILE?.trim() || 'gabrielgadelham';
  const visitUrls = buildCandidates(sampleProfile);

  const launchOpts = {
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (CHROME_EXE) launchOpts.executablePath = CHROME_EXE;

  let browser;
  try {
    browser = await pw.chromium.launch(launchOpts);
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
    });
    const page = await ctx.newPage();

    // visita 1–2 URLs até obter cookies
    for (const u of visitUrls.slice(0, 2)) {
      console.log(`🌐 Playwright navegando: ${u}`);
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: navTimeout });
        // espera a rede assentar
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
        await page.waitForTimeout(cfExtraWait);
        const html = await page.content();
        if (/cf-browser-verification|Attention Required|Just a moment/i.test(html)) {
          console.log('⏳ Cloudflare em andamento… aguardando mais um pouco');
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        console.warn('⚠️ Erro durante navegação Playwright:', e?.message || e);
      }
    }

    // agrega cookies dos dois domínios
    const cks = await ctx.cookies();
    const only = cks.filter(c =>
      c.domain.includes('tracker.gg') || c.domain.includes('r6.tracker.network')
    );
    const cookieStr = only.map(c => `${c.name}=${c.value}`).join('; ');
    if (!cookieStr) {
      console.warn('⚠️ Playwright não retornou cookies úteis.');
      return null;
    }
    return cookieStr;
  } catch (e) {
    console.warn('⚠️ Falha ao iniciar Playwright:', e?.message || e);
    return null;
  } finally {
    try { await browser?.close(); } catch {}
  }
}

// Faz fetch com tentativas + (re)farm de cookies quando necessário
async function fetchWithAnti403(url) {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  let lastErr;
  let didFarm = false;

  for (let attempt = 1; attempt <= 5; attempt++) {
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

    if (cookieValid()) headers['Cookie'] = COOKIE_CACHE.value;

    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        lastErr = new Error(`HTTP ${res.status}`);
        // Se ainda não temos cookie válido, ou já expirou, tenta farmar
        if (!didFarm && !cookieValid()) {
          console.log('🧑‍🌾 Tentando farmar cookies via Playwright…');
          const ck = await farmTrnCookie();
          if (ck) setCookieCache(ck);
          didFarm = true;
          continue; // tenta novamente com cookie
        }
        await delay(600 * attempt + Math.floor(Math.random() * 400));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        break;
      }
      const html = await res.text();
      if (/cf-browser-verification|Attention Required|Just a moment/i.test(html)) {
        lastErr = new Error('Cloudflare challenge');
        if (!didFarm) {
          console.log('🧑‍🌾 Cloudflare detectado — farmando cookies…');
          const ck = await farmTrnCookie();
          if (ck) setCookieCache(ck);
          didFarm = true;
          continue;
        }
        await delay(700 * attempt);
        continue;
      }
      return html;
    } catch (e) {
      lastErr = e;
      await delay(500 * attempt);
    }
  }

  throw lastErr || new Error('blocked');
}

// -------------------------------
// Scraper TRN (perfil público)
// 1) Daily blocks por partidas (para HOJE/7/30, semana/mês canônicos)
// 2) Header do dia específico (para ONTEM de forma robusta)
// -------------------------------
const MONTHS_EN = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function toISOFromLabel(label, now = DateTime.now().setZone(TZ)) {
  // "Aug 28" → "yyyy-MM-dd"
  const m = /^\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s*$/.exec(label || '');
  if (!m) return null;
  let year = now.year;
  const month = MONTHS_EN[m[1]];
  const day = Number(m[2]);
  let dt = DateTime.fromObject({ year, month, day }, { zone: TZ });
  // Se estivermos em Jan e o label for Dez, ajusta para ano anterior
  if (now.month === 1 && month === 12) dt = dt.minus({ years: 1 });
  return dt.toISODate();
}

async function fetchProfileHtml(username) {
  const candidates = buildCandidates(username);

  let lastErr;
  for (const url of candidates) {
    try {
      const html = await fetchWithAnti403(url);
      return { url, html };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ Falha em ${url}: ${e?.message || e}`);
      continue;
    }
  }

  const hint = COOKIE_CACHE.value
    ? 'Cookie em cache pode ter expirado — tente aumentar TRN_COOKIE_TTL_MIN ou verificar Playwright.'
    : 'Ative o Playwright (npm i playwright) ou defina TRN_COOKIE manualmente.';
  throw new Error(`Falha ao carregar perfil ${username}: ${lastErr?.message || 'bloqueado'} — ${hint}`);
}

/**
 * scrapeDailyBlocks(username)
 * → { url, blocks: [ { dateLabel, iso, wins, losses, k, d, hs_pct } ] }
 *  - hs_pct em 0–100 (média simples das partidas do dia)
 */
async function scrapeDailyBlocks(username) {
  const { url, html } = await fetchProfileHtml(username);
  const $ = cheerio.load(html);

  const blocks = [];
  // Cada "dia" fica em seção com header "Aug 28", etc. (layout TRN v3)
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
        // fallback leve
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
      if (!Number.isNaN(hs)) {
        hsAcc += hs;
        hsN += 1;
      }
    });

    const hs_pct = hsN > 0 ? (hsAcc / hsN) : 0;
    blocks.push({ dateLabel: header, iso, wins, losses, k: kSum, d: dSum, hs_pct });
  });

  return { url, blocks };
}

// ---------- (Utilitários para o cabeçalho do dia, p/ ontem) ----------
function yesterdayLabel(now = DateTime.now().setZone(TZ)) {
  return now.minus({ days: 1 }).setLocale('en-US').toFormat('MMM d'); // "Aug 28"
}

// Seleciona o <header> cujo label de data bate
function findHeaderForLabel($, label) {
  let target = null;
  $('header').each((_, el) => {
    const txt =
      $(el).find('div[class*="text-18"][class*="font-bold"][class*="text-secondary"]').first().text().trim();
    if (txt.toLowerCase() === String(label).toLowerCase()) {
      target = $(el);
      return false; // break
    }
  });
  return target;
}

// Lê números do bloco "name-value" pelo rótulo (K/D | K | D | HS%)
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

/**
 * extractDayStatsFromHtml(html, label)
 * Retorna { wins, losses, k, d, kd, hs } do HEADER daquele dia
 */
function extractDayStatsFromHtml(html, label) {
  const $ = cheerio.load(html);
  const header = findHeaderForLabel($, label);
  if (!header || !header.length) return null;

  // W / L
  let wins = 0, losses = 0;
  header.find('.stat-list .value').each((_, el) => {
    const txt = $(el).text().trim();
    const n = parseInt(txt.replace(/\D+/g, ''), 10) || 0;
    if (/W/i.test(txt)) wins = n;
    if (/L/i.test(txt)) losses = n;
  });

  // K / D / K-D / HS%
  const kd = readHeaderNumber($, header, 'K/D');
  const k  = readHeaderNumber($, header, 'K');
  const d  = readHeaderNumber($, header, 'D');
  const hs = readHeaderNumber($, header, 'HS%');

  return { wins, losses, k, d, kd, hs };
}

// -------------------------------
// Util: janelas canônicas e relativas
// -------------------------------
function filterBlocksByWindow(blocks, start, end) {
  return blocks
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ }).endOf('day');
      return dt >= start.startOf('day') && dt <= end.endOf('day');
    });
}

// Para comandos interativos (não agendados): janelas relativas ao hoje
function filterBlocksByRange(blocks, range, now = DateTime.now().setZone(TZ)) {
  const today = now.startOf('day');
  let start;
  if (range === 'day') start = today;                    // hoje
  else if (range === 'week') start = today.minus({ days: 6 });  // últimos 7
  else if (range === 'month') start = today.minus({ days: 29 }); // últimos 30
  else start = today;
  const end = today.endOf('day');
  return filterBlocksByWindow(blocks, start, end);
}

// Para agendamentos (janelas canônicas: semana/mês anteriores)
function getCanonicalWindow(kind, now = DateTime.now().setZone(TZ)) {
  if (kind === 'day') {
    const start = now.startOf('day');
    return { start, end: start.endOf('day') };
  }
  if (kind === 'week') {
    // semana anterior completa (seg→dom) — ISO week
    const prev = now.minus({ weeks: 1 });
    const start = prev.startOf('week');
    const end   = prev.endOf('week');
    return { start, end };
  }
  if (kind === 'month') {
    // mês anterior completo
    const prev = now.minus({ months: 1 });
    const start = prev.startOf('month');
    const end   = prev.endOf('month');
    return { start, end };
  }
  const start = now.startOf('day');
  return { start, end: start.endOf('day') };
}

// Janela de ONTEM (um único dia civil no fuso TZ) — ainda usada em ajuda/crons
function getYesterdayWindow(now = DateTime.now().setZone(TZ)) {
  const y = now.minus({ days: 1 }).startOf('day');
  return { start: y, end: y.endOf('day') };
}

// -------------------------------
// Agregação por jogador (para blocks)
// -------------------------------
function aggregate(blocks) {
  // Soma total de K, D, W, L; KD = K_total/D_total; HS% ponderado por kills
  let totalK = 0, totalD = 0, totalWins = 0, totalLosses = 0;
  let hsShotsEst = 0;

  for (const b of blocks) {
    if (Number.isFinite(b.k)) totalK += b.k;
    if (Number.isFinite(b.d)) totalD += b.d;
    if (Number.isFinite(b.wins)) totalWins += b.wins;
    if (Number.isFinite(b.losses)) totalLosses += b.losses;
    if (Number.isFinite(b.hs_pct) && Number.isFinite(b.k)) {
      // aproximação: HS% * kills do bloco
      hsShotsEst += (b.hs_pct / 100) * b.k;
    }
  }

  const kdRaw = totalD > 0 ? totalK / totalD : (totalK > 0 ? Infinity : 0);
  const kd = Number.isFinite(kdRaw) ? kdRaw : 0;
  const hsPct = totalK > 0 ? (hsShotsEst / totalK) * 100 : 0;

  return { wins: totalWins, losses: totalLosses, k: totalK, d: totalD, kd, hs_pct: hsPct, days: blocks.length };
}

// -------------------------------
// Embeds
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
    fmt('Quem mais morreu', rankings.mostDeaths, (r)=> `**${r.username}** — ${r.d}`),
    fmt('Melhor K/D',      rankings.bestKD,     (r)=> `**${r.username}** — ${r.kd.toFixed(2)}`),
    fmt('Melhor HS%',      rankings.bestHS,     (r)=> `**${r.username}** — ${r.hs_pct.toFixed(1)}%`),
    fmt('Quem mais venceu',rankings.mostWins,   (r)=> `**${r.username}** — ${r.wins}`),
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

  // stop anteriores
  stopCronsForGuild(guildId);

  const dailyExpr   = `${parsed.mm} ${parsed.hh} * * *`;    // todo dia
  const weeklyExpr  = `${parsed.mm} ${parsed.hh} * * 1`;    // segunda-feira
  const monthlyExpr = `${parsed.mm} ${parsed.hh} 1 * *`;    // dia 1

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
/* Discord client + slash */
// -------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,   // prefixo
    GatewayIntentBits.MessageContent,  // conteúdo (ative no portal!)
  ],
  partials: [Partials.Channel],
});

// Slash commands
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
  const appId = APP_ID || (await client.application?.fetch())?.id || client.user.id;

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

  // /cadastrar (admin)
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

  // /programar (admin) -> instala 3 crons
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

  // /cancelar_programacao (admin)
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

  // /yesterday_ranking — baseado no HEADER "MMM d"
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

  // Demais comandos de relatório/ranking (hoje/7/30)
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
    await ix.deferReply(); // público

    const label = range === 'day' ? 'de hoje' :
                  range === 'week' ? 'dos últimos 7 dias' :
                  'dos últimos 30 dias';

    const isReport = name.endsWith('report');

    // single (opcional) nos reports
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

    // Todos os cadastrados
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
// Handler: PREFIXO (inclui !cadastrar e !yesterday_ranking)
// -------------------------------
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content?.trim();
  if (!content || !content.startsWith(PREFIX)) return;

  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd  = (args.shift() || '').toLowerCase();

  const isAdmin = msg.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  const send = (m) => msg.channel.send(m);

  // Admin: cadastrar
  if (cmd === 'cadastrar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cadastrar`.');
    const nick = args.join(' ').trim();
    if (!nick) return send('Uso: `!cadastrar <nick-ubisoft>`');
    qInsertPlayer.run(msg.guild.id, nick);
    const total = qListPlayers.all(msg.guild.id).length;
    return send(`✅ **${nick}** cadastrado. Jogadores agora: **${total}**.`);
  }

  // Admin: remover
  if (cmd === 'remover') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!remover`.');
    const nick = args.join(' ').trim();
    if (!nick) return send('Uso: `!remover <nick-ubisoft>`');
    const info = qDeletePlayer.run(msg.guild.id, nick);
    if (info.changes) return send(`🗑️ **${nick}** removido.`);
    return send(`⚠️ **${nick}** não estava cadastrado.`);
  }

  // Admin: programar (#canal HH:mm)
  if (cmd === 'programar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!programar`.');
    if (args.length < 2) return send('Uso: `!programar #canal HH:mm`');

    // canal: menção, id ou nome
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

  // Admin: cancelar-programação
  if (cmd === 'cancelar-programação' || cmd === 'cancelar_programacao' || cmd === 'cancelarprogramacao') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cancelar-programação`.');
    stopCronsForGuild(msg.guild.id);
    qDelSchedule.run(msg.guild.id);
    return send('🛑 Programações **canceladas** para este servidor.');
  }

  // !yesterday_ranking — baseado no HEADER "MMM d"
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

  // Map de intervalos (hoje/7/30)
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

    // single (opcional) nos reports: !daily_report <nick>
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

    // todos os cadastrados
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

  // Ajuda detalhada (prefixo)
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
          ].join('\n'),
          inline: false
        },
        {
          name: `2) Programar envios (ADMIN)`,
          value: [
            `**Uso:** \`${PREFIX}programar #canal HH:mm\``,
            `Cria 3 rotinas no mesmo horário: diário (hoje), semanal (semana anterior) e mensal (mês anterior).`,
          ].join('\n'),
          inline: false
        },
        {
          name: `3) Cancelar programação (ADMIN)`,
          value: `**Uso:** \`${PREFIX}cancelar-programação\` (ou \`${PREFIX}cancelar_programacao\`).`,
          inline: false
        },
        {
          name: `4) Relatórios (TODOS)`,
          value: [
            `**Hoje:** \`${PREFIX}daily_report [nick]\``,
            `**Semana (7d):** \`${PREFIX}weekly_report [nick]\``,
            `**Mês (30d):** \`${PREFIX}monthly_report [nick]\``,
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
          ].join('\n'),
          inline: false
        },
        {
          name: 'Dicas',
          value: [
            `• Se aparecer 403, confira o Playwright ou defina TRN_COOKIE.`,
            `• KD = **K_total/D_total**; HS% ponderado por **kills**.`,
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
