// index.js
// ------------------------------------------------------------
// Bot R6 Tracker — Relatórios & Rankings (TRN) com Slash + Prefixo
// Agendamentos: diário (relatório), semanal/mensal (rankings) por guild
// Persistência: SQLite
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
// Util: datas & janelas canônicas
// -------------------------------
function parseDateLabelToISO(dateLabel, now = DateTime.now().setZone(TZ)) {
  if (!dateLabel) return null;
  const curYear = now.year;
  let dt = DateTime.fromFormat(`${dateLabel} ${curYear}`, 'LLL dd yyyy', { zone: TZ, locale: 'en' });
  if (!dt.isValid) return null;
  // se a label for "Jan 01" vista em Dez, recua 1 ano
  if (dt > now.plus({ days: 2 })) dt = dt.minus({ years: 1 });
  return dt.toISODate();
}

function filterBlocksByWindow(blocks, start, end) {
  return blocks
    .map(b => ({ ...b, iso: parseDateLabelToISO(b.dateLabel, end) }))
    .filter(b => !!b.iso)
    .filter(b => {
      const dt = DateTime.fromISO(b.iso, { zone: TZ }).endOf('day'); // inclui o dia inteiro
      return dt >= start.startOf('day') && dt <= end.endOf('day');
    });
}

// Para os comandos interativos (não agendados): janelas relativas
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

// Para agendamentos (janelas canônicas: semana/mês anteriores)
function getCanonicalWindow(kind, now = DateTime.now().setZone(TZ)) {
  if (kind === 'day') {
    const start = now.startOf('day');
    return { start, end: start.endOf('day') };
  }
  if (kind === 'week') {
    // semana anterior completa (seg→dom)
    const prev = now.minus({ weeks: 1 });
    const start = prev.startOf('week');  // ISO week (segunda)
    const end   = prev.endOf('week');    // domingo
    return { start, end };
  }
  if (kind === 'month') {
    // mês anterior completo
    const prev = now.minus({ months: 1 });
    const start = prev.startOf('month');
    const end   = prev.endOf('month');
    return { start, end };
  }
  // fallback: hoje
  const start = now.startOf('day');
  return { start, end: start.endOf('day') };
}

// -------------------------------
// Agregação por jogador
// -------------------------------
function aggregate(blocks) {
  // Agrega total de K, D, W, L; KD = K_total/D_total; HS% ponderado por kills
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

// -------------------------------
// Rankings (ordenações)
// -------------------------------
function buildRankings(collected) {
  // collected: [{ username, agg:{k,d,kd,hs_pct,wins}, error? }]
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
/*
  Armazenamos um objeto { daily, weekly, monthly } por guild
  - daily:    todo dia HH:mm  → relatório do dia
  - weekly:   toda segunda HH:mm → ranking da semana anterior (seg-dom)
  - monthly:  todo dia 1 HH:mm → ranking do mês anterior
*/
const guildCrons = new Map();

function parseHHmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s||'').trim());
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

async function installCronsForGuild(client, guildId) {
  const row = qGetSchedule.get(guildId);
  if (!row) return;
  const { channel_id, time_str } = row;
  const parsed = parseHHmm(time_str);
  if (!parsed) return;

  // stop anteriores
  const old = guildCrons.get(guildId);
  if (old) {
    old.daily?.stop?.();
    old.weekly?.stop?.();
    old.monthly?.stop?.();
  }

  const dailyExpr   = `${parsed.mm} ${parsed.hh} * * *`;    // todo dia
  const weeklyExpr  = `${parsed.mm} ${parsed.hh} * * 1`;    // segunda-feira
  const monthlyExpr = `${parsed.mm} ${parsed.hh} 1 * *`;    // dia 1

  const daily = cron.schedule(dailyExpr, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      // Relatório do dia (janela canônica do "hoje")
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

      // Ranking da semana ANTERIOR (seg->dom)
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

      // Ranking do MÊS ANTERIOR
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
  console.log(`Cronos instalados para guild ${guildId} @ ${time_str} (${TZ}) [daily/weekly/monthly]`);
}

async function installAllCrons(client) {
  const rows = qAllSchedules.all();
  for (const r of rows) await installCronsForGuild(client, r.guild_id);
}

function stopCronsForGuild(guildId) {
  const entry = guildCrons.get(guildId);
  if (!entry) return;
  entry.daily?.stop?.();
  entry.weekly?.stop?.();
  entry.monthly?.stop?.();
  guildCrons.delete(guildId);
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

  // Map de intervalos
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

  // Admin: cadastrar
  if (cmd === 'cadastrar') {
    if (!isAdmin) return send('❌ Apenas admins (Manage Server) podem usar `!cadastrar`.');
    const nick = args.join(' ').trim();
    if (!nick) return send('Uso: `!cadastrar <nick-ubisoft>`');
    qInsertPlayer.run(msg.guild.id, nick);
    const total = qListPlayers.all(msg.guild.id).length;
    return send(`✅ **${nick}** cadastrado. Jogadores agora: **${total}**.`);
  }

  // Admin: programar (#canal HH:mm) — instala 3 crons
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
            `Ex.: https://r6.tracker.network/r6siege/profile/ubi/**gabrielgadelham**/overview`,
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
            `**Semana (7d):** \`${PREFIX}weekly_ranking\``,
            `**Mês (30d):** \`${PREFIX}monthly_ranking\``,
            `Categorias: Quem mais matou • Quem mais morreu • Melhor K/D • Melhor HS% • Quem mais venceu`,
          ].join('\n'),
          inline: false
        },
        {
          name: 'Dicas',
          value: [
            `• O site pode demorar 10–15s para renderizar (o bot já espera).`,
            `• KD é calculado como **K_total/D_total** no período; HS% é **ponderado por kills**.`,
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
