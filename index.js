// index.js
// ------------------------------------------------------------
// Bot de Discord para relatórios e rankings de R6 Siege (TRN)
// - Slash e Prefixo (!)
// - Relatório individual por nick (opcional)
// - Crons por guild (horário único):
//   * Diário  -> envia DAILY_RANKING (apenas ranking do dia)
//   * Semanal -> toda segunda: WEEKLY_RANKING (semana calendário ANTERIOR)
//   * Mensal  -> dia 1: MONTHLY_RANKING (mês calendário ANTERIOR)
// ------------------------------------------------------------

import 'dotenv/config';
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
import { scrapeDailyBlocks } from './scrape.js';

// -------------------------------
// .env
// -------------------------------
const {
  DISCORD_TOKEN,
  GUILD_ID,
  GUILD_IDS,
  TZ = 'America/Fortaleza',
  PREFIX = '!',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN no .env');
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
  guild_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  time_str  TEXT NOT NULL,     -- "HH:mm" 24h, usado p/ diário/semana/mês
  PRIMARY KEY (guild_id)
);
`);

const qInsertPlayer      = db.prepare('INSERT OR IGNORE INTO players (guild_id, username) VALUES (?, ?)');
const qDeletePlayer      = db.prepare('DELETE FROM players WHERE guild_id = ? AND username = ?');
const qListPlayers       = db.prepare('SELECT username FROM players WHERE guild_id = ? ORDER BY username COLLATE NOCASE');
const qUpsertSchedule    = db.prepare(`
  INSERT INTO schedules (guild_id, channel_id, time_str)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, time_str=excluded.time_str
