const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

if (!config.supabaseUrl) {
  console.error("Missing SUPABASE_URL environment variable.");
  process.exit(1);
}
if (!config.supabaseServiceRoleKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const TABLE = "users";
const users = new Map();

function key(userId, guildId) {
  return `${String(guildId)}:${String(userId)}`;
}

function normalize(row) {
  return {
    user_id: String(row.user_id),
    guild_id: String(row.guild_id),
    messages: Number(row.messages || 0),
    vc_seconds: Number(row.vc_seconds || 0),
    vehicle_index: Number(row.vehicle_index || 0),
    last_vc_join:
      row.last_vc_join === null || row.last_vc_join === undefined
        ? null
        : Number(row.last_vc_join),
    updated_at: Number(row.updated_at || 0),
    instagram: row.instagram || null
  };
}

async function init() {
  let from = 0;
  const pageSize = 1000;
  let count = 0;

  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("user_id,guild_id,messages,vc_seconds,vehicle_index,last_vc_join,updated_at,instagram")
      .range(from, from + pageSize - 1);

    if (error) throw error;

    for (const row of data || []) {
      const user = normalize(row);
      users.set(key(user.user_id, user.guild_id), user);
      count++;
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`Supabase connected. Vehicle Life loaded ${count} user record(s).`);
}

function ensureCached(userId, guildId) {
  return users.get(key(userId, guildId)) || {
    user_id: String(userId),
    guild_id: String(guildId),
    messages: 0,
    vc_seconds: 0,
    vehicle_index: 0,
    last_vc_join: null,
    updated_at: 0,
    instagram: null
  };
}

function getUser(userId, guildId) {
  const cached = ensureCached(userId, guildId);
  const live = { ...cached };

  if (live.last_vc_join !== null && live.last_vc_join !== undefined) {
    const elapsed = Math.floor((Date.now() - Number(live.last_vc_join)) / 1000);
    if (Number.isFinite(elapsed) && elapsed > 0) {
      live.vc_seconds += elapsed;
    }
  }

  return live;
}

async function setVehicleIndex(userId, guildId, index) {
  const value = Math.max(0, Math.floor(Number(index) || 0));
  const current = ensureCached(userId, guildId);
  const updated = {
    ...current,
    user_id: String(userId),
    guild_id: String(guildId),
    vehicle_index: value,
    updated_at: Math.floor(Date.now() / 1000)
  };

  users.set(key(userId, guildId), updated);

  const { error } = await supabase
    .from(TABLE)
    .upsert({
      user_id: updated.user_id,
      guild_id: updated.guild_id,
      messages: updated.messages,
      vc_seconds: updated.vc_seconds,
      vehicle_index: value,
      last_vc_join: updated.last_vc_join,
      updated_at: updated.updated_at,
      instagram: updated.instagram
    }, { onConflict: "guild_id,user_id" });

  if (error) {
    console.error("Could not save Vehicle Life vehicle index:", error);
    throw error;
  }

  return { ...updated };
}

async function resetUserProgress(userId, guildId) {
  const current = ensureCached(userId, guildId);
  const updated = {
    ...current,
    vehicle_index: 0,
    updated_at: Math.floor(Date.now() / 1000)
  };

  users.set(key(userId, guildId), updated);

  const { error } = await supabase
    .from(TABLE)
    .update({
      vehicle_index: 0,
      updated_at: updated.updated_at
    })
    .eq("guild_id", String(guildId))
    .eq("user_id", String(userId));

  if (error) throw error;
  return { ...updated };
}

async function close() {
  users.clear();
}

module.exports = {
  init,
  close,
  getUser,
  setVehicleIndex,
  resetUserProgress
};
