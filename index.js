// index.js
// ------------------------------------------------------------
// Bot R6 Tracker — Relatórios & Rankings (TRN) com Slash + Prefixo
// Agendamentos: diário (relatório), semanal/mensal (rankings) por guild
// Persistência: SQLite (jogadores e horários)
// Scraping: Playwright para todas requisições (mais robusto contra Cloudflare)
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
  APP_ID,
  GUILD_ID,
  GUILD_IDS,
  PREFIX = '!',
  TZ: TZ_ENV,
  // Anti-403 / Playwright
  TRN_BASE = 'auto',
  TRN_PLATFORM = 'pc',
  TRN_SAMPLE_PROFILE,
  TRN_HEADLESS = 'true',
  TRN_COOKIE_TTL_MIN = '60',
  TRN_CF_WAIT_MS = '5000',
  TRN_NAV_TIMEOUT_MS = '30000',
  CHROME_EXE,
} = process.env;

const TZ = TZ_ENV || 'America/Sao_Paulo';

if (!DISCORD_TOKEN) {
  console.error('❌ Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

// Função delay que estava faltando
const delay = (ms) => new Promise(r => setTimeout(r, ms));

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
  time_str TEXT NOT NULL,
  PRIMARY KEY (guild_id)
);

CREATE TABLE IF NOT EXISTS cookie_cache (
  id INTEGER PRIMARY KEY DEFAULT 1,
  value TEXT,
  expires_at INTEGER
);
`);

const qInsertPlayer = db.prepare('INSERT OR IGNORE INTO players (guild_id, username) VALUES (?, ?)');
const qDeletePlayer = db.prepare('DELETE FROM players WHERE guild_id = ? AND username = ?');
const qListPlayers = db.prepare('SELECT username FROM players WHERE guild_id = ? ORDER BY username COLLATE NOCASE');
const qUpsertSchedule = db.prepare(`
  INSERT INTO schedules (guild_id, channel_id, time_str)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, time_str=excluded.time_str
`);
const qGetSchedule = db.prepare('SELECT channel_id, time_str FROM schedules WHERE guild_id = ?');
const qDelSchedule = db.prepare('DELETE FROM schedules WHERE guild_id = ?');
const qAllSchedules = db.prepare('SELECT guild_id FROM schedules');

// Queries para cookie cache
const qGetCookie = db.prepare('SELECT value, expires_at FROM cookie_cache WHERE id = 1');
const qSetCookie = db.prepare(`
  INSERT INTO cookie_cache (id, value, expires_at) 
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at
`);

// -------------------------------
// Cache de browser context global
// -------------------------------
let browserInstance = null;
let browserContext = null;
let lastBrowserUse = Date.now();
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutos

// Cookie cache em memória
let COOKIE_CACHE = {
  value: null,
  expiresAt: 0,
};

// Carrega cookies do banco ao iniciar
function loadCookieFromDB() {
  const row = qGetCookie.get();
  if (row && row.value && row.expires_at > Date.now()) {
    COOKIE_CACHE.value = row.value;
    COOKIE_CACHE.expiresAt = row.expires_at;
    console.log('🍪 Cookie carregado do banco de dados.');
  }
}

// Salva cookies no banco e memória
function setCookieCache(cookieStr) {
  const ttlMin = Math.max(1, parseInt(TRN_COOKIE_TTL_MIN, 10) || 60);
  COOKIE_CACHE.value = cookieStr || null;
  COOKIE_CACHE.expiresAt = cookieStr ? Date.now() + ttlMin * 60 * 1000 : 0;
  
  if (cookieStr) {
    qSetCookie.run(cookieStr, COOKIE_CACHE.expiresAt);
    console.log(`🍪 Cookie salvo (TTL ~${ttlMin}min).`);
  }
}

// Lazy import do Playwright
async function ensurePlaywright() {
  try {
    const pw = await import('playwright');
    return pw;
  } catch {
    try {
      const pwc = await import('playwright-core');
      return pwc;
    } catch (e) {
      console.error('❌ Playwright não instalado! Execute:');
      console.error('   npm install playwright');
      console.error('   npx playwright install chromium');
      process.exit(1);
    }
  }
}

// Fecha o browser se estiver idle
async function checkBrowserIdle() {
  if (browserInstance && Date.now() - lastBrowserUse > BROWSER_IDLE_TIMEOUT) {
    console.log('🔄 Fechando browser idle...');
    try {
      await browserContext?.close();
      await browserInstance?.close();
    } catch {}
    browserContext = null;
    browserInstance = null;
  }
}

// Configura timer para checar browser idle
setInterval(checkBrowserIdle, 60000); // Check every minute

// Obtém ou cria contexto do browser
async function getBrowserContext() {
  lastBrowserUse = Date.now();
  
  if (browserContext) return browserContext;
  
  const pw = await ensurePlaywright();
  if (!pw) throw new Error('Playwright necessário');
  
  const headless = String(TRN_HEADLESS).toLowerCase() !== 'false';
  
  const launchOpts = {
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
  
  if (CHROME_EXE) launchOpts.executablePath = CHROME_EXE;
  
  console.log('🚀 Iniciando browser...');
  browserInstance = await pw.chromium.launch(launchOpts);
  
  browserContext = await browserInstance.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  
  // Se temos cookies salvos, aplica no contexto
  if (COOKIE_CACHE.value && Date.now() < COOKIE_CACHE.expiresAt) {
    const cookies = COOKIE_CACHE.value.split('; ').map(c => {
      const [name, value] = c.split('=');
      return {
        name,
        value,
        domain: '.tracker.gg',
        path: '/',
      };
    });
    await browserContext.addCookies(cookies);
    console.log('🍪 Cookies aplicados ao browser.');
  }
  
  return browserContext;
}

// Resolve plataforma
const PLATFORM_ALIASES = {
  ubisoft: 'pc', ubi: 'pc', uplay: 'pc',
  pc: 'pc',
  xbox: 'xbox', xbl: 'xbox',
  ps: 'psn', psn: 'psn', playstation: 'psn'
};
const PLATFORM = PLATFORM_ALIASES[String(TRN_PLATFORM || 'pc').toLowerCase()] || 'pc';

// URLs candidatas
function buildCandidates(username) {
  const nameEnc = encodeURIComponent(username);
  
  const uTrkUbiOverview = `https://tracker.gg/r6siege/profile/ubi/${nameEnc}/matches`;
  const uTrkPlatOverview = `https://tracker.gg/r6siege/profile/${PLATFORM}/${nameEnc}/overview`;
  const uR6UbiMatches = `https://tracker.gg/r6siege/profile/ubi/${nameEnc}/overview`;
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

// Fetch usando Playwright (muito mais robusto)
async function fetchWithPlaywright(url) {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  
  try {
    console.log(`🌐 Carregando: ${url}`);
    
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: parseInt(TRN_NAV_TIMEOUT_MS, 10) || 30000 
    });
    
    // Aguarda inicial
    await page.waitForTimeout(2000);
    
    // Verifica e aguarda Cloudflare
    let attempts = 0;
    while (attempts < 10) {
      const html = await page.content();
      if (!/cf-browser-verification|Just a moment|Checking your browser/i.test(html)) break;
      console.log('⏳ Aguardando Cloudflare...');
      await page.waitForTimeout(3000);
      attempts++;
    }
    
    // Aguarda conteúdo carregar
    try {
      await page.waitForSelector('.v3-match-row, .stat-list, .trn-profile', { timeout: 10000 });
    } catch {
      // Pode não ter partidas, continua
    }
    
    // Aguarda final para garantir
    await page.waitForTimeout(parseInt(TRN_CF_WAIT_MS, 10) || 5000);
    
    const finalHtml = await page.content();
    
    // Salva cookies atualizados
    const cookies = await ctx.cookies();
    const trnCookies = cookies.filter(c => 
      c.domain.includes('tracker.gg') || c.domain.includes('r6.tracker.network')
    );
    if (trnCookies.length > 0) {
      const cookieStr = trnCookies.map(c => `${c.name}=${c.value}`).join('; ');
      setCookieCache(cookieStr);
    }
    
    return finalHtml;
    
  } finally {
    await page.close();
  }
}

