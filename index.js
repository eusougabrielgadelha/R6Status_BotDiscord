// index.js
// ------------------------------------------------------------
// Bot de Discord para relatórios e rankings de R6 Siege (TRN)
// Comandos: /cadastrar, /daily_report, /weekly_report, /monthly_report,
//           /programar, /daily_ranking, /weekly_ranking, /monthly_ranking
// Persistência: SQLite (players por guild; agendamento por guild)
// Scraper: importado de ./scrape.js (Puppeteer + Stealth)
// Timezone: controlado por TZ em .env (ex.: America/Fortaleza)
// Confirmações: acks imediatos e mensagens finais por comando
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
  GUILD_ID,               // opcional (registro rápido dos comandos em 1 guild)
  GUILD_IDS,              // opcional (registro em várias guilds: "id1,id2,...")
  TZ = 'America/Fortaleza',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN no .env');
  process.exit(1);
}

// -------------------------------
// DB (SQLite local: r6bot.db)
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
const qAllSchedules   = db.prepare('SELECT guild_id FROM schedules');

// -------------------------------
// Datas / filtros / agregação
// -------------------------------
function parseDateLabelToISO(dateLabel, now = DateTime.now().setZone(TZ)) {
  if (!dateLabel) return null;
  const curYear = now.year;
  let dt = DateTime.fromFormat(`${dateLabel} ${curYear}`, 'LLL dd yyyy', { zone: TZ, locale: 'en' });
  if (!dt.isValid) return null;
  if (dt > now.plus({ days: 2 })) dt = dt.minus({ years: 1 }); // ajuste de virada de ano
  return dt.toISODate();
}

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

