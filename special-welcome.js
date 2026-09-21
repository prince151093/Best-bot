const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const CONFIG_FILE = path.join(__dirname, 'special-welcome-config.json');
const TEMPLATE_FILE = path.join(__dirname, 'assets', 'special-welcome-template.png');

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    console.error('Special welcome config load error:', err);
    return {};
  }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function setWelcomeChannel(guildId, channelId) {
  const data = loadConfig();
  data[guildId] = { channelId };
  saveConfig(data);
}

function getWelcomeChannel(guildId) {
  return loadConfig()[guildId]?.channelId || null;
}

async function drawAvatar(ctx, avatarUrl, x, y, radius) {
  const avatar = await loadImage(avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();

  const scale = Math.max((radius * 2) / avatar.width, (radius * 2) / avatar.height);
  const w = avatar.width * scale;
  const h = avatar.height * scale;
  ctx.drawImage(avatar, x - w / 2, y - h / 2, w, h);
  ctx.restore();
}

function drawDynamicName(ctx, text, x, y, maxWidth) {
  let size = 46;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${size}px Arial`;
  while (ctx.measureText(text).width > maxWidth && size > 24) {
    size -= 2;
    ctx.font = `900 ${size}px Arial`;
  }
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#07152d';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#00a8ff';
  ctx.shadowColor = '#008cff';
  ctx.shadowBlur = 18;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
}

async function createWelcomeBanner(commandUser, newMember) {
  const base = await loadImage(TEMPLATE_FILE);
  const canvas = createCanvas(base.width, base.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);

  const commandAvatar = commandUser.displayAvatarURL({ extension: 'png', size: 256 });
  const memberAvatar = newMember.displayAvatarURL({ extension: 'png', size: 256 });

  // The two avatar circles in the supplied banner.
  await drawAvatar(ctx, commandAvatar, 224, 337, 73);
  await drawAvatar(ctx, memberAvatar, 1314, 337, 73);

  // Replace only the placeholder usernames in the supplied template.
  // The rest of the banner remains unchanged.
  const centerX = canvas.width / 2;
  const commandName = `@${commandUser.displayName}`;
  const memberName = `@${newMember.displayName}`;

  // Cover the existing placeholder name areas without touching the rest of the design.
  ctx.fillStyle = 'rgba(4, 13, 30, 0.88)';
  ctx.fillRect(505, 350, 530, 78);
  ctx.fillRect(667, 433, 205, 58);
  ctx.fillRect(152, 535, 270, 52);
  ctx.fillRect(1145, 535, 280, 52);

  drawDynamicName(ctx, memberName, centerX, 386, 500);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 43px Arial';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#07152d';
  ctx.strokeText(`HEY, I AM ${commandName}`, centerX, 470);
  ctx.fillStyle = '#f4f8ff';
  ctx.shadowColor = '#008cff';
  ctx.shadowBlur = 12;
  ctx.fillText(`HEY, I AM ${commandName}`, centerX, 470);
  ctx.shadowBlur = 0;

  ctx.font = '900 34px Arial';
  ctx.fillStyle = '#f4f8ff';
  ctx.strokeText('THANKS FOR JOINING US! 💙', centerX, 535);
  ctx.fillText('THANKS FOR JOINING US! 💙', centerX, 535);

  ctx.textAlign = 'left';
  ctx.font = '900 28px Arial';
  ctx.fillStyle = '#00a8ff';
  ctx.fillText(commandName, 154, 562);
  ctx.textAlign = 'left';
  ctx.fillText(memberName, 1148, 562);

  return canvas.toBuffer('image/png');
}

async function findLatestMember(guild) {
  let latest = null;
  for (const member of guild.members.cache.values()) {
    if (!member.joinedTimestamp) continue;
    if (!latest || member.joinedTimestamp > latest.joinedTimestamp) latest = member;
  }

  // Fetching helps when the local cache does not contain the newest member.
  if (!latest || Date.now() - latest.joinedTimestamp < 10 * 60 * 1000) {
    const fetched = await guild.members.fetch().catch(() => null);
    if (fetched) {
      for (const member of fetched.values()) {
        if (!member.joinedTimestamp) continue;
        if (!latest || member.joinedTimestamp > latest.joinedTimestamp) latest = member;
      }
    }
  }

  return latest;
}

async function handleSpecialWelcomeCommand(message) {
  const content = message.content.trim();
  const lower = content.toLowerCase();

  if (lower === '?setspecialwelcomechannel') {
    if (!message.member.permissions.has('ManageGuild')) {
      await message.reply('❌ You need **Manage Server** permission.');
      return true;
    }
    setWelcomeChannel(message.guild.id, message.channel.id);
    await message.reply(`✅ Special welcome channel set to ${message.channel}.`);
    return true;
  }

  if (!lower.startsWith('?w')) return false;
  if (lower !== '?w') return true;

  const configuredChannel = getWelcomeChannel(message.guild.id);
  if (!configuredChannel) {
    await message.reply('❌ Set the special welcome channel first with `?setspecialwelcomechannel`.');
    return true;
  }

  if (message.channel.id !== configuredChannel) {
    return true;
  }

  const latest = await findLatestMember(message.guild);
  if (!latest) {
    await message.reply('❌ I could not find a recently joined member.');
    return true;
  }

  try {
    const image = await createWelcomeBanner(message.member, latest);
    await message.channel.send({
      content: `${latest} AGAIN THANKS FROM ${message.member} FOR JOINING US LET'S DO FUN TOGETHER :love1::love2:`,
      files: [{ attachment: image, name: 'special-welcome.png' }],
      allowedMentions: { users: [latest.id, message.author.id] }
    });
  } catch (err) {
    console.error('Special welcome generation error:', err);
    await message.reply('❌ I could not generate the special welcome banner.');
  }

  return true;
}

module.exports = {
  handleSpecialWelcomeCommand
};