`);
const qGetSchedule       = db.prepare('SELECT channel_id, time_str FROM schedules WHERE guild_id = ?');
const qAllSchedules      = db.prepare('SELECT guild_id FROM schedules');
const qDeleteSchedule    = db.prepare('DELETE FROM schedules WHERE guild_id = ?');

// -------------------------------
// Datas / filtros / agregação
// -------------------------------
function parseDateLabelToISO(dateLabel, now = DateTime.now().setZone(TZ)) {
  if (!dateLabel) return null;
  const curYear = now.year;
  let dt = DateTime.fromFormat(`${dateLabel} ${curYear}`, 'LLL dd yyyy', { zone: TZ, locale: 'en' });
  if (!dt.isValid) return null;
  // proteção virada de ano (ex.: "Jan 01" visto em Dezembro)
  if (dt > now.plus({ days: 2 })) dt = dt.minus({ years: 1 });
  return dt.toISODate();
}

// Últimos 7 / 30 dias (para comandos manuais)
function filterBlocksByRange(blocks, range) {
  const today = DateTime.now().setZone(TZ).startOf('day');
  let start;
  if (range === 'day') start = today;
  else if (range === 'week') start = today.minus({ days: 6 });
  else if (range === 'month') start = today.minus({ days: 29 });
  else start = today;
  const end = today.endOf('day');

  return blocks
    .map(b => ({ ...b, iso: parseDateLabelToISO(b.dateLabel, today) }))
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ });
      return dt >= start && dt <= end;
    });
}

// Semana calendário ANTERIOR (segunda–domingo anteriores)
function filterBlocksByPreviousCalendarWeek(blocks) {
  const now = DateTime.now().setZone(TZ);
  const startThisWeek = now.startOf('week');        // ISO week => começa na segunda
  const startPrev     = startThisWeek.minus({ weeks: 1 });
  const endPrev       = startThisWeek.minus({ days: 1 }).endOf('day');

  return blocks
    .map(b => ({ ...b, iso: parseDateLabelToISO(b.dateLabel, now) }))
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ });
      return dt >= startPrev && dt <= endPrev;
    });
}

// Mês calendário ANTERIOR (1º ao último dia)
function filterBlocksByLastCalendarMonth(blocks) {
  const now = DateTime.now().setZone(TZ);
  const start = now.minus({ months: 1 }).startOf('month');
  const end   = now.minus({ months: 1 }).endOf('month');

  return blocks
    .map(b => ({ ...b, iso: parseDateLabelToISO(b.dateLabel, now) }))
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ });
      return dt >= start && dt <= end;
    });
}

function aggregate(blocks) {
  // KD = ΣK / ΣD; HS% ponderado por kills = (Σ(HS%·K)) / ΣK
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

  const kdVal = totalD > 0 ? totalK / totalD : (totalK > 0 ? Infinity : 0);
  const kd = Number.isFinite(kdVal) ? kdVal : 0;
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
    .addFields([
      { name: 'W/L', value: `${agg.wins} W • ${agg.losses} L`, inline: true },
      { name: 'K/D', value: (agg.kd ?? 0).toFixed(2), inline: true },
      { name: 'K · D', value: `${agg.k} · ${agg.d}`, inline: true },
      { name: 'HS%', value: `${(agg.hs_pct ?? 0).toFixed(1)}%`, inline: true },
      { name: 'Dias', value: `${agg.days}`, inline: true },
    ])
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

function buildRankings(collected) {
  // collected: [{ username, agg, error? }]
  const flat = collected
    .filter(c => !c.error)
    .map(c => ({ username: c.username, ...c.agg }));

  // Tiebreakers simples: kills como desempate secundário
  const sortBy = (key, secondary = 'k') => (a, b) => {
    if (b[key] !== a[key]) return b[key] - a[key];
    return (b[secondary] ?? 0) - (a[secondary] ?? 0);
  };

  return {
    mostKills:  [...flat].sort(sortBy('k')).slice(0, 5),
    mostDeaths: [...flat].sort(sortBy('d')).slice(0, 5),
    bestKD:     [...flat].sort(sortBy('kd', 'k')).slice(0, 5),
    bestHS:     [...flat].sort(sortBy('hs_pct', 'k')).slice(0, 5),
    mostWins:   [...flat].sort(sortBy('wins')).slice(0, 5),
  };
}

// -------------------------------
// Coleta/Agregação (single e guild)
// -------------------------------
async function collectForUser(username, range) {
  const { url, blocks } = await scrapeDailyBlocks(username);
  const filtered = filterBlocksByRange(blocks, range);
  const agg = aggregate(filtered);
  return { username, url, agg, count: filtered.length };
}

async function collectForUserPrevCalendarWeek(username) {
  const { url, blocks } = await scrapeDailyBlocks(username);
  const filtered = filterBlocksByPreviousCalendarWeek(blocks);
  const agg = aggregate(filtered);
  return { username, url, agg, count: filtered.length };
}

async function collectForUserLastMonthCalendar(username) {
  const { url, blocks } = await scrapeDailyBlocks(username);
  const filtered = filterBlocksByLastCalendarMonth(blocks);
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

async function collectForGuildPrevCalendarWeek(guildId) {
  const rows = qListPlayers.all(guildId);
  const results = [];
  for (const r of rows) {
    try {
      const one = await collectForUserPrevCalendarWeek(r.username);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: e?.message || String(e) });
    }
  }
  return results;
}

async function collectForGuildLastMonthCalendar(guildId) {
  const rows = qListPlayers.all(guildId);
  const results = [];
  for (const r of rows) {
    try {
      const one = await collectForUserLastMonthCalendar(r.username);
      results.push(one);
    } catch (e) {
      results.push({ username: r.username, error: true, err: e?.message || String(e) });
    }
  }
  return results;
}

// -------------------------------
// Crons (diário / semanal / mensal)
// -------------------------------
const guildCrons = new Map(); // guild_id -> { daily, weekly, monthly }

function parseHHmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s||'').trim());
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function stopCronsForGuild(guildId) {
  const entry = guildCrons.get(guildId);
  if (entry) {
    for (const key of ['daily', 'weekly', 'monthly']) {
      try { entry[key]?.stop(); } catch {}
    }
    guildCrons.delete(guildId);
  }
}

async function installCronsForGuild(client, guildId) {
  const row = qGetSchedule.get(guildId);
  if (!row) return;
  const { channel_id, time_str } = row;
  const parsed = parseHHmm(time_str);
  if (!parsed) return;

  // Pare crons antigos (se houver)
  stopCronsForGuild(guildId);

  const tasks = {};
  const minute = `${parsed.mm}`;
  const hour   = `${parsed.hh}`;

  // Diário: agora envia APENAS o RANKING DO DIA
  const exprDaily = `${minute} ${hour} * * *`;
  tasks.daily = cron.schedule(exprDaily, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const results = await collectForGuild(guildId, 'day'); // hoje
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking('— Hoje', rk)] });
    } catch (e) {
      console.error('Falha no cron diário:', e);
    }
  }, { timezone: TZ });

  // Semanal: toda segunda → RANKING semanal (SEMANA CALENDÁRIO ANTERIOR)
  const exprWeekly = `${minute} ${hour} * * 1`;
  tasks.weekly = cron.schedule(exprWeekly, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const results = await collectForGuildPrevCalendarWeek(guildId);
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking('— Semana (semana anterior)', rk)] });
    } catch (e) {
      console.error('Falha no cron semanal:', e);
    }
  }, { timezone: TZ });

  // Mensal: dia 1 → RANKING mensal (MÊS CALENDÁRIO ANTERIOR)
  const exprMonthly = `${minute} ${hour} 1 * *`;
  tasks.monthly = cron.schedule(exprMonthly, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const results = await collectForGuildLastMonthCalendar(guildId);
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }
      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking('— Mês (mês anterior)', rk)] });
    } catch (e) {
      console.error('Falha no cron mensal:', e);
    }
  }, { timezone: TZ });

  guildCrons.set(guildId, tasks);
  console.log(`Crons instalados p/ guild ${guildId} @ ${time_str} (${TZ}) [daily=ranking, weekly=ranking prev week, monthly=ranking prev month]`);
}

async function installAllCrons(client) {
  const rows = qAllSchedules.all();
  for (const r of rows) await installCronsForGuild(client, r.guild_id);
}

// -------------------------------
// Discord client + slash commands
// -------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,           // slash
    GatewayIntentBits.GuildMessages,    // prefixo
    GatewayIntentBits.MessageContent,   // conteúdo (ative no portal!)
  ],
  partials: [Partials.Channel],
});

// Slash (reports aceitam 'nick' opcional)
const slashCommands = [
  new SlashCommandBuilder()
    .setName('cadastrar')
    .setDescription('Cadastrar um jogador (nick Ubisoft) para rastrear')
    .addStringOption(o => o.setName('nick').setDescription('Nick na Ubisoft').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('programar')
    .setDescription('Programar envios: diário (ranking), semanal (ranking anterior) e mensal (ranking mês anterior)')
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
    .setDescription('Relatório de HOJE (todos ou 1 nick)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('weekly_report')
    .setDescription('Relatório dos ÚLTIMOS 7 DIAS (todos ou 1 nick)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('monthly_report')
    .setDescription('Relatório dos ÚLTIMOS 30 DIAS (todos ou 1 nick)')
    .addStringOption(o => o.setName('nick').setDescription('Nick Ubisoft (opcional)').setRequired(false)),

  new SlashCommandBuilder().setName('daily_ranking').setDescription('Ranking de HOJE'),
  new SlashCommandBuilder().setName('weekly_ranking').setDescription('Ranking dos ÚLTIMOS 7 DIAS'),
  new SlashCommandBuilder().setName('monthly_ranking').setDescription('Ranking do MÊS (últimos 30 dias)'),
].map(c => c.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const app = await client.application?.fetch();
  const appId = app?.id || client.user.id;

  const list = (GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length) {
    for (const gid of list) {
      await rest.put(Routes.applicationGuildCommands(appId, gid), { body: slashCommands });
      console.log(`Comandos registrados na guild ${gid}.`);
    }
  } else if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: slashCommands });
    console.log(`Comandos registrados na guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: slashCommands });
    console.log('Comandos registrados globalmente (podem demorar a aparecer).');
  }
}

