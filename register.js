// register.js
// ------------------------------------------------------------
// Registra os slash commands do bot via REST.
// Suporta:
//  - Registro por GUILD (recomendado p/ aparecer na hora) usando GUILD_ID ou GUILD_IDS
//  - Registro GLOBAL (se não houver GUILD_ID/S)
//  - Limpeza (apague todos) com flag --clear
//
// Uso:
//  node register.js                 # registra
//  node register.js --clear         # limpa (remove) os comandos
//
// .env necessário:
//  DISCORD_TOKEN=seu_token
//  APP_ID=1410403800967151646        # sua Application ID (Client ID)
//  GUILD_ID=xxxxxxxxxxxxxxxxxx       # opcional (uma guild)
//  # ou GUILD_IDS=111,222,333        # opcional (várias guilds)
//
// Requisitos: "type": "module" no package.json
// ------------------------------------------------------------

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID,
  GUILD_IDS, // "id1,id2,id3"
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN no .env');
  process.exit(1);
}
if (!APP_ID) {
  console.error('Falta APP_ID (Application ID) no .env');
  process.exit(1);
}

// --------- defina aqui os seus comandos (mesmos do index.js) ---------
const commands = [
  new SlashCommandBuilder()
    .setName('cadastrar')
    .setDescription('Cadastrar um jogador (nick Ubisoft) para rastrear')
    .addStringOption(o => o.setName('nick').setDescription('Nick na Ubisoft').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('programar')
    .setDescription('Programar o envio DIÁRIO do relatório de hoje em um canal')
    .addChannelOption(o =>
      o.setName('canal').setDescription('Canal de destino').setRequired(true)
    )
    .addStringOption(o =>
      o.setName('horario').setDescription('Horário HH:mm (24h) no fuso configurado').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('daily_report').setDescription('Relatório de HOJE'),
  new SlashCommandBuilder().setName('weekly_report').setDescription('Relatório dos ÚLTIMOS 7 DIAS'),
  new SlashCommandBuilder().setName('monthly_report').setDescription('Relatório dos ÚLTIMOS 30 DIAS'),

  new SlashCommandBuilder().setName('daily_ranking').setDescription('Ranking de HOJE'),
  new SlashCommandBuilder().setName('weekly_ranking').setDescription('Ranking dos ÚLTIMOS 7 DIAS'),
  new SlashCommandBuilder().setName('monthly_ranking').setDescription('Ranking dos ÚLTIMOS 30 DIAS'),
].map(c => c.toJSON());
// ---------------------------------------------------------------------

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const CLEAR = process.argv.includes('--clear');

async function registerForGuild(guildId) {
  const route = Routes.applicationGuildCommands(APP_ID, guildId);
  const body = CLEAR ? [] : commands;
  const action = CLEAR ? 'limpando' : 'registrando';
  const data = await rest.put(route, { body });
  console.log(`✓ ${action} comandos na guild ${guildId} — total: ${data.length ?? 0}`);
}

async function registerGlobal() {
  const route = Routes.applicationCommands(APP_ID);
  const body = CLEAR ? [] : commands;
  const action = CLEAR ? 'limpando' : 'registrando';
  const data = await rest.put(route, { body });
  console.log(`✓ ${action} comandos GLOBAIS — total: ${data.length ?? 0} (pode demorar a propagar)`);
}

(async () => {
  try {
    const guilds =
      (GUILD_IDS && GUILD_IDS.split(',').map(s => s.trim()).filter(Boolean)) ||
      (GUILD_ID ? [GUILD_ID] : []);

    if (guilds.length) {
      for (const gid of guilds) {
        await registerForGuild(gid);
      }
    } else {
      await registerGlobal();
    }

    console.log('✔️ Concluído.');
    process.exit(0);
  } catch (err) {
    console.error('Erro ao registrar/limpar comandos:', err);
    process.exit(1);
  }
})();
