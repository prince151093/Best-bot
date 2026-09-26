const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const CACHE_FILE = path.join(__dirname, 'garage-role-cache.json');
const RACER_ROLE_NAME = process.env.RACER_ROLE_NAME || 'Racers🏎';
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
} catch (_) {}

async function ensureTable() {
  // The table is created by competitive-schema.sql. This function exists only
  // as a central place for settings access; Supabase does not support CREATE
  // TABLE through the normal REST client.
}

async function setGarageRoleId(guildId, roleId) {
  const up = await sb.from('vehicle_life_settings').upsert({
    guild_id: String(guildId),
    garage_role_id: String(roleId),
    updated_at: new Date().toISOString()
  }, { onConflict: 'guild_id' });
  if (up.error) throw up.error;
  cache[String(guildId)] = String(roleId);
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (_) {}
  return String(roleId);
}

async function getGarageRoleId(guildId) {
  const q = await sb.from('vehicle_life_settings').select('garage_role_id').eq('guild_id', String(guildId)).maybeSingle();
  if (!q.error && q.data?.garage_role_id) {
    cache[String(guildId)] = String(q.data.garage_role_id);
    return String(q.data.garage_role_id);
  }
  return cache[String(guildId)] || null;
}

async function memberHasGarageRole(guildId, member) {
  const roleId = await getGarageRoleId(guildId);
  if (!roleId) return false;
  return Boolean(member?.roles?.cache?.has(roleId));
}


function findRacerRole(guild) {
  if (!guild?.roles?.cache) return null;
  return guild.roles.cache.find(role => role.name === RACER_ROLE_NAME) || null;
}

async function ensureRacerRole(member) {
  if (!member?.guild || !member?.roles?.add) return null;
  const role = findRacerRole(member.guild);
  if (!role) return null;
  if (member.roles.cache.has(role.id)) return role;
  if (!member.guild.members.me?.permissions?.has('ManageRoles')) return null;
  if (role.position >= member.guild.members.me.roles.highest.position) return null;
  try {
    await member.roles.add(role, 'Vehicle Life player');
    return role;
  } catch (err) {
    console.error(`Could not assign ${RACER_ROLE_NAME} role to ${member.id}:`, err.message || err);
    return null;
  }
}

async function racerRoleMention(guild) {
  const role = findRacerRole(guild);
  return role ? `<@&${role.id}>` : '';
}

async function garageRoleMention(guildId) {
  const roleId = await getGarageRoleId(guildId);
  return roleId ? `<@&${roleId}>` : '';
}

module.exports = {
  ensureTable,
  setGarageRoleId,
  getGarageRoleId,
  memberHasGarageRole,
  garageRoleMention,
  findRacerRole,
  ensureRacerRole,
  racerRoleMention,
  RACER_ROLE_NAME
};
