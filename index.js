// topo do index.js (ESM)
import dotenv from 'dotenv';
dotenv.config({ quiet: true }); // silencia os logs “injecting env”

import {
  Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder,
} from 'discord.js';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';

// -----------------------------------------------------------------------------
// 2) Configurações
const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.APP_ID;
const GUILD_ID = process.env.GUILD_ID; // opcional (registro de /comandos no servidor)
const PREFIX = process.env.PREFIX || '!';
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const PLAYERS =
  (process.env.PLAYERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Arquivo para persistir agendamentos por servidor
const DATA_DIR = path.resolve('./data');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedules.json');

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN ausente no .env');
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULE_FILE)) fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({}), 'utf8');

// -----------------------------------------------------------------------------
// 3) Cliente do Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// -----------------------------------------------------------------------------
// 4) Utilidades de data / hora
const MONTHS_EN = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
function toDateKey(d) {
  // yyyy-mm-dd no fuso configurado (vamos normalizar para meia-noite local)
  const d2 = new Date(d);
  const yyyy = d2.getFullYear();
  const mm = String(d2.getMonth() + 1).padStart(2, '0');
  const dd = String(d2.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function nowTz() {
  // Data atual como objeto Date ajustado pelo fuso no formato "yyyy-MM-ddTHH:mm:ss"
  // Para comparação de dias, usaremos apenas ano/mês/dia.
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}
function startOfDayTz(d) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}
function addDays(d, n) {
  const z = new Date(d);
  z.setDate(z.getDate() + n);
  return z;
}
function lastWeekRange(refDate = nowTz()) {
  // Segunda a Domingo da semana ANTERIOR ao refDate
  const day = refDate.getDay(); // 0=Domingo
  const thisMonday = addDays(startOfDayTz(refDate), -((day + 6) % 7));
  const lastMonday = addDays(thisMonday, -7);
  const lastSunday = addDays(lastMonday, 6);
  return { start: lastMonday, end: lastSunday };
}
function lastMonthRange(refDate = nowTz()) {
  const y = refDate.getFullYear();
  const m = refDate.getMonth();
  // mês anterior
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // último dia do mês anterior
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
function parseMonthDayEn(text) {
  // Ex.: "Aug 29" → Date (ano inferido)
  const m = text.trim().match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/);
  if (!m) return null;
  const now = nowTz();
  let year = now.getFullYear();
  const month = MONTHS_EN[m[1]];
  const day = parseInt(m[2], 10);

  // Se estamos em janeiro e a página mostra Dezembro, pode ser do ano anterior
  if (now.getMonth() === 0 && month === 11) year = now.getFullYear() - 1;

  const dt = new Date(year, month, day);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function formatPct(v) {
  if (isNaN(v)) return '0%';
  return `${(v * 100).toFixed(1)}%`;
}
function safeDiv(a, b) {
  if (!b) return a > 0 ? Infinity : 0;
  return a / b;
}

// -----------------------------------------------------------------------------
// 5) Scraper R6 Tracker (perfil público)
//    URL base: https://r6.tracker.network/profile/pc/<NICK>
//    Pegamos os blocos por dia (Aug 29, Aug 28, ...), e para cada partida
//    extraímos W/L, K/D/A, HS%.
// -----------------------------------------------------------------------------
async function fetchProfileHtml(nick) {
  const url = `https://r6.tracker.network/profile/pc/${encodeURIComponent(nick)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Falha ao carregar perfil ${nick}: ${res.status}`);
  return await res.text();
}

/**
 * Retorna um mapa { 'YYYY-MM-DD': [ { win, kills, deaths, hsPct } ... ] }
 */
async function getMatchesByDay(nick) {
  const html = await fetchProfileHtml(nick);
  const $ = cheerio.load(html);

  const result = {};

  // Cada "dia" fica num container que tem um <header> com o texto tipo "Aug 29"
  $('div.col-span-full.grid.grid-cols-subgrid.gap-5').each((_, section) => {
    const headerText = $(section).find('header .text-18.font-bold.text-secondary').first().text().trim();
    const dt = parseMonthDayEn(headerText);
    if (!dt) return;

    const dateKey = toDateKey(dt);
    const dayMatches = [];

    // Dentro do mesmo container, todas as linhas de partida:
    $(section)
      .find('.v3-match-row')
      .each((__, row) => {
        const $row = $(row);
        const isWin = $row.hasClass('v3-match-row--win');

        // K/D/A
        let kills = 0, deaths = 0;
        const kdList = $row.find('.v3-separate-slash .value');
        if (kdList.length >= 2) {
          kills = parseInt($(kdList[0]).text().trim(), 10) || 0;
          deaths = parseInt($(kdList[1]).text().trim(), 10) || 0;
        } else {
          // fallback: tenta pegar o "K/D" arredondado e inferir com deaths=1 (pouco provável, mas evita NaN)
          const kdTxt = $row.find('.stat-name:contains("K/D")').parent().find('.stat-value').first().text().trim();
          const kd = parseFloat(kdTxt.replace(',', '.')) || 0;
          deaths = kd > 0 ? 1 : 0;
          kills = Math.round(kd * deaths);
        }

        // HS %
        let hsPct = 0;
        const hsTxt = $row
          .find('.stat-name:contains("HS")')
          .parent()
          .find('.stat-value')
          .first()
          .text()
          .trim()
          .replace('%', '')
          .replace(',', '.');
        const hsParsed = parseFloat(hsTxt);
        if (!isNaN(hsParsed)) hsPct = hsParsed / 100;

        dayMatches.push({ win: isWin, kills, deaths, hsPct });
      });

    if (dayMatches.length) {
      result[dateKey] = (result[dateKey] || []).concat(dayMatches);
    } else {
      // Mesmo sem partidas listadas, marca o dia para sabermos que o bloco existia.
      if (!result[dateKey]) result[dateKey] = [];
    }
  });

  return result;
}

// Agrega uma lista de partidas do período
function aggregateMatches(matches) {
  const total = {
    matches: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    hsSum: 0,
    hsCount: 0,
  };
  for (const m of matches) {
    total.matches += 1;
    if (m.win) total.wins += 1;
    total.kills += m.kills;
    total.deaths += m.deaths;
    if (!isNaN(m.hsPct)) {
      total.hsSum += m.hsPct;
      total.hsCount += 1;
    }
  }
  const kdAvg = safeDiv(total.kills, total.deaths);
  const hsAvg = total.hsCount ? total.hsSum / total.hsCount : 0;
  return { ...total, kdAvg, hsAvg };
}

// Coleta/Agrega para 1 jogador em um intervalo de datas (inclusive)
async function collectPlayerPeriod(nick, startDate, endDate) {
  const byDay = await getMatchesByDay(nick);
  const keys = Object.keys(byDay);
  const startKey = toDateKey(startDate);
  const endKey = toDateKey(endDate);

  // Todas as datas no range
  const matches = [];
  const playedDates = new Set();
  for (const key of keys) {
    if (key >= startKey && key <= endKey) {
      const arr = byDay[key] || [];
      if (arr.length > 0) playedDates.add(key);
      matches.push(...arr);
    }
  }
  const agg = aggregateMatches(matches);

  // "Faltas" = nº de dias no período sem partidas (por dia civil no fuso TIMEZONE)
  const daysInRange = [];
  {
    let d = startOfDayTz(startDate);
    const end = startOfDayTz(endDate);
    while (d <= end) {
      daysInRange.push(toDateKey(d));
      d = addDays(d, 1);
    }
  }
  const faltas = daysInRange.filter(k => !playedDates.has(k)).length;

  return { nick, ...agg, faltas, playedDates };
}

// -----------------------------------------------------------------------------
// 6) Texto de ranking e report
function formatRankingHeader(title, start, end) {
  const sameDay = toDateKey(start) === toDateKey(end);
  const d1 = toDateKey(start);
  const d2 = toDateKey(end);
  return `**${title}** ${sameDay ? `(${d1})` : `(${d1} → ${d2})`}`;
}

function pickWinners(items, field, desc = true) {
  // devolve lista (podem haver empates)
  let best = desc ? -Infinity : Infinity;
  const out = [];
  for (const it of items) {
    const v = it[field];
    if (v == null || isNaN(v)) continue;
    if ((desc && v > best) || (!desc && v < best)) {
      best = v;
      out.length = 0;
      out.push(it);
    } else if (v === best) {
      out.push(it);
    }
  }
  return { best, out };
}

function formatWinnersRow(label, winners, field, options = {}) {
  const { suffix = '', decimals = 2 } = options;
  if (!winners.out.length || winners.best === -Infinity || winners.best === Infinity) {
    return `• ${label}: —`;
  }
  const list = winners.out
    .map(w => `${w.nick} - ${typeof w[field] === 'number' ? w[field].toFixed(decimals) : w[field]}${suffix}`)
    .join(', ');
  return `• ${label}: ${list}`;
}

function formatRankingEmbed(title, start, end, table) {
  const embed = new EmbedBuilder()
    .setTitle(`${title}`)
    .setDescription(`${toDateKey(start)} → ${toDateKey(end)}`)
    .addFields(table)
    .setColor(0xF8AA2A)
    .setTimestamp(new Date());
  return embed;
}

function simpleListField(name, lines) {
  return {
    name,
    value: lines.join('\n') || '—',
    inline: false,
  };
}

function formatPlayerReportEmbed(nick, start, end, agg) {
  const kd = agg.kdAvg === Infinity ? '∞' : agg.kdAvg.toFixed(2);
  const hs = formatPct(agg.hsAvg);

  return new EmbedBuilder()
    .setTitle(`Report de ${nick}`)
    .setDescription(`${toDateKey(start)} → ${toDateKey(end)}`)
    .addFields(
      { name: 'Partidas', value: String(agg.matches), inline: true },
      { name: 'Vitórias', value: String(agg.wins), inline: true },
      { name: 'Kills', value: String(agg.kills), inline: true },
      { name: 'Deaths', value: String(agg.deaths), inline: true },
      { name: 'K/D médio', value: kd, inline: true },
      { name: 'HS% médio', value: hs, inline: true },
    )
    .setColor(0x2B98F0)
    .setTimestamp(new Date());
}

// -----------------------------------------------------------------------------
// 7) Execução do ranking para um conjunto de players
async function buildRanking(players, start, end) {
  const results = [];
  for (const p of players) {
    try {
      const r = await collectPlayerPeriod(p, start, end);
      results.push(r);
    } catch (err) {
      results.push({ nick: p, error: String(err), matches: 0, wins: 0, kills: 0, deaths: 0, kdAvg: 0, hsAvg: 0, faltas: NaN });
    }
  }

  // Tabelas (top/maior):
  const faltasTop = pickWinners(results, 'faltas', true);
  const mortesTop = pickWinners(results, 'deaths', true);
  const kdTop = pickWinners(results, 'kdAvg', true);
  const hsTop = pickWinners(results, 'hsAvg', true);
  const vitoriasTop = pickWinners(results, 'wins', true);

  return {
    results,
    faltasTop,
    mortesTop,
    kdTop,
    hsTop,
    vitoriasTop,
    start,
    end,
  };
}

function rankingToEmbed(title, r) {
  const linhas = [
    formatWinnersRow('Quem mais faltou?', r.faltasTop, 'faltas', { decimals: 0 }),
    formatWinnersRow('Quem mais morreu?', r.mortesTop, 'deaths', { decimals: 0 }),
    formatWinnersRow('Melhor K/D?', r.kdTop, 'kdAvg'),
    formatWinnersRow('Melhor HS%?', r.hsTop, 'hsAvg', { suffix: '', decimals: 2 }),
    formatWinnersRow('Quem mais venceu?', r.vitoriasTop, 'wins', { decimals: 0 }),
  ];

  return formatRankingEmbed(title, r.start, r.end, [
    simpleListField('Rank', linhas),
  ]);
}

// -----------------------------------------------------------------------------
// 8) Comandos de texto (prefixo "!")
// -----------------------------------------------------------------------------
function isCommand(msg, name) {
  return msg.content.toLowerCase().startsWith(`${PREFIX}${name}`);
}

function helpText() {
  return [
    `**Comandos (prefixo \`${PREFIX}\`)**`,
    '',
    `• \`${PREFIX}help\` — mostra esta ajuda.`,
    `• \`${PREFIX}daily_ranking\` — ranking do **dia de hoje** para os jogadores configurados em \`PLAYERS\`.`,
    `• \`${PREFIX}yesterday_ranking\` — ranking de **ontem** (o script diferencia hoje/ontem pelos blocos de data do R6 Tracker).`,
    `• \`${PREFIX}weekly_ranking\` — ranking da **semana anterior** (Seg → Dom).`,
    `• \`${PREFIX}monthly_ranking\` — ranking do **mês anterior** (1º ao último dia).`,
    '',
    `• \`${PREFIX}daily_report <nick>\` — report individual **de hoje** para o jogador.`,
    `• \`${PREFIX}weekly_report <nick>\` — report individual da **semana anterior**.`,
    `• \`${PREFIX}monthly_report <nick>\` — report individual do **mês anterior**.`,
    '',
    `• \`${PREFIX}programar <channelId> <HH:MM>\` — programa envios automáticos no canal:`,
    `    - **diário**: \`${PREFIX}daily_ranking\` todos os dias no horário.`,
    `    - **semanal**: \`${PREFIX}weekly_ranking\` toda segunda-feira (semana anterior).`,
    `    - **mensal**: \`${PREFIX}monthly_ranking\` todo dia 1 (mês anterior).`,
    `   Fuso usado: **${TIMEZONE}**.`,
    `• \`${PREFIX}cancelar-programação\` — remove os envios automáticos do servidor atual.`,
    '',
    `**Observações**`,
    `- A lista de jogadores vem de \`PLAYERS\` no \`.env\` (separados por vírgula).`,
    `- “Faltas” = quantidade de **dias** no período sem partidas no R6 Tracker.`,
  ].join('\n');
}

// Funções de período “sem ambiguidades”
function todayRange() {
  const d = nowTz();
  const start = startOfDayTz(d);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
function yesterdayRange() {
  const t = startOfDayTz(nowTz());
  const y = addDays(t, -1);
  const start = y;
  const end = new Date(y);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  // HELP
  if (isCommand(msg, 'help')) {
    await msg.channel.send({ content: helpText() });
    return;
  }

  // RANKING — HOJE
  if (isCommand(msg, 'daily_ranking')) {
    if (!PLAYERS.length) return void msg.reply('Configure `PLAYERS` no .env.');
    const { start, end } = todayRange();
    await msg.channel.send('Gerando ranking do dia…');
    const r = await buildRanking(PLAYERS, start, end);
    const embed = rankingToEmbed('Rank do dia', r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }

  // RANKING — ONTEM
  if (isCommand(msg, 'yesterday_ranking')) {
    if (!PLAYERS.length) return void msg.reply('Configure `PLAYERS` no .env.');
    const { start, end } = yesterdayRange();
    await msg.channel.send('Gerando ranking de ontem…');
    const r = await buildRanking(PLAYERS, start, end);
    const embed = rankingToEmbed('Rank de Ontem', r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }

  // RANKING — SEMANA ANTERIOR
  if (isCommand(msg, 'weekly_ranking')) {
    if (!PLAYERS.length) return void msg.reply('Configure `PLAYERS` no .env.');
    const { start, end } = lastWeekRange(nowTz());
    await msg.channel.send('Gerando ranking semanal (semana anterior)…');
    const r = await buildRanking(PLAYERS, start, end);
    const embed = rankingToEmbed('Rank Semanal (semana anterior)', r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }

  // RANKING — MÊS ANTERIOR
  if (isCommand(msg, 'monthly_ranking')) {
    if (!PLAYERS.length) return void msg.reply('Configure `PLAYERS` no .env.');
    const { start, end } = lastMonthRange(nowTz());
    await msg.channel.send('Gerando ranking mensal (mês anterior)…');
    const r = await buildRanking(PLAYERS, start, end);
    const embed = rankingToEmbed('Rank Mensal (mês anterior)', r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }

  // REPORTS INDIVIDUAIS
  // daily_report <nick>
  if (isCommand(msg, 'daily_report')) {
    const nick = msg.content.split(/\s+/)[1];
    if (!nick) return void msg.reply(`Uso: \`${PREFIX}daily_report <nick>\``);
    const { start, end } = todayRange();
    await msg.channel.send(`Gerando report de **${nick}** (hoje)…`);
    const r = await collectPlayerPeriod(nick, start, end);
    const embed = formatPlayerReportEmbed(nick, start, end, r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }
  if (isCommand(msg, 'weekly_report')) {
    const nick = msg.content.split(/\s+/)[1];
    if (!nick) return void msg.reply(`Uso: \`${PREFIX}weekly_report <nick>\``);
    const { start, end } = lastWeekRange(nowTz());
    await msg.channel.send(`Gerando report de **${nick}** (semana anterior)…`);
    const r = await collectPlayerPeriod(nick, start, end);
    const embed = formatPlayerReportEmbed(nick, start, end, r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }
  if (isCommand(msg, 'monthly_report')) {
    const nick = msg.content.split(/\s+/)[1];
    if (!nick) return void msg.reply(`Uso: \`${PREFIX}monthly_report <nick>\``);
    const { start, end } = lastMonthRange(nowTz());
    await msg.channel.send(`Gerando report de **${nick}** (mês anterior)…`);
    const r = await collectPlayerPeriod(nick, start, end);
    const embed = formatPlayerReportEmbed(nick, start, end, r);
    await msg.channel.send({ embeds: [embed] });
    return;
  }

  // PROGRAMAÇÃO
  if (isCommand(msg, 'programar')) {
    const [, channelId, hhmm] = msg.content.trim().split(/\s+/);
    if (!channelId || !/^\d{2}:\d{2}$/.test(hhmm || '')) {
      return void msg.reply(`Uso: \`${PREFIX}programar <channelId> <HH:MM>\``);
    }
    const schedules = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    schedules[msg.guild.id] = { channelId, hhmm };
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
    await setupGuildCrons(msg.guild.id, channelId, hhmm);
    await msg.reply(`Agendado: diário (todos os dias), semanal (toda segunda) e mensal (todo dia 1) às **${hhmm}** em <#${channelId}> (${TIMEZONE}).`);
    return;
  }

  if (isCommand(msg, 'cancelar-programação')) {
    const schedules = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    delete schedules[msg.guild.id];
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
    cancelGuildCrons(msg.guild.id);
    await msg.reply('Programações removidas para este servidor.');
    return;
  }
});

// -----------------------------------------------------------------------------
// 9) Cron jobs por servidor (carregam no boot)
// -----------------------------------------------------------------------------
const guildCronJobs = new Map(); // guildId -> { daily, weekly, monthly }

function cancelGuildCrons(guildId) {
  const entry = guildCronJobs.get(guildId);
  if (!entry) return;
  for (const key of Object.keys(entry)) {
    try { entry[key]?.stop?.(); } catch {}
  }
  guildCronJobs.delete(guildId);
}

async function setupGuildCrons(guildId, channelId, hhmm) {
  cancelGuildCrons(guildId);

  const [hour, minute] = hhmm.split(':').map(Number);

  const daily = cron.schedule(
    `${minute} ${hour} * * *`,
    async () => {
      try {
        const ch = await client.channels.fetch(channelId);
        if (!ch) return;
        if (!PLAYERS.length) return void ch.send('Configure `PLAYERS` no .env.');
        const { start, end } = todayRange();
        const r = await buildRanking(PLAYERS, start, end);
        const embed = rankingToEmbed('Rank do dia', r);
        await ch.send({ embeds: [embed] });
      } catch (e) {
        console.error('Cron diário erro:', e);
      }
    },
    { timezone: TIMEZONE }
  );

  const weekly = cron.schedule(
    `${minute} ${hour} * * 1`, // segunda-feira
    async () => {
      try {
        const ch = await client.channels.fetch(channelId);
        if (!ch) return;
        if (!PLAYERS.length) return void ch.send('Configure `PLAYERS` no .env.');
        const { start, end } = lastWeekRange(nowTz());
        const r = await buildRanking(PLAYERS, start, end);
        const embed = rankingToEmbed('Rank Semanal (semana anterior)', r);
        await ch.send({ embeds: [embed] });
      } catch (e) {
        console.error('Cron semanal erro:', e);
      }
    },
    { timezone: TIMEZONE }
  );

  const monthly = cron.schedule(
    `${minute} ${hour} 1 * *`, // dia 1 de cada mês
    async () => {
      try {
        const ch = await client.channels.fetch(channelId);
        if (!ch) return;
        if (!PLAYERS.length) return void ch.send('Configure `PLAYERS` no .env.');
        const { start, end } = lastMonthRange(nowTz());
        const r = await buildRanking(PLAYERS, start, end);
        const embed = rankingToEmbed('Rank Mensal (mês anterior)', r);
        await ch.send({ embeds: [embed] });
      } catch (e) {
        console.error('Cron mensal erro:', e);
      }
    },
    { timezone: TIMEZONE }
  );

  guildCronJobs.set(guildId, { daily, weekly, monthly });
}

function loadSchedulesAndSetup() {
  const schedules = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  for (const [guildId, { channelId, hhmm }] of Object.entries(schedules)) {
    setupGuildCrons(guildId, channelId, hhmm).catch(console.error);
  }
}

// -----------------------------------------------------------------------------
// 10) Registro opcional de Slash Commands (desabilitado por padrão)
//     Para evitar "Missing Access (50001)" em ambientes sem escopo apropriado.
// -----------------------------------------------------------------------------
const REGISTER_SLASH = process.env.REGISTER_SLASH === '1';

const slashCommands = [
  {
    name: 'help',
    description: 'Mostra ajuda',
  },
  {
    name: 'daily_ranking',
    description: 'Ranking do dia (jogadores de PLAYERS)',
  },
  {
    name: 'yesterday_ranking',
    description: 'Ranking de ontem (jogadores de PLAYERS)',
  },
  {
    name: 'weekly_ranking',
    description: 'Ranking da semana anterior',
  },
  {
    name: 'monthly_ranking',
    description: 'Ranking do mês anterior',
  },
  {
    name: 'daily_report',
    description: 'Report diário de um jogador',
    options: [{ name: 'nick', description: 'Nick do jogador', type: 3, required: true }],
  },
  {
    name: 'weekly_report',
    description: 'Report semanal de um jogador (semana anterior)',
    options: [{ name: 'nick', description: 'Nick do jogador', type: 3, required: true }],
  },
  {
    name: 'monthly_report',
    description: 'Report mensal de um jogador (mês anterior)',
    options: [{ name: 'nick', description: 'Nick do jogador', type: 3, required: true }],
  },
];

async function registerSlashCommands() {
  if (!REGISTER_SLASH || !APP_ID || !GUILD_ID) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: slashCommands });
    console.log('✅ Slash commands registrados no servidor.');
  } catch (err) {
    console.warn('⚠️ Falha ao registrar slash (provável Missing Access):', err?.message || err);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  try {
    if (name === 'help') {
      await interaction.reply({ content: helpText(), ephemeral: true });
      return;
    }
    if (name === 'daily_ranking') {
      if (!PLAYERS.length) return void interaction.reply('Configure `PLAYERS` no .env.');
      const { start, end } = todayRange();
      await interaction.reply('Gerando ranking do dia…');
      const r = await buildRanking(PLAYERS, start, end);
      await interaction.editReply({ embeds: [rankingToEmbed('Rank do dia', r)] });
      return;
    }
    if (name === 'yesterday_ranking') {
      if (!PLAYERS.length) return void interaction.reply('Configure `PLAYERS` no .env.');
      const { start, end } = yesterdayRange();
      await interaction.reply('Gerando ranking de ontem…');
      const r = await buildRanking(PLAYERS, start, end);
      await interaction.editReply({ embeds: [rankingToEmbed('Rank de Ontem', r)] });
      return;
    }
    if (name === 'weekly_ranking') {
      if (!PLAYERS.length) return void interaction.reply('Configure `PLAYERS` no .env.');
      const { start, end } = lastWeekRange(nowTz());
      await interaction.reply('Gerando ranking semanal…');
      const r = await buildRanking(PLAYERS, start, end);
      await interaction.editReply({ embeds: [rankingToEmbed('Rank Semanal (semana anterior)', r)] });
      return;
    }
    if (name === 'monthly_ranking') {
      if (!PLAYERS.length) return void interaction.reply('Configure `PLAYERS` no .env.');
      const { start, end } = lastMonthRange(nowTz());
      await interaction.reply('Gerando ranking mensal…');
      const r = await buildRanking(PLAYERS, start, end);
      await interaction.editReply({ embeds: [rankingToEmbed('Rank Mensal (mês anterior)', r)] });
      return;
    }
    if (name === 'daily_report' || name === 'weekly_report' || name === 'monthly_report') {
      const nick = interaction.options.getString('nick', true);
      let start, end, title;
      if (name === 'daily_report') {
        ({ start, end } = todayRange());
        title = 'Report diário';
      } else if (name === 'weekly_report') {
        ({ start, end } = lastWeekRange(nowTz()));
        title = 'Report semanal (semana anterior)';
      } else {
        ({ start, end } = lastMonthRange(nowTz()));
        title = 'Report mensal (mês anterior)';
      }
      await interaction.reply(`Gerando ${title} de **${nick}**…`);
      const r = await collectPlayerPeriod(nick, start, end);
      await interaction.editReply({ embeds: [formatPlayerReportEmbed(nick, start, end, r)] });
      return;
    }
  } catch (err) {
    console.error('Erro no slash:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: `Erro: ${String(err)}`, ephemeral: true });
    } else {
      await interaction.editReply({ content: `Erro: ${String(err)}` });
    }
  }
});

// -----------------------------------------------------------------------------
// 11) Boot
client.once('clientReady', async (c) => {
  console.log(`✅ Logado como ${c.user.tag}`);
  loadSchedulesAndSetup();
  await registerSlashCommands();
});

client.login(TOKEN);