client.once('ready', async () => {
  console.log(`Logado como ${client.user.tag}`);
  console.log('Guilds conectadas:');
  for (const g of client.guilds.cache.values()) {
    console.log(`- ${g.name} (${g.id})`);
  }
  await registerSlashCommands();
  await installAllCrons(client);
});

// -------------------------------
// Helper de confirmação (acks para slash)
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
    if (!parsed) return confirm(ix, '⚠️ Use **HH:mm** (24h), ex.: `23:55`.', { ephemeral: true });

    await confirm(ix, `🗓️ Programando: diário (ranking), semanal (ranking semana anterior) e mensal (ranking mês anterior) às **${horario} ${TZ}** em ${channel}…`, { ephemeral: true });
    qUpsertSchedule.run(guildId, channel.id, horario);
    await installCronsForGuild(client, guildId);
    await confirm(ix, `✅ Programação criada/atualizada!\n• Canal: ${channel}\n• Horário base: **${horario} ${TZ}**`, { ephemeral: true });
    return;
  }

  if (name === 'cancelar_programacao') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem cancelar a programação.', { ephemeral: true });
      return;
    }
    qDeleteSchedule.run(guildId);
    stopCronsForGuild(guildId);
    await confirm(ix, '🛑 Programação **cancelada** para esta guild.', { ephemeral: true });
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
    const isReport = name.endsWith('report');
    const label =
      range === 'day' ? 'de hoje' :
      range === 'week' ? 'dos últimos 7 dias' :
      'dos últimos 30 dias';

    // Relatório individual (se nick fornecido)
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

    // Fluxo "todos"
    await confirm(ix, `🔎 Gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
    try {
      const results = await collectForGuild(guildId, range);
      if (!results.length) return confirm(ix, '⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick`.', { edit: true });

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
  }
});

