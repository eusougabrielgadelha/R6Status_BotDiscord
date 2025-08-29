// index.js
import dotenv from 'dotenv';
dotenv.config();

const fs = require('fs/promises');
const path = require('path');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  REST,
  Routes,
} = require('discord.js');

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = require('puppeteer-extra');
puppeteer.use(StealthPlugin());

// ========================= ENV / CONSTS =========================
const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.APP_ID;             // Application (client) ID
const GUILD_ID = process.env.GUILD_ID || null; // Opcional (registro rápido)
const TZ = process.env.TZ || 'America/Fortaleza';
const EXTRA_WAIT_MS = parseInt(process.env.EXTRA_WAIT_MS || '12000', 10);
const CHROME_EXE = process.env.CHROME_EXE || ''; // ex: /snap/bin/chromium
const HEADFUL = !!process.env.HEADFUL;

// Prefixo para comandos por texto
const PREFIX = '!';

// Arquivos de dados
const DATA_DIR = path.join(process.cwd(), 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');

// ========================= DISCORD CLIENT =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ========================= UTILS: FS =========================
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}
async function loadJSON(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function saveJSON(file, obj) {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ========================= UTILS: PLAYERS =========================
async function getPlayers() {
  return await loadJSON(PLAYERS_FILE, []);
}
async function addPlayer(nick) {
  const players = await getPlayers();
  const exists = players.find(p => p.toLowerCase() === nick.toLowerCase());
  if (!exists) {
    players.push(nick);
    await saveJSON(PLAYERS_FILE, players);
  }
  return players;
}

// ========================= PUPPETEER LAUNCH =========================
async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process',
    '--disable-features=site-per-process',
  ];

  const launchOpts = {
    headless: HEADFUL ? false : 'new',
    args,
  };
  if (CHROME_EXE) {
    launchOpts.executablePath = CHROME_EXE;
  }
  return await puppeteer.launch(launchOpts);
}

// ========================= SCRAPER =========================
// Helpers de parsing
function parseIntSafe(txt) {
  if (!txt) return null;
  const n = parseInt(String(txt).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function parseFloatSafe(txt) {
  if (!txt) return null;
  const n = parseFloat(String(txt).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "Aug 29" em ISO com ano correto
function parseDateLabelToISO(label, now = DateTime.now().setZone(TZ)) {
  if (!label) return null;
  let dt = DateTime.fromFormat(label.trim(), 'LLL dd', { locale: 'en' });
  if (!dt.isValid) return null;
  let candidate = dt.set({ year: now.year }).setZone(TZ);
  // Ajuste de virada de ano (Ex: Jan 01 quando estamos em Dez 31)
  if (candidate > now.plus({ days: 2 })) candidate = candidate.minus({ years: 1 });
  if (candidate < now.minus({ years: 1 })) candidate = candidate.plus({ years: 1 });
  return candidate.toISODate();
}

function labelFromDate(dt) {
  return dt.setLocale('en').toFormat('LLL dd'); // "Aug 29"
}

function filterBlocksYesterday(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const now = DateTime.now().setZone(TZ);
  const lblToday = labelFromDate(now);
  const lblYest = labelFromDate(now.minus({ days: 1 }));

  const exact = blocks.filter(b => (b.dateLabel || '').trim() === lblYest);
  if (exact.length) return exact;

  const first = blocks[0]?.dateLabel?.trim();
  const second = blocks[1]?.dateLabel?.trim();
  if (first === lblToday && second) return [blocks[1]];
  if (first === lblYest) return [blocks[0]];
  return [];
}

function filterBlocksToday(blocks) {
  const now = DateTime.now().setZone(TZ);
  const lblToday = labelFromDate(now);
  const exact = blocks.filter(b => (b.dateLabel || '').trim() === lblToday);
  if (exact.length) return exact;
  // fallback: primeiro bloco se ele não for explicitamente "ontem"
  const first = blocks[0]?.dateLabel?.trim();
  const yest = labelFromDate(now.minus({ days: 1 }));
  if (first && first !== yest) return [blocks[0]];
  return [];
}

function filterBlocksByRange(blocks, range, opts = {}) {
  // ranges: 'day', 'yesterday', 'week', 'month'
  // opções extras para agendamentos: {usePreviousWeek, usePreviousMonth}
  if (range === 'yesterday') return filterBlocksYesterday(blocks);
  if (range === 'day') return filterBlocksToday(blocks);

  const today = DateTime.now().setZone(TZ).startOf('day');
  let start, end;

  if (range === 'week') {
    // últimos 7 dias incluindo hoje
    start = today.minus({ days: 6 });
    end = today.endOf('day');
  } else if (range === 'month') {
    // últimos 30 dias incluindo hoje
    start = today.minus({ days: 29 });
    end = today.endOf('day');
  } else {
    start = today;
    end = today.endOf('day');
  }

  if (opts.usePreviousWeek) {
    // Semana anterior: 7 dias terminando ontem
    end = today.minus({ days: 1 }).endOf('day');
    start = end.minus({ days: 6 }).startOf('day');
  }

  if (opts.usePreviousMonth) {
    // Mês anterior completo (independente do dia atual)
    const firstOfThisMonth = today.startOf('month');
    const endPrev = firstOfThisMonth.minus({ days: 1 }).endOf('day');
    const startPrev = endPrev.startOf('month');
    start = startPrev;
    end = endPrev;
  }

  return blocks
    .map(b => ({ ...b, iso: parseDateLabelToISO(b.dateLabel, today) }))
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ });
      return dt >= start && dt <= end;
    });
}