function aggregate(blocks) {
  // KD = K_total / D_total (protege divisão por zero)
  // HS% ponderado por kills: (Σ (hs% * K)) / (Σ K)
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
/* Embeds */
// -------------------------------
function embedReport(rangeTitle, username, url, agg) {
  return new EmbedBuilder()
    .setTitle(`R6 — ${rangeTitle} • ${username}`)
    .setURL(url)
    .addFields([
      { name: 'W/L', value: `${agg.wins} W • ${agg.losses} L`, inline: true },
      { name: 'K/D', value: agg.kd ? agg.kd.toFixed(2) : '0.00', inline: true },
      { name: 'K · D', value: `${agg.k} · ${agg.d}`, inline: true },
      { name: 'HS%', value: `${agg.hs_pct.toFixed(1)}%`, inline: true },
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

// -------------------------------
// Coleta por usuário e por guild
// -------------------------------
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
// Cron diário por guild
// -------------------------------
const guildCrons = new Map(); // guild_id -> cron task

function parseHHmm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s||'').trim());
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

async function installCronForGuild(client, guildId) {
  const row = qGetSchedule.get(guildId);
  if (!row) return;
  const { channel_id, time_str } = row;
  const parsed = parseHHmm(time_str);
  if (!parsed) return;

  const old = guildCrons.get(guildId);
  if (old) old.stop();

  const expr = `${parsed.mm} ${parsed.hh} * * *`; // todo dia hh:mm
  const task = cron.schedule(expr, async () => {
    try {
      const ch = await client.channels.fetch(channel_id);
      if (!ch?.isTextBased()) return;

      const results = await collectForGuild(guildId, 'day');
      if (!results.length) {
        await ch.send('Nenhum jogador cadastrado. Use `/cadastrar nick`.');
        return;
      }

      for (const r of results) {
        if (r.error) {
          await ch.send(`❌ Falha ao ler **${r.username}** — ${r.err || 'erro'}`);
          continue;
        }
        await ch.send({ embeds: [embedReport('Hoje', r.username, r.url, r.agg)] });
      }

      const rk = buildRankings(results);
      await ch.send({ embeds: [embedRanking('— Hoje', rk)] });
    } catch (e) {
      console.error('Falha no cron diário:', e);
    }
  }, { timezone: TZ });

  guildCrons.set(guildId, task);
  console.log(`Cron diário ${time_str} (${TZ}) instalado para guild ${guildId}`);
}

async function installAllCrons(client) {
  const rows = qAllSchedules.all();
  for (const r of rows) await installCronForGuild(client, r.guild_id);
}

// -------------------------------
// Discord client + slash commands
// -------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const slashCommands = [
  new SlashCommandBuilder()
    .setName('cadastrar')
    .setDescription('Cadastrar um jogador (nick Ubisoft) para rastrear')
    .addStringOption(o => o.setName('nick').setDescription('Nick na Ubisoft').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('daily_report')
    .setDescription('Relatório de HOJE de todos os jogadores cadastrados'),

  new SlashCommandBuilder()
    .setName('weekly_report')
    .setDescription('Relatório dos ÚLTIMOS 7 DIAS de todos os jogadores cadastrados'),

  new SlashCommandBuilder()
    .setName('monthly_report')
    .setDescription('Relatório dos ÚLTIMOS 30 DIAS de todos os jogadores cadastrados'),

  new SlashCommandBuilder()
    .setName('programar')
    .setDescription('Programar o envio DIÁRIO do relatório de hoje em um canal')
    .addChannelOption(o =>
      o.setName('canal').setDescription('Canal de destino').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addStringOption(o =>
      o.setName('horario').setDescription('Horário HH:mm (24h) no fuso configurado').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('daily_ranking')
    .setDescription('Ranking de HOJE'),

  new SlashCommandBuilder()
    .setName('weekly_ranking')
    .setDescription('Ranking dos ÚLTIMOS 7 DIAS'),

  new SlashCommandBuilder()
    .setName('monthly_ranking')
    .setDescription('Ranking dos ÚLTIMOS 30 DIAS'),
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
    console.log('Comandos registrados globalmente (podem demorar para aparecer).');
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
// Helper de confirmação (acks)
// -------------------------------
async function confirm(ix, message, { ephemeral = false, edit = false } = {}) {
  const payload = typeof message === 'string' ? { content: message } : message;

  if (edit) {
    return ix.editReply(payload);
  }

  if (ix.deferred || ix.replied) {
    return ix.followUp({ ...payload, ephemeral });
  }

  return ix.reply({ ...payload, ephemeral });
}

// -------------------------------
// Handler de comandos (com confirmações)
// -------------------------------
client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;

  const name = ix.commandName;
  const guildId = ix.guildId;

  // =============== /cadastrar ===============
  if (name === 'cadastrar') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem cadastrar jogadores.', { ephemeral: true });
      return;
    }
    const nick = ix.options.getString('nick', true).trim();
    qInsertPlayer.run(guildId, nick);
    const total = qListPlayers.all(guildId).length;

    await confirm(
      ix,
      `✅ **${nick}** cadastrado para rastrear neste servidor.\n📚 Jogadores cadastrados agora: **${total}**.`,
      { ephemeral: true }
    );
    return;
  }

  // =============== /programar ===============
  if (name === 'programar') {
    if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await confirm(ix, '❌ Apenas admins (Manage Server) podem programar o relatório.', { ephemeral: true });
      return;
    }
    const channel = ix.options.getChannel('canal', true);
    const horario = ix.options.getString('horario', true);
    const parsed = parseHHmm(horario);

    if (!parsed) {
      await confirm(ix, '⚠️ Formato inválido. Use **HH:mm** (24h), ex.: `23:55`.', { ephemeral: true });
      return;
    }

    await confirm(ix, `🗓️ Recebi: vou agendar o envio diário para **${channel}** às **${horario} ${TZ}**…`, { ephemeral: true });

    qUpsertSchedule.run(guildId, channel.id, horario);
    await installCronForGuild(client, guildId);

    await confirm(ix, `✅ Agendamento criado/atualizado com sucesso!\n• Canal: ${channel}\n• Horário: **${horario} ${TZ}**`, { ephemeral: true });
    return;
  }

  // =============== Map de intervalos ===============
  const rangeMap = {
    daily_report:   'day',
    weekly_report:  'week',
    monthly_report: 'month',
    daily_ranking:   'day',
    weekly_ranking:  'week',
    monthly_ranking: 'month',
  };

  // =============== Relatórios & Rankings ===============
  if (name in rangeMap) {
    const range = rangeMap[name];

    await ix.deferReply(); // público (se quiser privado: { ephemeral: true })

    const label =
      range === 'day' ? 'de hoje' :
      range === 'week' ? 'dos últimos 7 dias' :
      'dos últimos 30 dias';

    await confirm(ix, `🔎 Recebi o comando **/${name}** — gerando ${name.endsWith('report') ? 'relatório' : 'ranking'} ${label}…`);

    try {
      const results = await collectForGuild(guildId, range);

      if (!results.length) {
        await confirm(ix, '⚠️ Nenhum jogador cadastrado. Use `/cadastrar nick` primeiro.', { edit: true });
        return;
      }

      const total = results.length;
      const ok = results.filter(r => !r.error).length;
      const fail = total - ok;

      if (name.endsWith('report')) {
        const title =
          range === 'day' ? 'Hoje' :
          range === 'week' ? 'Últimos 7 dias' : 'Últimos 30 dias';

        for (const r of results) {
          if (r.error) {
            await confirm(ix, `❌ Falha ao ler **${r.username}** — ${r.err || 'erro'}`);
          } else {
            await confirm(ix, { embeds: [embedReport(title, r.username, r.url, r.agg)] });
          }
        }

        await confirm(ix, `✅ Relatório ${label} concluído.\n• Processados: **${ok}/${total}** (erros: ${fail}).`, { edit: true });
      } else {
        const rk = buildRankings(results);
        const title =
          range === 'day' ? '— Hoje' :
          range === 'week' ? '— Últimos 7 dias' : '— Últimos 30 dias';

        await confirm(ix, { embeds: [embedRanking(title, rk)] }, { edit: true });
        await confirm(ix, `✅ Ranking ${label} gerado.\n• Considerados: **${ok}/${total}** jogadores (erros: ${fail}).`);
      }
    } catch (e) {
      console.error(e);
      await confirm(ix, '❌ Não consegui gerar agora. Tente novamente mais tarde.', { edit: true });
    }
    return;
  }
});

client.login(DISCORD_TOKEN);
