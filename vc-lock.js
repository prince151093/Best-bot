const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const DATA_FILE = path.join(__dirname, 'vc-locks.json');
let state = { guilds: {} };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') state = parsed;
    }
  } catch (err) {
    console.error('VC lock data load error:', err);
  }
  if (!state.guilds || typeof state.guilds !== 'object') state.guilds = {};
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('VC lock data save error:', err);
  }
}

load();

function getGuild(guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = { channels: {} };
  if (!state.guilds[guildId].channels) state.guilds[guildId].channels = {};
  return state.guilds[guildId];
}

function getChannel(guildId, channelId) {
  return getGuild(guildId).channels[channelId] || null;
}

function isLocked(guildId, channelId) {
  return !!getChannel(guildId, channelId)?.locked;
}

function hasAccess(guildId, channelId, userId) {
  const vc = getChannel(guildId, channelId);
  return !!vc?.locked && Array.isArray(vc.allowed) && vc.allowed.includes(userId);
}

function currentVoice(message) {
  return message.member?.voice?.channel || null;
}

function canManageVC(message) {
  return message.member?.permissions?.has(PermissionFlagsBits.ManageRoles);
}

function usage() {
  return [
    '**🔒 VC Lock Commands**',
    '`?lockvc` — lock your current VC; everyone currently inside gets access.',
    '`?unlockvc` — unlock your current VC.',
    '`?accesvc @user` — give a user access to the locked VC.',
    '`?removevc @user` — remove a user from the access list.',
    '`?vcaccess` — show everyone who currently has access.'
  ].join('\n');
}

async function handleCommand(message) {
  const content = message.content.trim();
  const parts = content.split(/\s+/);
  const command = (parts[0] || '').toLowerCase();
  const commands = new Set(['?lockvc', '?unlockvc', '?accesvc', '?removevc', '?vcaccess']);
  if (!commands.has(command)) return false;

  if (!message.guild) return message.reply('❌ This command can only be used in a server.');
  if (!canManageVC(message)) return message.reply('❌ You need the **Manage Roles** permission to manage a VC.');

  const channel = currentVoice(message);
  if (!channel) return message.reply('❌ You must be sitting in a voice channel to use this command.');

  if (command === '?lockvc') {
    const existing = getChannel(message.guild.id, channel.id);
    if (existing?.locked) return message.reply('🔒 This voice channel is already locked.');

    const allowed = [...channel.members.values()]
      .filter(m => !m.user.bot)
      .map(m => m.id);
    if (!allowed.includes(message.author.id)) allowed.push(message.author.id);

    getGuild(message.guild.id).channels[channel.id] = {
      locked: true,
      channelName: channel.name,
      lockedBy: message.author.id,
      lockedAt: Date.now(),
      allowed
    };
    save();

    return message.reply(`🔒 **${channel.name}** is now locked.\n✅ **${allowed.length}** users currently inside have access.`);
  }

  if (command === '?unlockvc') {
    if (!isLocked(message.guild.id, channel.id)) return message.reply('🔓 This voice channel is not locked.');
    delete getGuild(message.guild.id).channels[channel.id];
    save();
    return message.reply(`🔓 **${channel.name}** has been unlocked.`);
  }

  if (command === '?accesvc') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Use `?accesvc @user`.');
    const vc = getChannel(message.guild.id, channel.id);
    if (!vc?.locked) return message.reply('❌ Lock this VC first with `?lockvc`.');
    if (!vc.allowed.includes(target.id)) vc.allowed.push(target.id);
    save();
    return message.reply(`✅ ${target} now has access to **${channel.name}**.`);
  }

  if (command === '?removevc') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Use `?removevc @user`.');
    const vc = getChannel(message.guild.id, channel.id);
    if (!vc?.locked) return message.reply('❌ This VC is not locked.');
    vc.allowed = vc.allowed.filter(id => id !== target.id);
    save();
    if (target.voice?.channelId === channel.id) {
      try { await target.voice.disconnect('Removed from locked VC access.'); } catch (err) {
        console.error(`VC LOCK: failed to disconnect ${target.id}:`, err);
      }
    }
    return message.reply(`✅ ${target} was removed from the access list.`);
  }

  if (command === '?vcaccess') {
    const vc = getChannel(message.guild.id, channel.id);
    if (!vc?.locked) return message.reply('🔓 This VC is currently unlocked.');
    const lines = vc.allowed.map(id => `• <@${id}>`);
    return message.reply(`🔒 **${channel.name} — Access List**\n${lines.length ? lines.join('\n') : 'No users.'}\n\n**Total:** ${vc.allowed.length}`);
  }

  return message.reply(usage());
}

module.exports = { handleCommand, isLocked, hasAccess };