// -------------------------------
// Handler: PREFIXO (mensagens)
// -------------------------------
client.on('messageCreate', async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const content = msg.content?.trim();
  if (!content || !content.startsWith(PREFIX)) return;

  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd  = (args.shift() || '').toLowerCase();

  const isAdmin = msg.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
  const send = (m) => msg.channel.send(m);

  // Cadastrar (admin)
  if (cmd === 'cadastrar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cadastrar`.');
    const nick = args.join(' ').trim();
    if (!nick) return send(`Uso: \`${PREFIX}cadastrar <nick-ubisoft>\``);
    qInsertPlayer.run(msg.guild.id, nick);
    const total = qListPlayers.all(msg.guild.id).length;
    return send(`✅ **${nick}** cadastrado. Jogadores agora: **${total}**.`);
  }

  // Programar (admin)
  if (cmd === 'programar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!programar`.');
    if (args.length < 2 && !msg.mentions.channels.first()) {
      return send(`Uso: \`${PREFIX}programar #canal HH:mm\` (ex.: \`${PREFIX}programar #r6-status 23:55\`)`);
    }

    const chMention = msg.mentions.channels.first();
    let target = chMention;
    if (!target) {
      const first = args[0];
      const byId = msg.guild.channels.cache.get(first);
      if (byId?.isTextBased()) target = byId;
      if (!target) {
        target = msg.guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase() === first.replace(/^#/, '').toLowerCase());
        if (target) args.shift();
      }
    } else {
      args.shift(); // remove a menção para sobrar só o horário
    }

    const horario = (args[0] || '').trim();
    const parsed = parseHHmm(horario);
    if (!target?.isTextBased() || !parsed) {
      return send(`Uso: \`${PREFIX}programar #canal HH:mm\` (ex.: \`${PREFIX}programar #r6-status 23:55\`)`);
    }

    await send(`🗓️ Programando: diário (ranking), semanal (ranking semana anterior) e mensal (ranking mês anterior) às **${horario} ${TZ}** em ${target}…`);
    qUpsertSchedule.run(msg.guild.id, target.id, horario);
    await installCronsForGuild(client, msg.guild.id);
    return send(`✅ Programação criada/atualizada!\n• Canal: ${target}\n• Horário base: **${horario} ${TZ}**`);
  }

  // Cancelar programação (admin)
  if (cmd === 'cancelar-programação' || cmd === 'cancelar_programacao') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cancelar-programação`.');
    qDeleteSchedule.run(msg.guild.id);
    stopCronsForGuild(msg.guild.id);
    return send('🛑 Programação **cancelada** para esta guild.');
  }

  // Map de intervalos
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
    const label = range === 'day' ? 'de hoje' : range === 'week' ? 'dos últimos 7 dias' : 'dos últimos 30 dias';

    // Relatório de 1 nick (se informado)
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

    // Todos os cadastrados
    await send(`🔎 Gerando ${isReport ? 'relatório' : 'ranking'} ${label}…`);
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
        `Prefixo: **${PREFIX}** | Fuso: **${TZ}**.`,
        `Alguns comandos exigem permissão **Manage Server** (admins).`,
        `Há equivalentes por *slash* (/daily_report, /weekly_report, etc.).`,
      ].join('\n'))
      .addFields(
        {
          name: `1) Cadastrar jogador (ADMIN)`,
          value: [
            `**Uso:** \`${PREFIX}cadastrar <nick-ubisoft>\``,
            `Nick é o da URL no TRN. Ex.: .../ubi/**gabrielgadelham**/overview`,
            `**Ex.:** \`${PREFIX}cadastrar gabrielgadelham\``,
          ].join('\n'),
          inline: false
        },
        {
          name: `2) Programar (ADMIN)`,
          value: [
            `**Uso:** \`${PREFIX}programar #canal HH:mm\``,
            `Cria 3 agendamentos usando **o mesmo horário**:`,
            `• **Diário**: envia **ranking do dia**`,
            `• **Semanal (segunda)**: envia **ranking da semana calendário anterior**`,
            `• **Mensal (dia 1)**: envia **ranking do mês calendário anterior**`,
            `**Ex.:** \`${PREFIX}programar #r6-status 23:55\``,
          ].join('\n'),
          inline: false
        },
        {
          name: `3) Cancelar programação (ADMIN)`,
          value: `**Uso:** \`${PREFIX}cancelar-programação\` (ou \`${PREFIX}cancelar_programacao\`)\nRemove todos os envios programados da guild.`,
          inline: false
        },
        {
          name: `4) Relatórios (TODOS)`,
          value: [
            `**Hoje:** \`${PREFIX}daily_report [nick]\``,
            `**Semana (7d rolling):** \`${PREFIX}weekly_report [nick]\``,
            `**Mês (30d rolling):** \`${PREFIX}monthly_report [nick]\``,
            `• Se informar \`[nick]\`, gera **apenas** desse jogador; sem nick, **todos os cadastrados**.`,
          ].join('\n'),
          inline: false
        },
        {
          name: `5) Rankings (TODOS)`,
          value: [
            `**Hoje:** \`${PREFIX}daily_ranking\``,
            `**Semana (7d rolling):** \`${PREFIX}weekly_ranking\``,
            `**Mês (30d rolling):** \`${PREFIX}monthly_ranking\``,
            `Categorias: **Quem mais matou**, **Quem mais morreu**, **Melhor K/D**, **Melhor HS%**, **Quem mais venceu**.`,
            `Obs.: os agendamentos usam **semana/mês calendário anterior**; os comandos manuais usam janelas móveis (7/30 dias).`,
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