async function scrapePlayerDailyBlocks(browser, username) {
  const url = `https://r6.tracker.network/r6siege/profile/ubi/${encodeURIComponent(username)}/overview`;
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Espera aparição de algum container dos cards de dias (tolerante)
    await page.waitForSelector('div.col-span-full.grid.grid-cols-subgrid.gap-5 header', { timeout: 45000 })
      .catch(() => {});

    // Espera extra para métricas carregarem (controlado por ENV)
    if (EXTRA_WAIT_MS > 0) {
      await page.waitForTimeout(EXTRA_WAIT_MS);
    }

    // Extrai blocos por dia (mantém ordem: primeiro = hoje)
    const blocks = await page.$$eval(
      'div.col-span-full.grid.grid-cols-subgrid.gap-5',
      (cards) => {
        const out = [];
        for (const card of cards) {
          const header = card.querySelector('header');
          if (!header) continue;

          const dateEl = header.querySelector('.text-18.font-bold.text-secondary');
          const dateLabel = (dateEl?.textContent || '').trim();

          // Wins/Losses
          const winsRaw = (header.querySelector('.stat-list .value.text-green')?.textContent || '').trim();
          const lossesRaw = (header.querySelector('.stat-list .value.text-red')?.textContent || '').trim();

          // Busca valores pelo label exato (K/D, K, D, HS%)
          function getByLabel(lbl) {
            const groups = header.querySelectorAll('.name-value');
            for (const g of groups) {
              const nameEl = g.querySelector('.stat-name .truncate');
              if (nameEl && nameEl.textContent && nameEl.textContent.trim() === lbl) {
                const val = g.querySelector('.stat-value span');
                if (val) return val.textContent.trim();
              }
            }
            return null;
          }
          const kdRaw = getByLabel('K/D');
          const kRaw = getByLabel('K');
          const dRaw = getByLabel('D');
          const hsRaw = getByLabel('HS%');

          // Ao menos precisa do dateLabel
          if (!dateLabel) continue;

          out.push({
            dateLabel,
            winsRaw,
            lossesRaw,
            kdRaw,
            kRaw,
            dRaw,
            hsRaw,
          });

          // Limita para no máx 20 dias (segurança)
          if (out.length >= 20) break;
        }
        return out;
      }
    );

    // Parseia
    const parsed = blocks.map(b => ({
      dateLabel: b.dateLabel,
      wins: parseIntSafe(b.winsRaw),
      losses: parseIntSafe(b.lossesRaw),
      kd: parseFloatSafe(b.kdRaw),
      k: parseIntSafe(b.kRaw),
      d: parseIntSafe(b.dRaw),
      hs_pct: parseFloatSafe(b.hsRaw),
      raw: b,
    }));

    return {
      username,
      url,
      blocks: parsed,
    };
  } catch (err) {
    return { username, url, error: String(err), blocks: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

// ========================= AGREGAÇÃO / RANK =========================
function aggregateBlocks(blocks) {
  // Soma wins, losses, K, D; KD = totalK/totalD; HS% = média ponderada por K
  const agg = {
    days: 0,
    wins: 0,
    losses: 0,
    k: 0,
    d: 0,
    kd: null,
    hs_pct: null,
  };
  if (!blocks || !blocks.length) return agg;
  let hsWeightedSum = 0;
  let hsWeight = 0;

  for (const b of blocks) {
    agg.days += 1;
    agg.wins += b.wins || 0;
    agg.losses += b.losses || 0;
    agg.k += b.k || 0;
    agg.d += b.d || 0;
    if (typeof b.hs_pct === 'number' && typeof b.k === 'number') {
      hsWeightedSum += b.hs_pct * b.k;
      hsWeight += b.k;
    }
  }

  agg.kd = agg.d > 0 ? agg.k / agg.d : (agg.k > 0 ? Infinity : 0);
  agg.hs_pct = hsWeight > 0 ? hsWeightedSum / hsWeight : null;
  return agg;
}

function buildRankings(perPlayer) {
  // perPlayer: { username: {wins, losses, k, d, kd, hs_pct, days} }
  const entries = Object.entries(perPlayer);

  function topBy(field, desc = true) {
    const list = entries
      .map(([u, v]) => ({ user: u, ...v }))
      .filter(x => typeof x[field] === 'number' && Number.isFinite(x[field]));
    list.sort((a, b) => desc ? (b[field] - a[field]) : (a[field] - b[field]));
    return list;
  }

  const topWins = topBy('wins', true);
  const topKills = topBy('k', true);
  const topDeaths = topBy('d', true);
  const topKD = entries
    .map(([u, v]) => ({ user: u, ...v }))
    .filter(x => Number.isFinite(x.kd))
    .sort((a, b) => b.kd - a.kd);
  const topHS = entries
    .map(([u, v]) => ({ user: u, ...v }))
    .filter(x => typeof x.hs_pct === 'number')
    .sort((a, b) => b.hs_pct - a.hs_pct);

  return { topWins, topKills, topDeaths, topKD, topHS };
}

function fmtTop(list, field, unit = '', limit = 5, digits = 2) {
  return list.slice(0, limit)
    .map((x, i) => {
      let val = x[field];
      if (field === 'kd') val = (val === Infinity) ? '∞' : val.toFixed(digits);
      else if (field === 'hs_pct') val = `${val.toFixed(1)}%`;
      return `**${i + 1}.** ${x.user} — **${val}${unit}**`;
    })
    .join('\n');
}

// ========================= EMBEDS =========================
function embedReportOne(user, range, agg, url) {
  const titleMap = {
    day: 'Relatório Diário',
    yesterday: 'Relatório de Ontem',
    week: 'Relatório Semanal',
    month: 'Relatório Mensal',
  };
  const title = `${titleMap[range] || 'Relatório'} — ${user}`;

  const emb = new EmbedBuilder()
    .setTitle(title)
    .setURL(url)
    .setColor(0x2b6cb0)
    .setTimestamp(new Date())
    .addFields(
      { name: 'Dias cobertos', value: String(agg.days), inline: true },
      { name: 'Vitórias', value: String(agg.wins), inline: true },
      { name: 'Derrotas', value: String(agg.losses), inline: true },
      { name: 'Kills', value: String(agg.k), inline: true },
      { name: 'Deaths', value: String(agg.d), inline: true },
      { name: 'K/D', value: Number.isFinite(agg.kd) ? agg.kd.toFixed(2) : (agg.kd === Infinity ? '∞' : '0.00'), inline: true },
      { name: 'HS%', value: (typeof agg.hs_pct === 'number') ? `${agg.hs_pct.toFixed(1)}%` : '—', inline: true }
    );
  return emb;
}

function embedRanking(range, ranks, metaTitle) {
  const titleMap = {
    day: 'Ranking Diário',
    yesterday: 'Ranking de Ontem',
    week: 'Ranking Semanal',
    month: 'Ranking Mensal',
  };
  const emb = new EmbedBuilder()
    .setTitle(`${titleMap[range] || 'Ranking'}${metaTitle ? ` — ${metaTitle}` : ''}`)
    .setColor(0x00b894)
    .setTimestamp(new Date());

  emb.addFields(
    { name: 'Quem mais venceu?', value: ranks.topWins.length ? fmtTop(ranks.topWins, 'wins') : '—' },
    { name: 'Quem mais matou?', value: ranks.topKills.length ? fmtTop(ranks.topKills, 'k') : '—' },
    { name: 'Quem mais morreu?', value: ranks.topDeaths.length ? fmtTop(ranks.topDeaths, 'd') : '—' },
    { name: 'Melhor K/D', value: ranks.topKD.length ? fmtTop(ranks.topKD, 'kd') : '—' },
    { name: 'Melhor HS%', value: ranks.topHS.length ? fmtTop(ranks.topHS, 'hs_pct') : '—' },
  );
  return emb;
}

// ========================= COLETORES (PLAYER(S)) =========================
async function collectForPlayers(range, { onePlayer = null, scheduleOpts = {} } = {}) {
  // range: 'day' | 'yesterday' | 'week' | 'month'
  const list = onePlayer ? [onePlayer] : await getPlayers();
  if (!list.length) {
    return { perPlayer: {}, detail: [] };
  }

  const browser = await launchBrowser();
  const perPlayer = {};
  const detail = []; // [{user, url, agg, usedBlocks}]

  try {
    // Coleta sequencial para evitar bloqueios do site
    for (const user of list) {
      const res = await scrapePlayerDailyBlocks(browser, user);
      if (res.error) {
        perPlayer[user] = { days: 0, wins: 0, losses: 0, k: 0, d: 0, kd: 0, hs_pct: null, error: res.error };
        detail.push({ user, url: res.url, agg: perPlayer[user], usedBlocks: [], error: res.error });
        continue;
      }
      const selected = filterBlocksByRange(res.blocks, range, scheduleOpts);
      const agg = aggregateBlocks(selected);
      perPlayer[user] = agg;
      detail.push({ user, url: res.url, agg, usedBlocks: selected });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { perPlayer, detail };
}

// ========================= MENSAGENS / OUTPUT =========================
async function sendReportMessage(channel, range, perPlayer, detail) {
  // Para report listamos todos jogadores (cada um um embed)
  if (!detail.length) {
    await channel.send('Nenhum jogador cadastrado.');
    return;
  }
  const embeds = detail.map(d => embedReportOne(d.user, range, d.agg, d.url));
  // Em lotes de 10 embeds (limite do Discord por msg)
  for (let i = 0; i < embeds.length; i += 10) {
    await channel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

async function sendRankingMessage(channel, range, perPlayer, metaTitle) {
  const ranks = buildRankings(perPlayer);
  const emb = embedRanking(range, ranks, metaTitle);
  await channel.send({ embeds: [emb] });
}

// ========================= PERMISSÕES =========================
function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

// ========================= SCHEDULER =========================
let scheduledJobs = []; // [{type, task, channelId, guildId, time, createdBy}]

async function loadSchedules() {
  const list = await loadJSON(SCHEDULES_FILE, []);
  // Re-hidratar jobs
  for (const s of list) {
    scheduleAllForChannel(s.guildId, s.channelId, s.time, s.createdBy, { persist: false });
  }
}

async function persistSchedules() {
  const toSave = scheduledJobs.map(j => ({
    type: j.type,
    channelId: j.channelId,
    guildId: j.guildId,
    time: j.time,
    createdBy: j.createdBy,
  }));
  await saveJSON(SCHEDULES_FILE, toSave);
}

function parseHHmm(str) {
  // "23:55" -> {h:23, m:55}
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

function scheduleAllForChannel(guildId, channelId, timeHHmm = '23:55', createdBy = 'system', { persist = true } = {}) {
  const t = parseHHmm(timeHHmm) || { h: 23, m: 55 };

  // 1) Ranking DIÁRIO (todos os dias no horário), cobrindo dia atual
  const cronDaily = `${t.m} ${t.h} * * *`;
  const task1 = cron.schedule(cronDaily, async () => {
    try {
      const ch = await client.channels.fetch(channelId);
      const { perPlayer } = await collectForPlayers('day');
      await sendRankingMessage(ch, 'day', perPlayer, null);
    } catch (e) {
      console.error('Erro job diário:', e);
    }
  }, { timezone: TZ });

  scheduledJobs.push({ type: 'daily_ranking', task: task1, channelId, guildId, time: timeHHmm, createdBy });

  // 2) Ranking SEMANAL (toda segunda no horário) — semana anterior
  // Segunda-feira = 1 no padrão cron (0 = Domingo)
  const cronWeekly = `${t.m} ${t.h} * * 1`;
  const task2 = cron.schedule(cronWeekly, async () => {
    try {
      const ch = await client.channels.fetch(channelId);
      const { perPlayer } = await collectForPlayers('week', { scheduleOpts: { usePreviousWeek: true } });
      await sendRankingMessage(ch, 'week', perPlayer, 'Semana Anterior');
    } catch (e) {
      console.error('Erro job semanal:', e);
    }
  }, { timezone: TZ });

  scheduledJobs.push({ type: 'weekly_ranking', task: task2, channelId, guildId, time: timeHHmm, createdBy });

  // 3) Ranking MENSAL (todo dia 1 no horário) — mês anterior
  const cronMonthly = `${t.m} ${t.h} 1 * *`;
  const task3 = cron.schedule(cronMonthly, async () => {
    try {
      const ch = await client.channels.fetch(channelId);
      const { perPlayer } = await collectForPlayers('month', { scheduleOpts: { usePreviousMonth: true } });
      await sendRankingMessage(ch, 'month', perPlayer, 'Mês Anterior');
    } catch (e) {
      console.error('Erro job mensal:', e);
    }
  }, { timezone: TZ });

  scheduledJobs.push({ type: 'monthly_ranking', task: task3, channelId, guildId, time: timeHHmm, createdBy });

  if (persist) persistSchedules().catch(console.error);
}

async function cancelSchedules(guildId, channelId = null) {
  scheduledJobs = scheduledJobs.filter(j => {
    const matchGuild = j.guildId === guildId;
    const matchChannel = channelId ? (j.channelId === channelId) : true;
    if (matchGuild && matchChannel) {
      try { j.task.stop(); } catch {}
      return false; // remove
    }
    return true; // mantém
  });
  await persistSchedules();
}

// ========================= HELP TEXT =========================
function buildHelp(prefix = PREFIX) {
  return [
    `**Comandos do R6 Status Bot**`,
    ``,
    `**Cadastro** (apenas admins — requer *Manage Server*):`,
    `• \`${prefix}cadastrar <nick-ubisoft>\` — adiciona um jogador à lista de rastreio.`,
    ``,
    `**Relatórios individuais** (abertos):`,
    `• \`${prefix}daily_report [nick]\` — relatório de **hoje**. Se omitir o nick, traz todos os cadastrados.`,
    `• \`${prefix}weekly_report [nick]\` — últimos **7 dias** (inclui hoje).`,
    `• \`${prefix}monthly_report [nick]\` — últimos **30 dias** (inclui hoje).`,
    ``,
    `**Rankings** (abertos):`,
    `• \`${prefix}yesterday_ranking\` — ranking **de ontem** (usa o cartão do dia anterior do TRN).`,
    `• \`${prefix}daily_ranking\` — ranking **de hoje**.`,
    `• \`${prefix}weekly_ranking\` — ranking dos **últimos 7 dias**.`,
    `• \`${prefix}monthly_ranking\` — ranking dos **últimos 30 dias**.`,
    ``,
    `**Agendamentos** (apenas admins — requer *Manage Server*):`,
    `• \`${prefix}programar <channelId> <HH:mm>\` — agenda envios automáticos de **rankings**:`,
    `   - Diário: todo dia no horário definido (ex.: 23:55).`,
    `   - Semanal: toda segunda no mesmo horário, cobrindo a **semana anterior**.`,
    `   - Mensal: todo dia 1 no mesmo horário, cobrindo o **mês anterior**.`,
    `• \`${prefix}cancelar-programação [channelId]\` — cancela os envios do servidor (ou apenas do canal, se informado).`,
    ``,
    `**Observações**`,
    `• Timezone: \`${TZ}\`.`,
    `• O TRN pode levar alguns segundos para renderizar; o bot aguarda \`${EXTRA_WAIT_MS}ms\`.`,
    `• Chromium customizado: \`${CHROME_EXE || 'auto'}\`.`,
  ].join('\n');
}

// ========================= COMMAND HANDLERS =========================
async function handleCadastrar(msg, args) {
  if (!isAdmin(msg.member)) {
    await msg.reply('❌ Você precisa de **Manage Server** para usar este comando.');
    return;
  }
  const nick = args.join(' ').trim();
  if (!nick) {
    await msg.reply(`Uso: \`${PREFIX}cadastrar <nick-ubisoft>\``);
    return;
  }
  await addPlayer(nick);
  await msg.reply(`✅ **${nick}** cadastrado! Use \`${PREFIX}daily_ranking\` para ver o ranking de hoje.`);
}

async function handleReport(msg, range, args) {
  const single = args.join(' ').trim() || null;
  const { perPlayer, detail } = await collectForPlayers(range, { onePlayer: single });
  // Confirmação curta
  await msg.reply(`📊 Gerando **${range === 'day' ? 'relatório diário' : range === 'week' ? 'relatório semanal' : range === 'month' ? 'relatório mensal' : 'relatório'}** ${single ? `de **${single}**` : 'de todos os jogadores'}…`);
  await sendReportMessage(msg.channel, range, perPlayer, detail);
}

async function handleRanking(msg, range) {
  const { perPlayer } = await collectForPlayers(range);
  // Confirmação curta
  const titles = { day: 'Ranking Diário', yesterday: 'Ranking de Ontem', week: 'Ranking Semanal', month: 'Ranking Mensal' };
  await msg.reply(`🏆 Gerando **${titles[range] || 'Ranking'}**…`);
  await sendRankingMessage(msg.channel, range, perPlayer, (range === 'yesterday') ? null : null);
}

async function handleProgramar(msg, args) {
  if (!isAdmin(msg.member)) {
    await msg.reply('❌ Você precisa de **Manage Server** para usar este comando.');
    return;
  }
  const [channelId, time] = args;
  if (!channelId || !time) {
    await msg.reply(`Uso: \`${PREFIX}programar <channelId> <HH:mm>\`\nEx.: \`${PREFIX}programar ${msg.channel.id} 23:55\``);
    return;
  }
  // Valida canal
  let ch;
  try {
    ch = await client.channels.fetch(channelId);
  } catch {
    await msg.reply('❌ Canal inválido ou inacessível.');
    return;
  }
  if (!parseHHmm(time)) {
    await msg.reply('❌ Horário inválido. Use `HH:mm` (ex.: 23:55).');
    return;
  }

  scheduleAllForChannel(msg.guild.id, channelId, time, msg.author.id);
  await persistSchedules();

  await msg.reply(
    [
      `✅ Programação criada para <#${channelId}> às **${time}** (timezone \`${TZ}\`):`,
      `• **Ranking diário** (todo dia)`,
      `• **Ranking semanal** (toda segunda — semana anterior)`,
      `• **Ranking mensal** (todo dia 1 — mês anterior)`,
    ].join('\n')
  );
}

async function handleCancelarProgramacao(msg, args) {
  if (!isAdmin(msg.member)) {
    await msg.reply('❌ Você precisa de **Manage Server** para usar este comando.');
    return;
  }
  const channelId = args[0] || null;
  await cancelSchedules(msg.guild.id, channelId);
  await msg.reply(channelId
    ? `🛑 Programações do canal <#${channelId}> canceladas.`
    : '🛑 Todas as programações deste servidor foram canceladas.');
}

async function handleHelp(msg) {
  await msg.reply(buildHelp(PREFIX));
}

// ========================= MESSAGE & SLASH HANDLERS =========================
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return;

    // Prefixo
    if (!msg.content.startsWith(PREFIX)) return;

    const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const c = cmd.toLowerCase();

    if (c === 'help') return handleHelp(msg);
    if (c === 'cadastrar') return handleCadastrar(msg, args);
    if (c === 'programar') return handleProgramar(msg, args);
    if (c === 'cancelar-programação' || c === 'cancelar-programacao') return handleCancelarProgramacao(msg, args);

    if (c === 'daily_report') return handleReport(msg, 'day', args);
    if (c === 'weekly_report') return handleReport(msg, 'week', args);
    if (c === 'monthly_report') return handleReport(msg, 'month', args);

    if (c === 'yesterday_ranking') return handleRanking(msg, 'yesterday');
    if (c === 'daily_ranking') return handleRanking(msg, 'day');
    if (c === 'weekly_ranking') return handleRanking(msg, 'week');
    if (c === 'monthly_ranking') return handleRanking(msg, 'month');
  } catch (err) {
    console.error('Erro handler message:', err);
    try { await msg.reply('⚠️ Ocorreu um erro ao processar seu comando.'); } catch {}
  }
});

// Opcional: se você já registrou *slash commands* com register.js, eles serão atendidos aqui:
client.on('interactionCreate', async (itx) => {
  if (!itx.isChatInputCommand()) return;
  try {
    const name = itx.commandName;

    // Confirmação imediata (evitar timeout)
    await itx.deferReply({ ephemeral: true });

    if (name === 'cadastrar') {
      if (!isAdmin(itx.member)) return itx.editReply('❌ Requer **Manage Server**.');
      const nick = itx.options.getString('nick', true);
      await addPlayer(nick);
      return itx.editReply(`✅ **${nick}** cadastrado!`);
    }

    if (name === 'programar') {
      if (!isAdmin(itx.member)) return itx.editReply('❌ Requer **Manage Server**.');
      const channel = itx.options.getChannel('canal', true);
      const time = itx.options.getString('hora', true);
      if (!parseHHmm(time)) return itx.editReply('❌ Horário inválido. Use HH:mm');

      scheduleAllForChannel(itx.guild.id, channel.id, time, itx.user.id);
      await persistSchedules();
      return itx.editReply(`✅ Programado em ${channel} às **${time}**.`);
    }

    if (name === 'cancelar-programacao') {
      if (!isAdmin(itx.member)) return itx.editReply('❌ Requer **Manage Server**.');
      const channel = itx.options.getChannel('canal', false);
      await cancelSchedules(itx.guild.id, channel?.id || null);
      return itx.editReply(channel ? `🛑 Cancelado para ${channel}.` : '🛑 Todas as programações canceladas.');
    }

    // Reports
    if (name === 'daily_report' || name === 'weekly_report' || name === 'monthly_report') {
      const range = name.split('_')[0]; // daily|weekly|monthly
      const nick = itx.options.getString('nick', false) || null;
      const map = { daily: 'day', weekly: 'week', monthly: 'month' };
      const { perPlayer, detail } = await collectForPlayers(map[range], { onePlayer: nick });
      await itx.editReply('📊 Ok! Enviando no canal atual…');
      await sendReportMessage(itx.channel, map[range], perPlayer, detail);
      return;
    }

    // Rankings
    if (name === 'yesterday_ranking' || name === 'daily_ranking' || name === 'weekly_ranking' || name === 'monthly_ranking') {
      const map = {
        yesterday_ranking: 'yesterday',
        daily_ranking: 'day',
        weekly_ranking: 'week',
        monthly_ranking: 'month',
      };
      const range = map[name];
      const { perPlayer } = await collectForPlayers(range);
      await itx.editReply('🏆 Ok! Enviando ranking no canal…');
      await sendRankingMessage(itx.channel, range, perPlayer, null);
      return;
    }

    if (name === 'help') {
      await itx.editReply('📬 Enviei o guia no canal.');
      await itx.channel.send(buildHelp('/')); // se quiser explicar versão slash
      return;
    }

    await itx.editReply('Comando desconhecido.');
  } catch (err) {
    console.error('Erro interaction:', err);
    try { await itx.editReply('⚠️ Ocorreu um erro ao processar seu comando.'); } catch {}
  }
});

// ========================= (OPCIONAL) REGISTRAR SLASH (AUTO) =========================
// Se preferir registrar automaticamente ao iniciar (GUILD ou GLOBAL):
async function registerSlashCommands() {
  if (!APP_ID || !TOKEN) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  const commands = [
    {
      name: 'cadastrar',
      description: 'Adicionar jogador (admin)',
      default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
      dm_permission: false,
      options: [{ name: 'nick', description: 'Nick Ubisoft', type: 3, required: true }],
    },
    {
      name: 'programar',
      description: 'Agendar rankings (admin)',
      default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
      dm_permission: false,
      options: [
        { name: 'canal', description: 'Canal', type: 7, required: true },
        { name: 'hora', description: 'HH:mm (ex.: 23:55)', type: 3, required: true },
      ],
    },
    {
      name: 'cancelar-programacao',
      description: 'Cancelar agendamentos (admin)',
      default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
      dm_permission: false,
      options: [
        { name: 'canal', description: 'Canal (opcional)', type: 7, required: false },
      ],
    },
    { name: 'daily_report', description: 'Relatório de hoje', options: [{ name: 'nick', description: 'Nick (opcional)', type: 3, required: false }] },
    { name: 'weekly_report', description: 'Relatório da semana', options: [{ name: 'nick', description: 'Nick (opcional)', type: 3, required: false }] },
    { name: 'monthly_report', description: 'Relatório do mês', options: [{ name: 'nick', description: 'Nick (opcional)', type: 3, required: false }] },
    { name: 'yesterday_ranking', description: 'Ranking de ontem' },
    { name: 'daily_ranking', description: 'Ranking de hoje' },
    { name: 'weekly_ranking', description: 'Ranking da semana' },
    { name: 'monthly_ranking', description: 'Ranking do mês' },
    { name: 'help', description: 'Ajuda' },
  ];

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
      console.log('[slash] Comandos GUILD registrados.');
    } else {
      await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
      console.log('[slash] Comandos GLOBAL registrados (podem demorar a aparecer).');
    }
  } catch (e) {
    console.error('Erro registrando slash commands:', e);
  }
}

// ========================= STARTUP =========================
client.once('ready', async () => {
  console.log(`✅ Logado como ${client.user.tag}`);
  await ensureDataDir();
  await loadSchedules();
  // (Opcional) registrar slash ao subir:
  await registerSlashCommands();
});

client.login(TOKEN).catch(err => {
  console.error('Falha no login do bot:', err);
});