// Fetch de perfil com retry
async function fetchProfileHtml(username) {
  const candidates = buildCandidates(username);
  
  let lastErr;
  for (const url of candidates) {
    try {
      const html = await fetchWithPlaywright(url);
      return { url, html };
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ Falha em ${url}: ${e?.message || e}`);
      continue;
    }
  }
  
  throw new Error(`Falha ao carregar perfil ${username}: ${lastErr?.message || 'bloqueado'}`);
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

async function scrapeDailyBlocks(username) {
  const { url, html } = await fetchProfileHtml(username);
  const $ = cheerio.load(html, { 
    decodeEntities: false
  });
  
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
  
  $.root().empty(); // Limpa memória
  return { url, blocks };
}

// Utilitários para ontem
function yesterdayLabel(now = DateTime.now().setZone(TZ)) {
  return now.minus({ days: 1 }).setLocale('en-US').toFormat('MMM d');
}

function findHeaderForLabel($, label) {
  let target = null;
  $('header').each((_, el) => {
    const txt = $(el).find('div[class*="text-18"][class*="font-bold"][class*="text-secondary"]').first().text().trim();
    if (txt.toLowerCase() === String(label).toLowerCase()) {
      target = $(el);
      return false;
    }
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
  const k = readHeaderNumber($, header, 'K');
  const d = readHeaderNumber($, header, 'D');
  const hs = readHeaderNumber($, header, 'HS%');
  
  return { wins, losses, k, d, kd, hs };
}

// Filtros de janela temporal
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
    const start = prev.startOf('week');
    const end = prev.endOf('week');
    return { start, end };
  }
  if (kind === 'month') {
    const prev = now.minus({ months: 1 });
    const start = prev.startOf('month');
    const end = prev.endOf('month');
    return { start, end };
  }
  const start = now.startOf('day');
  return { start, end: start.endOf('day') };
}

function getYesterdayWindow(now = DateTime.now().setZone(TZ)) {
  const y = now.minus({ days: 1 }).startOf('day');
  return { start: y, end: y.endOf('day') };
}

// Agregação
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

// Embeds
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
    fmt('Quem mais matou', rankings.mostKills, (r) => `**${r.username}** — ${r.k}`),
    fmt('Quem mais morreu', rankings.mostDeaths, (r) => `**${r.username}** — ${r.d}`),
    fmt('Melhor K/D', rankings.bestKD, (r) => `**${r.username}** — ${r.kd.toFixed(2)}`),
    fmt('Melhor HS%', rankings.bestHS, (r) => `**${r.username}** — ${r.hs_pct.toFixed(1)}%`),
    fmt('Quem mais venceu', rankings.mostWins, (r) => `**${r.username}** — ${r.wins}`),
  ].join('\n\n');
  
  return new EmbedBuilder()
    .setTitle(`R6 — Ranking ${rangeTitle}`)
    .setDescription(desc)
    .setTimestamp(new Date());
}

// Coleta de dados
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
  for (const [idx, r] of rows.entries()) {
    if (idx > 0) await delay(2000); // 2s entre jogadores
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
  for (const [idx, r] of rows.entries()) {
    if (idx > 0) await delay(2000); // 2s entre jogadores
    try {
      const one = await collectForUserInWindow(r.username, start, end);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: e?.message || String(e) });
    }
  }
  return results;
}

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
  for (const [idx, r] of rows.entries()) {
    if (idx > 0) await delay(2000);
    try {
      const one = await collectYesterdayForUser(r.username);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: `Sem dados para ${label}` });
    }
  }
  return results;
}

// Rankings
function buildRankings(collected) {
  const flat = collected
    .filter(c => !c.error)
    .map(c => ({ username: c.username, ...c.agg }));
  
  const by = (k) => (a, b) => (b[k] - a[k]);
  
  return {
    mostKills: [...flat].sort(by('k')).slice(0, 5),
    mostDeaths: [...flat].sort(by('d')).slice(0, 5),
    bestKD: [...flat].sort((a, b) => b.kd - a.kd).slice(0, 5),
    bestHS: [...flat].sort((a, b) => b.hs_pct - a.hs_pct).slice(0, 5),
    mostWins: [...flat].sort(by('wins')).slice(0, 5),
  };
}

// Cron management
const guildCrons = new Map();

function parseHHmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s || '').trim());
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
  
  const dailyExpr = `${parsed.mm} ${parsed.hh} * * *`;
  const weeklyExpr = `${parsed.mm} ${parsed.hh} * * 1`;
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
  console.log(`🕒 Cronos instalados para guild ${guildId} @ ${time_str} (${TZ})`);
}

async function installAllCrons(client) {
  const rows = qAllSchedules.all();
  for (const r of rows) await installCronsForGuild(client, r.guild_id);
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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
    console.log('🌐 Comandos registrados globalmente.');
  }
}

// Carrega cookies ao iniciar
loadCookieFromDB();

client.once('ready', async () => {
  console.log(`✅ Logado como ${client.user.tag}`);
  for (const g of client.guilds.cache.values()) {
    console.log(`- ${g.name} (${g.id})`);
  }
  await registerSlashCommands();
  await installAllCrons(client);
});

// Helper de confirmação
async function confirm(ix, message, { ephemeral = false, edit = false } = {}) {
  const payload = typeof message === 'string' ? { content: message } : message;
  if (edit) return ix.editReply(payload);
  if (ix.deferred || ix.replied) return ix.followUp({ ...payload, ephemeral });
  return ix.reply({ ...payload, ephemeral });
}

// Handler: SLASH
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
    await confirm(ix, `✅ Programado!\n• Canal: ${channel}\n• Horário: **${horario} ${TZ}**`, { ephemeral: true });
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
    daily_report: 'day',
    weekly_report: 'week',
    monthly_report: 'month',
    daily_ranking: 'day',
    weekly_ranking: 'week',
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
      await confirm(ix, `🔎 Gerando relatório ${label} de **${nick}**…`);
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
    
    await confirm(ix, `🔎 Gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
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

// Handler: PREFIXO
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content?.trim();
  if (!content || !content.startsWith(PREFIX)) return;
  
  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  
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
    return send(`✅ Programado!\n• Canal: ${target}\n• Horário: **${horario} ${TZ}**`);
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
      if (!results.length) return send('⚠️ Nenhum jogador cadastrado.');
      const ok = results.filter(r => !r.error);
      if (!ok.length) return send(`⚠️ Ninguém jogou **${label}**.`);
      const rk = buildRankings(results);
      await send({ embeds: [embedRanking('— Ontem', rk)] });
      return;
    } catch (e) {
      console.error(e);
      return send('❌ Não consegui gerar agora. Tente novamente.');
    }
  }
  
  const rangeMap = {
    'daily_report': 'day',
    'weekly_report': 'week',
    'monthly_report': 'month',
    'daily_ranking': 'day',
    'weekly_ranking': 'week',
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
      await send(`🔎 Gerando relatório ${label} de **${singleNick}**…`);
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
    
    await send(`🔎 Gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
    try {
      const results = await collectForGuild(msg.guild.id, range);
      if (!results.length) return send('⚠️ Nenhum jogador cadastrado.');
      
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
      await send('❌ Não consegui gerar agora. Tente novamente.');
    }
    return;
  }
  
  if (cmd === 'help' || cmd === 'ajuda') {
    const eb = new EmbedBuilder()
      .setTitle('R6 — Ajuda')
      .setDescription(`Prefixo: **${PREFIX}**`)
      .addFields(
        {
          name: 'Cadastrar jogador (ADMIN)',
          value: `\`${PREFIX}cadastrar <nick>\``,
          inline: false
        },
        {
          name: 'Programar envios (ADMIN)',
          value: `\`${PREFIX}programar #canal HH:mm\``,
          inline: false
        },
        {
          name: 'Relatórios',
          value: [
            `\`${PREFIX}daily_report [nick]\``,
            `\`${PREFIX}weekly_report [nick]\``,
            `\`${PREFIX}monthly_report [nick]\``,
          ].join('\n'),
          inline: false
        },
        {
          name: 'Rankings',
          value: [
            `\`${PREFIX}daily_ranking\``,
            `\`${PREFIX}yesterday_ranking\``,
            `\`${PREFIX}weekly_ranking\``,
            `\`${PREFIX}monthly_ranking\``,
          ].join('\n'),
          inline: false
        }
      )
      .setTimestamp(new Date());
    return send({ embeds: [eb] });
  }
});

// Cleanup ao desligar
process.on('SIGINT', async () => {
  console.log('\n🛑 Encerrando bot...');
  try {
    await browserContext?.close();
    await browserInstance?.close();
  } catch {}
  process.exit(0);
});

client.login(DISCORD_TOKEN);