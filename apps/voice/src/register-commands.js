import { REST, Routes, SlashCommandBuilder } from 'discord.js';
if (process.env.CONFIRM_DISCORD_SETUP !== 'yes') throw new Error('Command registration requires explicit setup approval');
for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('現在のVCで指定テキストチャンネルの読み上げを開始'),
  new SlashCommandBuilder().setName('leave').setDescription('VCを退出して読み上げを終了'),
  new SlashCommandBuilder().setName('stop').setDescription('音声と待ち行列を停止'),
  new SlashCommandBuilder().setName('voice-status').setDescription('音声接続と読み上げの状態を表示'),
  new SlashCommandBuilder().setName('say').setDescription('つむぎでテキストを読み上げ')
    .addStringOption(option => option.setName('text').setDescription('読み上げる文章').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('model').setDescription('VOICEVOXの声を一覧表示・自分の読み上げの声を変更')
    .addIntegerOption(option => option.setName('id').setDescription('一覧にある声のID（自分の読み上げだけ変更）').setMinValue(0))
    .addIntegerOption(option => option.setName('page').setDescription('保存済みの声一覧のページ番号').setMinValue(1)),
];
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
for (const command of commands) {
  await rest.post(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, process.env.DISCORD_GUILD_ID), { body: command.toJSON() });
}
console.log('Registered six guild-only readout commands');
