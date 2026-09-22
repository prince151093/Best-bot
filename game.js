const { createClient } = require('@supabase/supabase-js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const config = require('./config');
const { vehicles } = require('./vehicles');
const { getUser, setVehicleIndex, resetUserProgress } = require('./db');

const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const pendingBets = new Map();
const pendingTrades = new Map();
const pendingSales = new Map();
const pendingRaces = new Map();
const pendingEventEntries = new Map();

const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC', 'EXCLUSIVE'];
const CLASSES = ['D', 'C', 'B', 'A', 'S', 'S+', 'X'];
const UPGRADE_TYPES = ['engine', 'turbo', 'ecu', 'transmission', 'suspension', 'brakes', 'tires', 'weight'];

const MISSION_DEFS = [
  ['races', 'Complete 5 races', 5, 50000],
  ['wins', 'Win 3 races', 3, 75000],
  ['earn', 'Earn ₹50000', 50000, 60000],
  ['upgrade', 'Upgrade a vehicle', 1, 30000],
  ['rare', 'Use a Rare+ vehicle', 1, 40000]
];

const ACHIEVEMENTS = {
  first_vehicle: ['First Vehicle', 'Own your first vehicle'],
  first_race: ['First Race', 'Complete your first race'],
  first_win: ['First Win', 'Win your first race'],
  millionaire: ['Millionaire', 'Reach ₹1,000,000'],
  wins10: ['10 Wins', 'Win 10 races'],
  wins50: ['50 Wins', 'Win 50 races'],
  wins100: ['100 Wins', 'Win 100 races'],
  supercar: ['Supercar Collector', 'Own 5 high-performance cars'],
  legendary: ['Legendary Collector', 'Own a Legendary vehicle'],
  fullgarage: ['Full Garage', `Own all ${vehicles.length} vehicles`],
  speed: ['Speed Demon', 'Own a vehicle above 300 km/h'],
  master: ['Master Racer', 'Complete 100 races']
};

const UPGRADES = {
  engine:       { label: 'Engine', power: 5, speed: 2, accel: 1, launch: 1 },
  turbo:        { label: 'Turbo', power: 2, accel: 3 },
  ecu:          { label: 'ECU', power: 1 },
  transmission: { label: 'Transmission', speed: 2, accel: 1, launch: 1 },
  suspension:   { label: 'Suspension', handling: 2 },
  brakes:       { label: 'Brakes', braking: 2 },
  tires:        { label: 'Tires', handling: 1, braking: 2 },
  weight:       { label: 'Weight Reduction', weight: -20, accel: 1, handling: 1 }
};

function meta(v) {
  const i = v.id;
  const rarity = i <= 15 ? 'COMMON' : i <= 30 ? 'UNCOMMON' : i <= 50 ? 'RARE' : i <= 70 ? 'EPIC' : i <= 90 ? 'LEGENDARY' : i <= 105 ? 'MYTHIC' : 'EXCLUSIVE';
  const cls = i <= 15 ? 'D' : i <= 30 ? 'C' : i <= 50 ? 'B' : i <= 70 ? 'A' : i <= 90 ? 'S' : i <= 105 ? 'S+' : 'X';
  const power = Math.round(25 + i * 5.2);
  const topSpeed = Math.round(55 + i * 3.15);
  const acceleration = 40 + (i % 30);
  const handling = 40 + ((i * 7) % 58);
  const braking = 35 + ((i * 9) % 60);
  const weight = Math.max(850, 1900 - i * 7);
  const launch = 35 + ((i * 11) % 60);
  const performance = Math.round((power / 3 + topSpeed / 3 + acceleration + handling + braking + launch) / 4);
  const price = Math.round((15000 * Math.pow(1.075, i - 1)) / 1000) * 1000;
  return { ...v, rarity, class: cls, power, topSpeed, acceleration, handling, braking, weight, launch, performance, price };
}

const V = vehicles.map(meta);

function money(n) {
  return `₹${Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('en-IN')}`;
}
function levelForXp(xp) { return Math.max(1, Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 100)) + 1); }
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.PROGRESSION_TIMEZONE || 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function rarityRank(r) { return RARITIES.indexOf(r); }
function classRank(c) { return CLASSES.indexOf(c); }
function findVehicle(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  const id = Number(s.replace(/^#/, ''));
  if (Number.isInteger(id) && id >= 1 && id <= V.length) return V[id - 1];
  return V.find(v => v.name.toLowerCase() === s) || V.find(v => v.name.toLowerCase().includes(s));
}
function findVehicleExact(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  const id = Number(s.replace(/^#/, ''));
  if (Number.isInteger(id) && id >= 1 && id <= V.length) return V[id - 1];
  return V.find(v => v.name.toLowerCase() === s) || null;
}
function vehicleImage(v) { return path.join(__dirname, v.image); }
function imageName(v) { return `vehicle-${String(v.id).padStart(2, '0')}.png`; }
function safeJson(v, fallback = {}) { return v && typeof v === 'object' ? v : fallback; }
function normalizeVehicleRow(row) {
  return {
    ...row,
    level: Number(row.level || 1),
    xp: Number(row.xp || 0),
    condition: Math.max(0, Math.min(100, Number(row.condition ?? 100))),
    upgrades: safeJson(row.upgrades),
    custom: safeJson(row.custom)
  };
}

async function profile(guildId, userId) {
  let r = await sb.from('game_profiles').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) {
    const row = {
      guild_id: guildId,
      user_id: userId,
      balance: 100000,
      driver_xp: 0,
      driver_level: 1,
      daily_streak: 0,
      daily_claimed_on: null,
      active_vehicle_id: null,
      race_vehicle_id: null,
      season_xp: 0
    };
    const created = await sb.from('game_profiles').insert(row).select().single();
    if (created.error) throw created.error;
    r.data = created.data;
  }
  return r.data;
}

async function vehiclesOf(guildId, userId) {
  const r = await sb.from('user_vehicles').select('*').eq('guild_id', guildId).eq('user_id', userId).order('vehicle_id');
  if (r.error) throw r.error;
  return (r.data || []).map(normalizeVehicleRow);
}

// Legacy data is no longer converted into ownership. vehicle_index is only the
// sequential unlock counter used by index.js; this prevents the old 62/115 bug.
async function syncLegacyOwnership(guildId, userId) { return vehiclesOf(guildId, userId); }

async function own(guildId, userId, v) {
  const r = await sb.from('user_vehicles').select('*').eq('guild_id', guildId).eq('user_id', userId).eq('vehicle_id', v.id).maybeSingle();
  if (r.error) throw r.error;
  return r.data ? normalizeVehicleRow(r.data) : null;
}

async function grantProgressionVehicle(guildId, userId, index) {
  const id = Number(index);
  if (!Number.isInteger(id) || id < 1 || id > V.length) throw new Error('INVALID_PROGRESSION_VEHICLE');
  const v = V[id - 1];
  const existing = await own(guildId, userId, v);
  if (existing) return { vehicle: v, granted: false, existing };
  const r = await sb.from('user_vehicles').insert({ guild_id: guildId, user_id: userId, vehicle_id: v.id, level: 1, xp: 0, condition: 100, upgrades: {}, custom: {} }).select().single();
  if (r.error && !String(r.error.message).toLowerCase().includes('duplicate')) throw r.error;
  const p = await profile(guildId, userId);
  if (!p.active_vehicle_id) {
    const u = await sb.from('game_profiles').update({ active_vehicle_id: v.id, updated_at: new Date().toISOString() }).eq('guild_id', guildId).eq('user_id', userId);
    if (u.error) throw u.error;
  }
  await unlockAchievement(guildId, userId, 'first_vehicle').catch(err =>
    console.error('First vehicle achievement update failed:', err.message || err)
  );
  return { vehicle: v, granted: true };
}

async function transaction(guildId, userId, type, amount, reference, metadata = {}) {
  const r = await sb.from('transactions').insert({ guild_id: guildId, user_id: userId, type, amount: Math.trunc(amount), reference: String(reference || ''), metadata });
  if (r.error) throw r.error;
}

async function changeBalance(guildId, userId, delta, type, reference, metadata = {}, countAsEarned = Number(delta) > 0) {
  const amount = Math.trunc(Number(delta) || 0);
  if (!Number.isSafeInteger(amount) || !String(type || '').trim()) throw new Error('INVALID_BALANCE_CHANGE');
  const r = await sb.rpc('change_game_balance', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_delta: amount,
    p_type: String(type),
    p_reference: String(reference ?? ''),
    p_metadata: metadata && typeof metadata === 'object' ? metadata : {},
    p_count_earned: Boolean(countAsEarned)
  });
  if (r.error) {
    if (String(r.error.message || '').includes('INSUFFICIENT_FUNDS')) throw new Error('INSUFFICIENT_FUNDS');
    throw r.error;
  }
  const next = Number(r.data);
  if (countAsEarned && amount > 0) await updateMission(guildId, userId, 'earn', amount, false);
  return next;
}

async function addDriverXp(guildId, userId, delta) {
  const p = await profile(guildId, userId);
  const xp = Number(p.driver_xp || 0) + Math.max(0, Number(delta) || 0);
  const level = levelForXp(xp);
  const r = await sb.from('game_profiles').update({ driver_xp: xp, driver_level: level, updated_at: new Date().toISOString() }).eq('guild_id', guildId).eq('user_id', userId);
  if (r.error) throw r.error;
  return { xp, level };
}

async function addVehicleXp(guildId, userId, vehicleId, delta) {
  const o = await sb.from('user_vehicles').select('*').eq('guild_id', guildId).eq('user_id', userId).eq('vehicle_id', vehicleId).maybeSingle();
  if (o.error) throw o.error;
  if (!o.data) return null;
  const xp = Number(o.data.xp || 0) + Math.max(0, Number(delta) || 0);
  const level = Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
  const r = await sb.from('user_vehicles').update({ xp, level }).eq('id', o.data.id);
  if (r.error) throw r.error;
  return { xp, level };
}

async function updateMission(guildId, userId, key, amount = 1, rewardOnComplete = true) {
  const def = MISSION_DEFS.find(x => x[0] === key);
  if (!def || !amount) return;
  const period = todayKey();
  const [, , target, reward] = def;
  let r = await sb.from('missions').select('*').eq('guild_id', guildId).eq('user_id', userId).eq('mission_key', key).eq('period_key', period).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) {
    r = await sb.from('missions').insert({ guild_id: guildId, user_id: userId, mission_key: key, progress: 0, target, reward, period_key: period, completed: false }).select().single();
    if (r.error) throw r.error;
  }
  const m = r.data;
  if (m.completed) return;
  const progress = Math.min(Number(target), Number(m.progress || 0) + Number(amount));
  const completed = progress >= Number(target);
  const u = await sb.from('missions').update({ progress, completed }).eq('id', m.id);
  if (u.error) throw u.error;
  if (completed && rewardOnComplete) {
    await changeBalance(guildId, userId, reward, 'mission_reward', key, { mission: key }, false);
    await addDriverXp(guildId, userId, 100);
  }
}

async function ensureDailyMissions(guildId, userId) {
  const period = todayKey();
  for (const [mission_key, , target, reward] of MISSION_DEFS) {
    const r = await sb.from('missions').select('id').eq('guild_id', guildId).eq('user_id', userId).eq('mission_key', mission_key).eq('period_key', period).maybeSingle();
    if (r.error) throw r.error;
    if (!r.data) {
      const ins = await sb.from('missions').insert({ guild_id: guildId, user_id: userId, mission_key, progress: 0, target, reward, period_key: period, completed: false });
      if (ins.error && !String(ins.error.message).toLowerCase().includes('duplicate')) throw ins.error;
    }
  }
}

async function unlockAchievement(guildId, userId, key) {
  if (!ACHIEVEMENTS[key]) return;
  const r = await sb.from('achievements').upsert({ guild_id: guildId, user_id: userId, achievement_key: key }, { onConflict: 'guild_id,user_id,achievement_key', ignoreDuplicates: true });
  if (r.error) throw r.error;
}

async function checkAchievements(guildId, userId) {
  const p = await profile(guildId, userId);
  const owneds = await vehiclesOf(guildId, userId);
  const racesR = await sb.from('races').select('winner,racer_a,racer_b,status').eq('guild_id', guildId).or(`racer_a.eq.${userId},racer_b.eq.${userId}`);
  if (racesR.error) throw racesR.error;
  const races = racesR.data || [];
  const finished = races.filter(r => r.status === 'finished');
  const wins = finished.filter(r => r.winner === userId).length;
  if (owneds.length) await unlockAchievement(guildId, userId, 'first_vehicle');
  if (finished.length) await unlockAchievement(guildId, userId, 'first_race');
  if (wins) await unlockAchievement(guildId, userId, 'first_win');
  if (Number(p.balance) >= 1000000) await unlockAchievement(guildId, userId, 'millionaire');
  if (wins >= 10) await unlockAchievement(guildId, userId, 'wins10');
  if (wins >= 50) await unlockAchievement(guildId, userId, 'wins50');
  if (wins >= 100) await unlockAchievement(guildId, userId, 'wins100');
  if (owneds.length >= V.length) await unlockAchievement(guildId, userId, 'fullgarage');
  if (owneds.some(o => rarityRank(V[o.vehicle_id - 1]?.rarity) >= rarityRank('LEGENDARY'))) await unlockAchievement(guildId, userId, 'legendary');
  if (owneds.filter(o => V[o.vehicle_id - 1]?.category === 'car' && V[o.vehicle_id - 1]?.performance >= 150).length >= 5) await unlockAchievement(guildId, userId, 'supercar');
  if (finished.length >= 100) await unlockAchievement(guildId, userId, 'master');
  if (owneds.some(o => V[o.vehicle_id - 1]?.topSpeed >= 300)) await unlockAchievement(guildId, userId, 'speed');
}

function progressionIndex(guildId, userId) {
  const u = getUser(userId, guildId);
  return Math.max(0, Math.min(Number(u?.vehicle_index || 0), V.length));
}

async function buy(guild, member, arg) {
  const v = findVehicle(arg);
  if (!v) return '❌ Vehicle not found. Use `?dealership` or `?buy <vehicle number/name>`.';
  // Vehicles can be purchased directly with in-game cash even if progression
  // has not unlocked them yet. Progression still controls progression rewards.
  const p = await profile(guild.id, member.id);
  if (await own(guild.id, member.id, v)) return `❌ You already own **${v.name}**.`;
  if (Number(p.balance) < v.price) return `❌ You need ${money(v.price)} but have ${money(p.balance)}.`;
  await changeBalance(guild.id, member.id, -v.price, 'vehicle_purchase', v.id, { vehicle: v.name }, false);
  const r = await sb.from('user_vehicles').insert({ guild_id: guild.id, user_id: member.id, vehicle_id: v.id, level: 1, xp: 0, condition: 100, upgrades: {}, custom: {} }).select().single();
  if (r.error) {
    await changeBalance(guild.id, member.id, v.price, 'vehicle_purchase_refund', v.id, { vehicle: v.name }, false).catch(() => {});
    if (String(r.error.message).toLowerCase().includes('duplicate')) return `❌ You already own **${v.name}**.`;
    throw r.error;
  }
  const p2 = await profile(guild.id, member.id);
  if (!p2.active_vehicle_id) await sb.from('game_profiles').update({ active_vehicle_id: v.id }).eq('guild_id', guild.id).eq('user_id', member.id);
  await unlockAchievement(guild.id, member.id, 'first_vehicle');
  return `🎉 ${member} bought **${v.name}** for **${money(v.price)}**! It is now in your garage.`;
}

function dealershipPage(page = 0) {
  const per = 5;
  const total = Math.ceil(V.length / per);
  const p = Math.max(0, Math.min(Number(page) || 0, total - 1));
  const slice = V.slice(p * per, p * per + per);
  const embed = new EmbedBuilder()
    .setTitle('🏪 VEHICLE LIFE DEALERSHIP')
    .setDescription(slice.map(v => `**#${v.id} ${v.emoji} ${v.name}**\n${v.rarity} • Class ${v.class} • ⚡ ${v.performance}\n💰 ${money(v.price)} • 🏎️ ${v.topSpeed} km/h`).join('\n\n'))
    .setFooter({ text: `Page ${p + 1}/${total} • 5 vehicles per page • Use ?buy <ID>` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dealer:prev:${p}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
    ...slice.map(v => new ButtonBuilder().setCustomId(`buy:${v.id}`).setLabel(`#${v.id}`).setStyle(ButtonStyle.Success)),
    new ButtonBuilder().setCustomId(`dealer:next:${p}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(p >= total - 1)
  );
  // Discord allows max 5 buttons in one row; put navigation and vehicle buttons in separate rows.
  const vehicleRow = new ActionRowBuilder().addComponents(...slice.map(v => new ButtonBuilder().setCustomId(`buy:${v.id}`).setLabel(`Buy #${v.id}`).setStyle(ButtonStyle.Success)));
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dealer:prev:${p}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
    new ButtonBuilder().setCustomId(`dealer:next:${p}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(p >= total - 1)
  );
  return { embed, rows: [vehicleRow, navRow] };
}

function vehicleStats(v, o) {
  const up = safeJson(o?.upgrades);
  const s = { power: v.power, speed: v.topSpeed, accel: v.acceleration, handling: v.handling, braking: v.braking, weight: v.weight, launch: v.launch };
  for (const [type, levelRaw] of Object.entries(up)) {
    const level = Math.max(0, Number(levelRaw) || 0);
    const def = UPGRADES[type];
    if (!def) continue;
    for (const [stat, value] of Object.entries(def)) if (stat !== 'label') s[stat] += Number(value) * level;
  }
  return s;
}
function raceScore(v, o, type) {
  const s = vehicleStats(v, o);
  const condition = Math.max(0, Number(o?.condition ?? 100)) / 100;
  if (type === 'drag') return (s.launch * 2 + s.accel * 2 + s.power + s.speed * 0.5) * condition;
  if (type === 'track') return (s.handling * 2 + s.braking * 2 + s.accel + s.speed * 0.3) * condition;
  if (type === 'time') return (s.speed * 0.9 + s.accel * 1.4 + s.handling * 0.8 + s.braking * 0.5) * condition;
  return (s.power + s.speed + s.accel + s.handling + s.braking + s.launch) * condition;
}

async function activeSeason(guildId) {
  const r = await sb.from('seasons').select('*').eq('guild_id', guildId).eq('active', true).order('season_no', { ascending: false }).limit(1).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}

async function addSeasonXp(guildId, userId, amount) {
  const p = await profile(guildId, userId);
  const next = Number(p.season_xp || 0) + Math.max(0, Number(amount) || 0);
  const r = await sb.from('game_profiles').update({ season_xp: next }).eq('guild_id', guildId).eq('user_id', userId);
  if (r.error) throw r.error;
  return next;
}

async function recordEventScore(guildId, userId, points) {
  if (!points) return;
  const r = await sb.from('events').select('id').eq('guild_id', guildId).eq('status', 'open').lte('starts_at', new Date().toISOString()).gte('ends_at', new Date().toISOString());
  if (r.error) throw r.error;
  for (const e of r.data || []) {
    const entry = await sb.from('event_entries').select('id,score').eq('event_id', e.id).eq('user_id', userId).maybeSingle();
    if (entry.error) throw entry.error;
    if (entry.data) {
      const u = await sb.from('event_entries').update({ score: Number(entry.data.score || 0) + points }).eq('id', entry.data.id);
      if (u.error) throw u.error;
    }
  }
}

async function settleClosedEvents(guildId) {
  const now = new Date().toISOString();
  const r = await sb.from('events').select('*').eq('guild_id', guildId).eq('status', 'open').lt('ends_at', now);
  if (r.error) throw r.error;
  for (const e of r.data || []) {
    const entries = await sb.from('event_entries').select('*').eq('event_id', e.id).order('score', { ascending: false }).limit(1);
    if (entries.error) throw entries.error;
    const winner = entries.data?.[0];
    const cash = Number(e.rewards?.cash || 0);
    const xp = Number(e.rewards?.xp || 0);
    if (winner && !winner.rewarded) {
      if (cash > 0) await changeBalance(guildId, winner.user_id, cash, 'event_reward', e.id, { event: e.name }, false);
      if (xp > 0) { await addDriverXp(guildId, winner.user_id, xp); await addSeasonXp(guildId, winner.user_id, xp); }
      await sb.from('event_entries').update({ rewarded: true }).eq('id', winner.id);
    }
    await sb.from('events').update({ status: 'closed', rewarded: true }).eq('id', e.id);
  }
}

async function runRace(guild, member, type = 'race', opponentMember = null, options = {}) {
  const season = await activeSeason(guild.id);
  const p = await profile(guild.id, member.id);
  if (!p.race_vehicle_id) return { error: '🏁 No race vehicle selected. Use `?setasracecar <vehicle ID>` first.' };
  const a = await own(guild.id, member.id, V[p.race_vehicle_id - 1]);
  if (!a) return { error: '❌ Your selected race vehicle is no longer in your garage. Use `?setasracecar` again.' };
  const av = V[a.vehicle_id - 1];
  if (Number(a.condition) <= 0) return { error: '🛠️ Your race vehicle is at 0% condition. Use `?repair <vehicle>` before racing.' };
  if (!av) return { error: '❌ Your selected race vehicle is invalid.' };

  if (!opponentMember) {
    const score = raceScore(av, a, type);
    const time = Math.max(8, 70 - score / 10 + Math.random() * 2);
    const condition = Math.max(0, a.condition - (type === 'time' ? 1 : 2));
    await sb.from('user_vehicles').update({ condition }).eq('id', a.id);
    // Race winner reward = 1% of the winning vehicle's purchase price.
    const reward = Math.max(1, Math.floor(av.price * 0.01));
    await changeBalance(guild.id, member.id, reward, 'race_reward', type, { vehicle: av.id });
    await addDriverXp(guild.id, member.id, 50);
    await addVehicleXp(guild.id, member.id, av.id, 25);
    await updateMission(guild.id, member.id, 'races', 1);
    await updateMission(guild.id, member.id, 'rare', rarityRank(av.rarity) >= rarityRank('RARE') ? 1 : 0);
    const r = await sb.from('races').insert({ guild_id: guild.id, racer_a: member.id, racer_b: null, vehicle_a: av.id, vehicle_b: null, type, winner: member.id, stake: 0, pot: reward, time_a: Number(time.toFixed(3)), time_b: null, status: 'finished', season_no: season?.season_no || null }).select().single();
    if (r.error) throw r.error;
    await addSeasonXp(guild.id, member.id, 50);
    await recordEventScore(guild.id, member.id, 1);
    await checkAchievements(guild.id, member.id);
    return { winnerId: member.id, timeA: time, reward, vehicleA: av, solo: true };
  }

  const op = await profile(guild.id, opponentMember.id);
  if (!op.race_vehicle_id) return { error: `❌ ${opponentMember} has no race vehicle selected. They must use \`?setasracecar <vehicle ID>\`.` };
  const b = await own(guild.id, opponentMember.id, V[op.race_vehicle_id - 1]);
  if (!b) return { error: `❌ ${opponentMember}'s selected race vehicle is no longer in their garage.` };
  const bv = V[b.vehicle_id - 1];
  if (Number(b.condition) <= 0) return { error: `🛠️ ${opponentMember} cannot race because their race vehicle is at 0% condition.` };
  const sa = raceScore(av, a, type), sbv = raceScore(bv, b, type);
  // Competitive races start at 50/50. Vehicle performance adjusts the
  // probability, but never makes either side certain.
  const totalScore = Math.max(1, sa + sbv);
  const statDelta = ((sa - sbv) / totalScore) * 100;
  const chanceA = Math.max(30, Math.min(70, 50 + statDelta));
  const winnerIsA = Math.random() * 100 < chanceA;
  const winner = winnerIsA ? member : opponentMember;
  const loser = winnerIsA ? opponentMember : member;
  const winnerVehicle = winnerIsA ? av : bv;
  const ta = Math.max(8, 70 - sa / 10 + Math.random() * 2);
  const tb = Math.max(8, 70 - sbv / 10 + Math.random() * 2);
  await sb.from('user_vehicles').update({ condition: Math.max(0, a.condition - (winnerIsA ? 2 : 4)) }).eq('id', a.id);
  await sb.from('user_vehicles').update({ condition: Math.max(0, b.condition - (winnerIsA ? 4 : 2)) }).eq('id', b.id);
  if (!options.noRewards) {
    // Race winner reward = 1% of the winning vehicle's purchase price.
    const reward = Math.max(1, Math.floor(winnerVehicle.price * 0.01));
    await changeBalance(guild.id, winner.id, reward, 'race_reward', type, { vehicle: winnerVehicle.id });
    await addDriverXp(guild.id, winner.id, 100);
    await addDriverXp(guild.id, loser.id, 25);
    await addVehicleXp(guild.id, winner.id, winnerVehicle.id, 50);
    await updateMission(guild.id, winner.id, 'wins', 1);
    await updateMission(guild.id, winner.id, 'races', 1);
    await updateMission(guild.id, loser.id, 'races', 1);
    await updateMission(guild.id, winner.id, 'rare', rarityRank(winnerVehicle.rarity) >= rarityRank('RARE') ? 1 : 0);
  }
  const r = await sb.from('races').insert({ guild_id: guild.id, racer_a: member.id, racer_b: opponentMember.id, vehicle_a: av.id, vehicle_b: bv.id, type, winner: winner.id, stake: Number(options.stake || 0), pot: Number(options.pot || (options.noRewards ? 0 : Math.max(1, Math.floor(winnerVehicle.price * 0.01)))), time_a: Number(ta.toFixed(3)), time_b: Number(tb.toFixed(3)), status: 'finished', season_no: season?.season_no || null }).select().single();
  if (r.error) throw r.error;
  if (!options.noRewards) {
    await addSeasonXp(guild.id, winner.id, 100);
    await addSeasonXp(guild.id, loser.id, 25);
    await recordEventScore(guild.id, winner.id, 3);
    await recordEventScore(guild.id, loser.id, 1);
  }
  await checkAchievements(guild.id, member.id);
  await checkAchievements(guild.id, opponentMember.id);
  return {
    winnerId: winner.id, loserId: loser.id, timeA: ta, timeB: tb,
    vehicleA: av, vehicleB: bv, winnerVehicle, winner,
    chanceA: Number(chanceA.toFixed(1)), chanceB: Number((100 - chanceA).toFixed(1)),
    scoreA: Number(sa.toFixed(2)), scoreB: Number(sbv.toFixed(2))
  };
}

function raceText(type, result, rewardText = '') {
  if (result.error) return result.error;
  if (result.solo) return `🏁 **${type.toUpperCase()} COMPLETE**\n🚗 ${result.vehicleA.emoji} **${result.vehicleA.name}**\n⏱️ Time: **${result.timeA.toFixed(2)}s**\n💰 Reward: **${money(result.reward)}**\n🧑‍✈️ +50 Driver XP\n🛠️ Condition reduced by race wear.${rewardText}`;
  return `🏁 **${type.toUpperCase()}**\n${result.vehicleA.emoji} **${result.vehicleA.name}** vs ${result.vehicleB.emoji} **${result.vehicleB.name}**\n🏆 Winner: <@${result.winnerId}>\n⏱️ ${result.timeA.toFixed(2)}s vs ${result.timeB.toFixed(2)}s${rewardText}`;
}

async function listMarketplace(guildId, sellerId, vehicleId, price) {
  const existing = await sb.from('marketplace').select('id').eq('guild_id', guildId).eq('seller_id', sellerId).eq('vehicle_id', vehicleId).eq('status', 'active').maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) throw new Error('ALREADY_LISTED');
  const r = await sb.from('marketplace').insert({ guild_id: guildId, seller_id: sellerId, vehicle_id: vehicleId, price: Math.floor(price), status: 'active' }).select().single();
  if (r.error) {
    if (String(r.error.message || '').toLowerCase().includes('duplicate') || String(r.error.code || '') === '23505') throw new Error('ALREADY_LISTED');
    throw r.error;
  }
  return r.data;
}

async function topGarages(guildId, limit = 10) {
  const profiles = await sb.from('game_profiles').select('user_id,balance,driver_xp,driver_level,active_vehicle_id').eq('guild_id', guildId);
  if (profiles.error) throw profiles.error;
  const all = [];
  for (const p of profiles.data || []) {
    const owned = await vehiclesOf(guildId, p.user_id);
    if (!owned.length) continue;
    const sorted = [...owned].sort((a, b) => b.vehicle_id - a.vehicle_id);
    const best = sorted.map(o => V[o.vehicle_id - 1]).filter(Boolean).sort((a, b) => classRank(b.class) - classRank(a.class) || b.performance - a.performance)[0];
    const score = owned.length * 1000 + owned.reduce((n, o) => n + classRank(V[o.vehicle_id - 1]?.class || 'D') * 100, 0) + Number(p.driver_xp || 0);
    all.push({ ...p, owned, best, score });
  }
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, limit);
}

async function ensureLiveWorld(guildId) {
  const now = new Date();
  let seasonR = await sb.from('seasons').select('*').eq('guild_id', guildId).eq('active', true).order('season_no', { ascending: false }).limit(1).maybeSingle();
  if (seasonR.error) throw seasonR.error;
  let season = seasonR.data;
  if (!season || !season.ends_at || new Date(season.ends_at) <= now) {
    if (season?.id) await sb.from('seasons').update({ active: false }).eq('id', season.id);
    const latest = await sb.from('seasons').select('season_no').eq('guild_id', guildId).order('season_no', { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    const no = Number(latest.data?.season_no || 0) + 1;
    const starts = now.toISOString();
    const ends = new Date(now.getTime() + 30 * 86400000).toISOString();
    const ins = await sb.from('seasons').insert({ guild_id: guildId, season_no: no, name: `Season ${no} • Road to Glory`, active: true, starts_at: starts, ends_at: ends }).select().single();
    if (ins.error) throw ins.error;
    season = ins.data;
  }
  const open = await sb.from('events').select('id').eq('guild_id', guildId).eq('status', 'open');
  if (open.error) throw open.error;
  if (!open.data?.length) {
    const ends = new Date(now.getTime() + 24 * 3600000).toISOString();
    const ins = await sb.from('events').insert({ guild_id: guildId, name: 'Daily Sprint', description: 'Complete races during the event and earn a bonus.', entry_fee: 0, status: 'open', starts_at: now.toISOString(), ends_at: ends, rewards: { cash: 25000, xp: 150 } });
    if (ins.error) throw ins.error;
  }
  return season;
}

async function startAutomation(client) {
  // Keep startup light. Daily missions are created lazily when a player uses
  // the game, while this task only rotates seasons/events once per hour.
  const tick = async () => {
    for (const guild of client.guilds.cache.values()) {
      try { await ensureLiveWorld(guild.id); await settleClosedEvents(guild.id); } catch (e) { console.error(`Vehicle Life world automation failed for ${guild.id}:`, e.message); }
    }
  };
  await tick();
  setInterval(tick, 60 * 60 * 1000).unref?.();
}

function profileEmbed(member, p, owned, best) {
  return new EmbedBuilder()
    .setTitle(`👤 ${member.displayName} • VEHICLE LIFE`)
    .setDescription(`🧑‍✈️ Driver Level **${p.driver_level}** • **${p.driver_xp} XP**\n💰 Balance **${money(p.balance)}**`)
    .addFields(
      { name: '🚗 Garage', value: `${owned.length}/${V.length} vehicles`, inline: true },
      { name: '🏁 Race Car', value: p.race_vehicle_id && V[p.race_vehicle_id - 1] ? `${V[p.race_vehicle_id - 1].emoji} ${V[p.race_vehicle_id - 1].name}` : 'Not selected', inline: true },
      { name: '🏆 Best Vehicle', value: best ? `${best.emoji} ${best.name}\nClass ${best.class} • ⚡ ${best.performance}` : 'None', inline: true }
    );
}

function mainMenuRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vlmenu:profile').setLabel('Profile').setEmoji('👤').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vlmenu:garage').setLabel('Garage').setEmoji('🏠').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('vlmenu:dealership').setLabel('Dealership').setEmoji('🚗').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vlmenu:race').setLabel('Race').setEmoji('🏁').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('vlmenu:balance').setLabel('Balance').setEmoji('💰').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vlmenu:daily').setLabel('Daily Reward').setEmoji('🎁').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vlmenu:missions').setLabel('Missions').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vlmenu:achievements').setLabel('Achievements').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vlmenu:market').setLabel('Market').setEmoji('🛒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vlmenu:events').setLabel('Events').setEmoji('🎉').setStyle(ButtonStyle.Success)
    )
  ];
}

function vehicleActionRows(vehicleId, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vehicleaction:active:${ownerId}:${vehicleId}`).setLabel('Set Active').setEmoji('🚗').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`vehicleaction:race:${ownerId}:${vehicleId}`).setLabel('Set Race Car').setEmoji('🏁').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vehicleaction:sell:${ownerId}:${vehicleId}`).setLabel('Sell').setEmoji('💰').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vlmenu:garage').setLabel('Garage').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vlmenu:dealership').setLabel('Dealership').setEmoji('🚗').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vlmenu:main').setLabel('Main Menu').setEmoji('📋').setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function garageDashboard(guildId, userId, page = 0) {
  const p = await profile(guildId, userId);
  const owned = await vehiclesOf(guildId, userId);
  if (!owned.length) {
    return { embeds: [new EmbedBuilder().setTitle('🏠 YOUR GARAGE').setDescription('Your garage is empty.').setColor(0x168cff)], files: [], components: mainMenuRows() };
  }
  const maxPage = owned.length - 1;
  const safePage = Math.max(0, Math.min(Number(page) || 0, maxPage));
  const row = owned[safePage];
  const v = V[row.vehicle_id - 1];
  if (!v) return garageDashboard(guildId, userId, Math.min(safePage + 1, maxPage));
  const active = Number(p.active_vehicle_id) === Number(v.id);
  const race = Number(p.race_vehicle_id) === Number(v.id);
  const e = new EmbedBuilder()
    .setTitle(`🏠 ${userId === String(userId) ? 'YOUR' : ''} GARAGE • ${safePage + 1}/${owned.length}`)
    .setDescription(`${v.emoji} **${v.name}**

Vehicle **#${v.id}** • ${v.class} Class • ⚡ ${v.performance}
Condition: **${row.condition}%** • Level: **${row.level || 1}**

${active ? '🚗 **ACTIVE VEHICLE**' : '🚗 Not active'}
${race ? '🏁 **RACE CAR**' : '🏁 Not race car'}`)
    .setColor(0x168cff)
    .setImage(`attachment://${imageName(v)}`);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`garagepage:prev:${userId}:${safePage}`).setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`garagepage:next:${userId}:${safePage}`).setLabel('Next Vehicle').setEmoji('➡️').setStyle(ButtonStyle.Primary).setDisabled(safePage >= maxPage)
  );
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vehicleaction:active:${userId}:${v.id}`).setLabel(active ? 'Active ✓' : 'Set Active').setEmoji('🚗').setStyle(ButtonStyle.Primary).setDisabled(active),
    new ButtonBuilder().setCustomId(`vehicleaction:race:${userId}:${v.id}`).setLabel(race ? 'Race Car ✓' : 'Set Race Car').setEmoji('🏁').setStyle(ButtonStyle.Success).setDisabled(race),
    new ButtonBuilder().setCustomId(`vehicleaction:sell:${userId}:${v.id}`).setLabel('Sell').setEmoji('💰').setStyle(ButtonStyle.Danger)
  );
  const menu = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vlmenu:main').setLabel('Main Menu').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vlmenu:dealership').setLabel('Dealership').setEmoji('🚗').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [e], files: [{ attachment: vehicleImage(v), name: imageName(v) }], components: [nav, actions, menu] };
}

async function handle(message) {
  const content = message.content.trim();
  const parts = content.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  if (!cmd.startsWith('?')) return false;
  const args = parts.slice(1);
  const gid = message.guild.id;
  const uid = message.author.id;

  try {
    await ensureDailyMissions(gid, uid);

    if (cmd === '?menu') {
      const p = await profile(gid, uid);
      return message.reply({
        embeds: [new EmbedBuilder().setTitle('🚗 VEHICLE LIFE • MAIN MENU').setDescription(`Welcome **${message.member.displayName}**!\n\nUse the buttons below to manage your garage, race, rewards, marketplace and events.\n\n💰 Balance: **${money(p.balance)}** • 🧑‍✈️ Level: **${p.driver_level}**`).setColor(0x168cff).setFooter({ text: 'Vehicle Life • Button-based control center' })],
        components: mainMenuRows()
      });
    }
    if (cmd === '?balance') {
      const p = await profile(gid, uid);
      return message.reply(`💰 **Vehicle Life Balance**\n${money(p.balance)}\n🧑‍✈️ Level **${p.driver_level}** • ${p.driver_xp} XP`);
    }
    if (cmd === '?daily') {
      const p = await profile(gid, uid);
      const today = todayKey();
      if (p.daily_claimed_on === today) return message.reply('⏳ You already claimed today’s reward.');
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayKey = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.PROGRESSION_TIMEZONE || 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).format(yesterday);
      const streak = p.daily_claimed_on === yesterdayKey ? Number(p.daily_streak || 0) + 1 : 1;
      const reward = 10000 + Math.min(streak, 30) * 1000;
      const u = await sb.from('game_profiles').update({ daily_claimed_on: today, daily_streak: streak }).eq('guild_id', gid).eq('user_id', uid);
      if (u.error) throw u.error;
      await changeBalance(gid, uid, reward, 'daily_reward', today);
      await addDriverXp(gid, uid, 50);
      return message.reply(`🎁 **Daily Reward**\n💰 ${money(reward)}\n🔥 Streak: **${streak}**\n🧑‍✈️ +50 XP`);
    }
    if (cmd === '?pay') {
      const target = message.mentions.users.first();
      const amount = Number(args.find(x => /^\d+$/.test(x)));
      if (!target || target.id === uid || !Number.isSafeInteger(amount) || amount <= 0) return message.reply('❌ Use `?pay @user <amount>`.');
      await changeBalance(gid, uid, -amount, 'payment_sent', target.id, {}, false);
      await changeBalance(gid, target.id, amount, 'payment_received', uid, {}, true);
      return message.reply(`💸 Sent **${money(amount)}** to ${target}.`);
    }
    if (cmd === '?dealership') {
      const d = dealershipPage(Number(args[0]) || 0);
      return message.reply({ embeds: [d.embed], components: d.rows });
    }
    if (cmd === '?buy') return message.reply(await buy(message.guild, message.member, args.join(' ')));
    if (cmd === '?garage') {
      const p = await profile(gid, uid);
      const owned = await vehiclesOf(gid, uid);
      const best = [...owned].map(o => V[o.vehicle_id - 1]).filter(Boolean).sort((a, b) => classRank(b.class) - classRank(a.class) || b.performance - a.performance)[0];
      const e = profileEmbed(message.member, p, owned, best).setTitle(`🏠 ${message.member.displayName}'S GARAGE`);
      const first = owned[0] ? V[owned[0].vehicle_id - 1] : null;
      if (first) e.setImage(`attachment://${imageName(first)}`);
      return message.reply({ embeds: [e], files: first ? [{ attachment: vehicleImage(first), name: imageName(first) }] : [], components: first ? vehicleActionRows(first.id, uid) : mainMenuRows() });
    }
    if (cmd === '?profile') {
      const target = message.mentions.members.first() || message.member;
      const p = await profile(gid, target.id);
      const owned = await vehiclesOf(gid, target.id);
      const best = [...owned].map(o => V[o.vehicle_id - 1]).filter(Boolean).sort((a, b) => classRank(b.class) - classRank(a.class) || b.performance - a.performance)[0];
      const e = profileEmbed(target, p, owned, best);
      return message.reply({ embeds: [e], components: target.id === uid ? mainMenuRows() : [] });
    }
    if (cmd === '?topgarages') {
      const rows = await topGarages(gid, 10);
      if (!rows.length) return message.reply('🏆 **TOP GARAGES**\nNo garages yet.');
      const desc = rows.map((x, i) => {
        const best = x.best ? `${x.best.emoji} ${x.best.name}` : 'No vehicle';
        return `**#${i + 1} • ${best}**\n<@${x.user_id}> • **${x.owned.length}/${V.length} vehicles** • 🏁 ${x.driver_level} Lv • 💰 ${money(x.balance)}`;
      }).join('\n\n');
      return message.reply({ embeds: [new EmbedBuilder().setTitle('🏆 TOP GARAGES').setDescription(desc)] });
    }
    if (cmd === '?vehicle') {
      const v = findVehicle(args.join(' '));
      if (!v) return message.reply('❌ Vehicle not found.');
      const o = await own(gid, uid, v);
      const s = vehicleStats(v, o);
      const e = new EmbedBuilder().setTitle(`${v.emoji} ${v.name}`).setDescription(`#${v.id} • ${v.rarity} • Class ${v.class}\n💰 ${money(v.price)} • ⚡ ${v.performance}\n\n⚡ Power ${s.power}\n🏎️ Top Speed ${s.speed} km/h\n🚀 Acceleration ${s.accel}\n🎯 Handling ${s.handling}\n🛑 Braking ${s.braking}\n⚖️ Weight ${s.weight} kg\n🟢 Launch ${s.launch}`).addFields({ name: 'Ownership', value: o ? `Level ${o.level} • XP ${o.xp} • Condition ${o.condition}%` : 'Not owned' });
      return message.reply({ embeds: [e], files: [{ attachment: vehicleImage(v), name: imageName(v) }] });
    }
    if (cmd === '?setactive') {
      const v = findVehicle(args.join(' '));
      if (!v || !(await own(gid, uid, v))) return message.reply('❌ You must own that vehicle.');
      await sb.from('game_profiles').update({ active_vehicle_id: v.id }).eq('guild_id', gid).eq('user_id', uid);
      return message.reply(`🚗 **${v.name}** is now your active vehicle.`);
    }
    if (cmd === '?setasracecar') {
      const v = findVehicle(args.join(' '));
      if (!v || !(await own(gid, uid, v))) return message.reply('❌ You must own that vehicle first.');
      const r = await sb.from('game_profiles').update({ race_vehicle_id: v.id }).eq('guild_id', gid).eq('user_id', uid);
      if (r.error) throw r.error;
      return message.reply(`🏁 **Race vehicle set:** ${v.emoji} **${v.name}** (#${v.id})`);
    }
    if (cmd === '?racecar') {
      const p = await profile(gid, uid);
      const v = p.race_vehicle_id ? V[p.race_vehicle_id - 1] : null;
      const o = v ? await own(gid, uid, v) : null;
      return message.reply(v && o ? `🏁 **YOUR RACE CAR**\n${v.emoji} **${v.name}** • Class ${v.class} • ⚡ ${v.performance}\nCondition: **${o.condition}%**` : '🏁 No race vehicle selected. Use `?setasracecar <vehicle>`.' );
    }
    if (['?race', '?drag', '?trackrace', '?timetrial'].includes(cmd)) {
      const target = message.mentions.members.first();
      const type = cmd === '?drag' ? 'drag' : cmd === '?trackrace' ? 'track' : cmd === '?timetrial' ? 'time' : 'race';
      if (!target) return message.reply(`🏁 Every race is PvP. Use \`${cmd} @user\`.`);
      if (target.id === uid) return message.reply('❌ You cannot race yourself.');
      if (target.user.bot) return message.reply('❌ You cannot challenge a bot.');
      const me = await profile(gid, uid);
      if (!me.race_vehicle_id || !(await own(gid, uid, V[Number(me.race_vehicle_id) - 1]))) return message.reply('❌ Select a valid race vehicle first with `?setasracecar <vehicle ID>`.');
      const opponent = await profile(gid, target.id);
      if (!opponent.race_vehicle_id || !(await own(gid, target.id, V[Number(opponent.race_vehicle_id) - 1]))) return message.reply(`❌ ${target} has not selected a valid race vehicle.`);
      const id = `${gid}:${uid}:${target.id}:${Date.now()}`;
      pendingRaces.set(id, { guildId: gid, from: uid, to: target.id, type, expires: Date.now() + 120000 });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raceaccept:${id}`).setLabel('Accept Race').setEmoji('🏁').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`racedecline:${id}`).setLabel('Decline').setEmoji('✖️').setStyle(ButtonStyle.Danger)
      );
      try {
        await target.send({ content: `🏁 **RACE CHALLENGE**\n${message.member} challenged you to a **${type.toUpperCase()}** race.\nYou have **2 minutes** to respond.`, components: [row] });
        return message.reply(`🏁 ${target}, challenge sent privately. **Only you can see the Accept/Decline buttons.**`);
      } catch {
        pendingRaces.delete(id);
        return message.reply(`❌ I couldn't DM ${target}. They must enable DMs to accept the race challenge.`);
      }
    }
    if (cmd === '?racehistory') {
      const r = await sb.from('races').select('*').eq('guild_id', gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`).order('created_at', { ascending: false }).limit(10);
      if (r.error) throw r.error;
      if (!r.data?.length) return message.reply('🏁 No race history yet.');
      return message.reply(r.data.map(x => `🏁 **${String(x.type).toUpperCase()}** • ${x.winner === uid ? '🏆 WIN' : '❌ LOSS'} • ${new Date(x.created_at).toLocaleDateString('en-IN')}`).join('\n'));
    }
    if (cmd === '?racestats') {
      const r = await sb.from('races').select('winner,status').eq('guild_id', gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`);
      if (r.error) throw r.error;
      const rows = (r.data || []).filter(x => x.status === 'finished');
      const wins = rows.filter(x => x.winner === uid).length;
      return message.reply(`🏁 **RACE STATS**\nRaces: **${rows.length}**\nWins: **${wins}**\nLosses: **${rows.length - wins}**\nWin rate: **${rows.length ? Math.round(wins / rows.length * 100) : 0}%**`);
    }
    if (cmd === '?sell') {
      const v = findVehicleExact(args.join(' '));
      if (!v) return message.reply('❌ Use the exact vehicle name or vehicle ID. Example: `?sell Honda Activa` or `?sell 2`.');
      const o = await own(gid, uid, v);
      if (!o) return message.reply('❌ You do not own that exact vehicle.');
      const p = await profile(gid, uid);
      // Remove stale selections that point to vehicles the player no longer owns.
      const patch = {};
      if (p.active_vehicle_id && !(await own(gid, uid, V[Number(p.active_vehicle_id) - 1]))) patch.active_vehicle_id = null;
      if (p.race_vehicle_id && !(await own(gid, uid, V[Number(p.race_vehicle_id) - 1]))) patch.race_vehicle_id = null;
      if (Object.keys(patch).length) {
        await sb.from('game_profiles').update({ ...patch, updated_at: new Date().toISOString() }).eq('guild_id', gid).eq('user_id', uid);
        if (patch.active_vehicle_id === null) p.active_vehicle_id = null;
        if (patch.race_vehicle_id === null) p.race_vehicle_id = null;
      }
      const selectionPatch = {};
      if (Number(p.active_vehicle_id) === Number(v.id)) selectionPatch.active_vehicle_id = null;
      if (Number(p.race_vehicle_id) === Number(v.id)) selectionPatch.race_vehicle_id = null;
      if (Object.keys(selectionPatch).length) {
        const cleared = await sb.from('game_profiles').update({ ...selectionPatch, updated_at: new Date().toISOString() }).eq('guild_id', gid).eq('user_id', uid);
        if (cleared.error) throw cleared.error;
        p.active_vehicle_id = selectionPatch.active_vehicle_id === null ? null : p.active_vehicle_id;
        p.race_vehicle_id = selectionPatch.race_vehicle_id === null ? null : p.race_vehicle_id;
      }
      const value = Math.floor(v.price * 0.55);
      const id = `${gid}:${uid}:${v.id}:${Date.now()}`;
      pendingSales.set(id, { guildId: gid, userId: uid, vehicleId: v.id, value, expires: Date.now() + 60000 });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sellconfirm:${id}`).setLabel(`Confirm • ${money(value)}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sellcancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      try {
        await message.author.send({ content: `⚠️ **SELL CONFIRMATION**\nSell **${v.name}** for **${money(value)}**?\nOnly you can use these buttons.`, components: [row] });
        return message.reply('📩 I sent the sell confirmation buttons to your DM.');
      } catch {
        return message.reply('❌ I could not DM you. Enable DMs from server members to confirm the sale.');
      }
    }
    if (cmd === '?customize' || cmd === '?paint') {
      const components = ['paint','wheels','tires','spoiler','bumpers','hood','exhaust','neon','headlights','taillights','windows'];
      let v, component, value;
      if (cmd === '?paint') {
        v = findVehicle(args.slice(0, -1).join(' '));
        component = 'paint';
        value = args.at(-1);
      } else if (content.includes('|')) {
        const pieces = content.replace(/^\?customize\s*/i, '').split('|').map(x => x.trim());
        v = findVehicle(pieces[0]);
        component = String(pieces[1] || '').toLowerCase();
        value = pieces.slice(2).join(' ').trim();
      } else {
        component = String(args.at(-2) || '').toLowerCase();
        value = args.at(-1);
        v = findVehicle(args.slice(0, -2).join(' '));
      }
      const o = v && await own(gid, uid, v);
      if (!v || !o || !components.includes(component) || !value) return message.reply('❌ Use `?paint <vehicle> <value>` or `?customize <vehicle> <component> <value>`. Components: paint, wheels, tires, spoiler, bumpers, hood, exhaust, neon, headlights, taillights, windows.');
      const cost = component === 'paint' ? 5000 : 7500;
      await changeBalance(gid, uid, -cost, 'customization', `${v.id}:${component}`, { component, value }, false);
      const custom = { ...safeJson(o.custom), [component]: value.slice(0, 40) };
      const r = await sb.from('user_vehicles').update({ custom, updated_at: new Date().toISOString() }).eq('id', o.id).eq('guild_id', gid).eq('user_id', uid);
      if (r.error) {
        await changeBalance(gid, uid, cost, 'customization_refund', `${v.id}:${component}`, { component, value }, false).catch(() => {});
        throw r.error;
      }
      return message.reply(`🎨 **${v.name}** ${component} set to **${value}** for **${money(cost)}**.`);
    }
    if (cmd === '?upgrade') {
      const type = String(args[0] || '').toLowerCase();
      const v = findVehicle(args.slice(1).join(' '));
      if (!UPGRADES[type] || !v) return message.reply(`❌ Use \`?upgrade <type> <vehicle>\`. Types: ${UPGRADE_TYPES.join(', ')}`);
      const o = await own(gid, uid, v);
      if (!o) return message.reply('❌ You do not own that vehicle.');
      const upgrades = { ...safeJson(o.upgrades) };
      const level = Number(upgrades[type] || 0);
      if (level >= 10) return message.reply('❌ That upgrade is already level 10.');
      const cost = 15000 * (level + 1);
      await changeBalance(gid, uid, -cost, 'upgrade', `${v.id}:${type}`, { type, level: level + 1 }, false);
      upgrades[type] = level + 1;
      const r = await sb.from('user_vehicles').update({ upgrades, updated_at: new Date().toISOString() }).eq('id', o.id).eq('guild_id', gid).eq('user_id', uid);
      if (r.error) {
        await changeBalance(gid, uid, cost, 'upgrade_refund', `${v.id}:${type}`, { type, level: level + 1 }, false).catch(() => {});
        throw r.error;
      }
      await addDriverXp(gid, uid, 75);
      await updateMission(gid, uid, 'upgrade', 1);
      return message.reply(`🔧 **${v.name}** ${UPGRADES[type].label} → **Lv.${level + 1}** for **${money(cost)}**.`);
    }
    if (cmd === '?repair') {
      const v = findVehicle(args.join(' '));
      const o = v && await own(gid, uid, v);
      if (!v || !o) return message.reply('❌ Own the vehicle first.');
      if (o.condition >= 100) return message.reply('✅ Vehicle is already at 100% condition.');
      const cost = Math.max(1000, Math.floor((100 - o.condition) * v.price * 0.002));
      await changeBalance(gid, uid, -cost, 'repair', v.id, {}, false);
      const r = await sb.from('user_vehicles').update({ condition: 100 }).eq('id', o.id);
      if (r.error) throw r.error;
      return message.reply(`🛠️ Repaired **${v.name}** to **100%** for **${money(cost)}**.`);
    }
    if (cmd === '?missions') {
      const r = await sb.from('missions').select('*').eq('guild_id', gid).eq('user_id', uid).eq('period_key', todayKey()).order('id');
      if (r.error) throw r.error;
      return message.reply((r.data || []).map(m => `${m.completed ? '✅' : '⬜'} **${m.mission_key}** • ${m.progress}/${m.target} • ${money(m.reward)}`).join('\n') || 'No missions.');
    }
    if (cmd === '?achievements') {
      const r = await sb.from('achievements').select('achievement_key').eq('guild_id', gid).eq('user_id', uid);
      if (r.error) throw r.error;
      const unlocked = new Set((r.data || []).map(x => x.achievement_key));
      return message.reply(Object.entries(ACHIEVEMENTS).map(([k, v]) => `${unlocked.has(k) ? '🏆' : '🔒'} **${v[0]}** — ${v[1]}`).join('\n'));
    }
    if (cmd === '?market') {
      const r = await sb.from('marketplace').select('*').eq('guild_id', gid).eq('status', 'active').order('created_at', { ascending: false }).limit(15);
      if (r.error) throw r.error;
      return message.reply(r.data?.length ? r.data.map(x => `🛒 **#${x.id}** • ${V[x.vehicle_id - 1]?.name || 'Unknown'} • **${money(x.price)}** • Seller <@${x.seller_id}>`).join('\n') : '🛒 Marketplace is empty.');
    }
    if (cmd === '?list') {
      const price = Number(args.at(-1));
      const v = findVehicle(args.slice(0, -1).join(' '));
      const o = v && await own(gid, uid, v);
      if (!v || !o || !Number.isSafeInteger(price) || price <= 0) return message.reply('❌ Use `?list <vehicle> <price>`.');
      const p = await profile(gid, uid);
      if (p.active_vehicle_id === v.id || p.race_vehicle_id === v.id) return message.reply('❌ Set another active/race vehicle before listing this one.');
      const listing = await listMarketplace(gid, uid, v.id, price);
      const del = await sb.from('user_vehicles').delete().eq('id', o.id);
      if (del.error) {
        await sb.from('marketplace').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', listing.id).catch(() => {});
        throw del.error;
      }
      return message.reply(`🛒 Listed **${v.name}** for **${money(price)}**. Listing ID: **${listing.id}**.`);
    }
    if (cmd === '?marketbuy') {
      const id = Number(args[0]);
      if (!Number.isInteger(id)) return message.reply('❌ Use `?marketbuy <listing ID>`.');
      const r = await sb.rpc('purchase_market_listing', { p_listing_id: id, p_buyer_id: uid });
      if (r.error) {
        const code = String(r.error.message || '');
        if (code.includes('LISTING_NOT_FOUND')) return message.reply('❌ Listing not found or already sold.');
        if (code.includes('INSUFFICIENT_FUNDS')) return message.reply('❌ Insufficient funds.');
        if (code.includes('ALREADY_OWNED')) return message.reply('❌ You already own this vehicle.');
        throw r.error;
      }
      const vehicleId = Number(r.data?.vehicle_id);
      const v = V[vehicleId - 1];
      return message.reply(`✅ Bought **${v?.name || `Vehicle #${vehicleId}`}** for **${money(r.data?.price || 0)}**.`);
    }
    if (cmd === '?marketcancel') {
      const listingId = Number(args[0]);
      if (!Number.isInteger(listingId) || listingId <= 0) {
        return message.reply('❌ Use `?marketcancel <listing ID>`.');
      }

      // Only the original seller can cancel an active listing.
      const listingR = await sb.from('marketplace')
        .select('*')
        .eq('id', listingId)
        .eq('guild_id', gid)
        .eq('seller_id', uid)
        .eq('status', 'active')
        .maybeSingle();
      if (listingR.error) throw listingR.error;
      const listing = listingR.data;
      if (!listing) return message.reply('❌ Listing not found, already sold, or already cancelled.');

      const vehicleId = Number(listing.vehicle_id);
      const v = V[vehicleId - 1];
      if (!v) return message.reply('❌ This listing references an invalid vehicle. Contact an administrator.');

      // Prevent duplicate ownership if the vehicle was restored by an earlier attempt.
      const existing = await own(gid, uid, v);
      if (existing) {
        const cancelled = await sb.from('marketplace')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', listingId)
          .eq('guild_id', gid)
          .eq('seller_id', uid)
          .eq('status', 'active')
          .select('id')
          .maybeSingle();
        if (cancelled.error) throw cancelled.error;
        if (!cancelled.data) return message.reply('❌ Listing was already processed.');
        return message.reply(`↩️ Cancelled listing **#${listingId}**. **${v.name}** was already in your garage.`);
      }

      const restored = await sb.from('user_vehicles').insert({
        guild_id: gid,
        user_id: uid,
        vehicle_id: vehicleId,
        level: 1,
        xp: 0,
        condition: 100,
        upgrades: {},
        custom: {}
      }).select().single();
      if (restored.error) {
        if (String(restored.error.message || '').toLowerCase().includes('duplicate')) {
          return message.reply('❌ This vehicle is already in your garage.');
        }
        throw restored.error;
      }

      const cancelled = await sb.from('marketplace')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', listingId)
        .eq('guild_id', gid)
        .eq('seller_id', uid)
        .eq('status', 'active')
        .select('id')
        .maybeSingle();
      if (cancelled.error || !cancelled.data) {
        // Best-effort rollback so a failed cancellation does not leave a duplicate/ghost vehicle.
        await sb.from('user_vehicles').delete().eq('id', restored.data.id).eq('guild_id', gid).eq('user_id', uid).eq('vehicle_id', vehicleId).catch(() => {});
        if (cancelled.error) throw cancelled.error;
        return message.reply('❌ This listing was already processed.');
      }

      return message.reply(`↩️ Cancelled listing **#${listingId}**. **${v.name}** has been returned to your garage.`);
    }
    if (cmd === '?bets') {
      return message.reply('💵 Use `?betrace <amount> @user` to challenge another player to a race for money.');
    }
    if (cmd === '?betrace') {
      const amount = Number(args[0]);
      const target = message.mentions.members.first();
      if (!target || target.id === uid || !Number.isSafeInteger(amount) || amount <= 0) return message.reply('❌ Use `?betrace <amount> @user`.');
      const p = await profile(gid, uid), q = await profile(gid, target.id);
      if (p.balance < amount || q.balance < amount) return message.reply('❌ Both players need enough balance for the stake.');
      const id = `${gid}:${uid}:${target.id}:${Date.now()}`;
      pendingBets.set(id, { guildId: gid, from: uid, to: target.id, amount, expires: Date.now() + 120000 });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`betaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`betdecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger));
      try {
        await target.send({ content: `💵 **BET RACE CHALLENGE**\n${message.member} challenged you to a **${money(amount)}** bet race.\nOnly you can see these buttons.`, components: [row] });
        return message.reply(`💵 ${target}, bet challenge sent privately.`);
      } catch {
        pendingBets.delete(id);
        return message.reply(`❌ I couldn't DM ${target}. They must enable DMs to accept the bet race.`);
      }
    }
    if (cmd === '?trade') {
      const target = message.mentions.members.first();
      if (!target || target.id === uid) return message.reply('❌ Use `?trade @user`.');
      const id = `${gid}:${uid}:${target.id}:${Date.now()}`;
      const expires = new Date(Date.now() + 120000).toISOString();
      const dbTrade = await sb.from('trades').insert({ guild_id: gid, from_user_id: uid, to_user_id: target.id, status: 'pending', expires_at: expires }).select().single();
      if (dbTrade.error) throw dbTrade.error;
      pendingTrades.set(id, { guildId: gid, from: uid, to: target.id, expires: Date.now() + 120000, accepted: false, tradeDbId: dbTrade.data.id });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tradeaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`tradedecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger));
      try {
        await target.send({ content: `🤝 **TRADE REQUEST**\n${message.member} wants to trade one vehicle with you.\nOnly you can see these buttons.`, components: [row] });
        return message.reply(`🤝 ${target}, trade request sent privately.`);
      } catch {
        pendingTrades.delete(id);
        await sb.from('trades').update({ status: 'cancelled' }).eq('id', dbTrade.data.id).catch(() => {});
        return message.reply(`❌ I couldn't DM ${target}. They must enable DMs to accept the trade.`);
      }
    }
    if (cmd === '?tradeoffer') {
      const target = message.mentions.members.first();
      const raw = content.replace(/^\?tradeoffer\s*/i, '').replace(/<@!?\d+>/, '').trim();
      const pieces = raw.split('|').map(x => x.trim()).filter(Boolean);
      const mine = findVehicle(pieces[0]);
      const theirs = findVehicle(pieces[1]);
      if (!target || !mine || !theirs) return message.reply('❌ Use `?tradeoffer @user <your vehicle> | <their vehicle>`.');
      const entry = [...pendingTrades.entries()].find(([, t]) => t.guildId === gid && t.accepted && t.from === uid && t.to === target.id && Date.now() <= t.expires);
      if (!entry) return message.reply('❌ No accepted trade session found. Start with `?trade @user`.');
      const [id, t] = entry;
      const myOwn = await own(gid, uid, mine), theirOwn = await own(gid, target.id, theirs);
      if (!myOwn || !theirOwn) return message.reply('❌ Both players must own the vehicles being offered.');
      const p = await profile(gid, uid), q = await profile(gid, target.id);
      if (p.active_vehicle_id === mine.id || p.race_vehicle_id === mine.id || q.active_vehicle_id === theirs.id || q.race_vehicle_id === theirs.id) return message.reply('❌ Neither offered vehicle can be the active or race vehicle.');
      const up = await sb.from('trades').update({ from_vehicle_id: mine.id, to_vehicle_id: theirs.id, status: 'offered' }).eq('id', t.tradeDbId).eq('status', 'pending');
      if (up.error) throw up.error;
      t.offer = { fromVehicle: mine.id, toVehicle: theirs.id };
      pendingTrades.set(id, t);
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tradeconfirm:${id}`).setLabel('Confirm Trade').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`tradedecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger));
      try {
        await target.send({ content: `🤝 **TRADE OFFER**\n<@${uid}> offers: **${mine.name}**\nYou give: **${theirs.name}**\nOnly you can confirm this offer.`, components: [row] });
        return message.reply(`🤝 Trade offer sent privately to ${target}.`);
      } catch {
        return message.reply(`❌ I couldn't DM ${target}. They must enable DMs to confirm the trade.`);
      }
    }
    if (cmd === '?events') {
      await ensureLiveWorld(gid);
      const r = await sb.from('events').select('*').eq('guild_id', gid).eq('status', 'open').order('starts_at');
      if (r.error) throw r.error;
      return message.reply(r.data?.length ? r.data.map(e => `🎉 **#${e.id} ${e.name}**\n💰 Entry: ${money(e.entry_fee)}\n🕒 ${new Date(e.starts_at).toLocaleString('en-IN')} → ${new Date(e.ends_at).toLocaleString('en-IN')}\n${e.description}\nUse \`?eventjoin ${e.id}\``).join('\n\n') : 'No active events.');
    }
    if (cmd === '?eventjoin') {
      const eventId = Number(args[0]);
      const e = await sb.from('events').select('*').eq('id', eventId).eq('guild_id', gid).eq('status', 'open').maybeSingle();
      if (e.error) throw e.error;
      if (!e.data) return message.reply('❌ Event not found or closed.');
      const existing = await sb.from('event_entries').select('id').eq('event_id', eventId).eq('user_id', uid).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return message.reply('⚠️ You are already entered.');
      const fee = Number(e.data.entry_fee || 0);
      if (fee > 0) await changeBalance(gid, uid, -fee, 'event_entry', eventId, {}, false);
      const ins = await sb.from('event_entries').insert({ event_id: eventId, guild_id: gid, user_id: uid, score: 0, joined_at: new Date().toISOString() });
      if (ins.error) {
        if (fee > 0) await changeBalance(gid, uid, fee, 'event_entry_refund', eventId, {}, false).catch(() => {});
        throw ins.error;
      }
      return message.reply(`🎉 You joined **${e.data.name}**! Complete races before it closes.`);
    }
    // Season and Championship are handled by competitive.js so their UI is
    // fully button-based. Keep these here as fall-throughs for compatibility.
    if (cmd === '?season' || cmd === '?championship') return false;
    if (cmd === '?leaderboard') {
      const type = (args[0] || 'richest').toLowerCase();
      if (type === 'garage') {
        const rows = await topGarages(gid, 10);
        return message.reply(rows.map((x, i) => `**#${i + 1}** <@${x.user_id}> • ${x.owned.length}/${V.length} vehicles • ${money(x.balance)}`).join('\n') || 'No garages yet.');
      }
      const r = await sb.from('game_profiles').select('user_id,balance,driver_level,driver_xp').eq('guild_id', gid).order(type === 'xp' ? 'driver_xp' : 'balance', { ascending: false }).limit(10);
      if (r.error) throw r.error;
      return message.reply(r.data?.map((x, i) => `**#${i + 1}** <@${x.user_id}> • ${type === 'xp' ? `${x.driver_xp} XP` : money(x.balance)} • Lv.${x.driver_level}`).join('\n') || 'No players yet.');
    }
    if (cmd === '?commands') return false; // handled by index.js command guide
    if (cmd === '?help') return false;
    if (cmd === '?admin') {
      if (!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.');
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'give' || sub === 'take') {
        const target = message.mentions.users.first();
        const amount = Number(args.find(x => /^\d+$/.test(x)));
        if (!target || !Number.isSafeInteger(amount) || amount <= 0) return message.reply(`❌ Use \`?admin ${sub} @user <amount>\`.`);
        const delta = sub === 'give' ? amount : -amount;
        await changeBalance(gid, target.id, delta, `admin_${sub}`, uid, {}, false);
        return message.reply(`👑 ${sub === 'give' ? 'Added' : 'Removed'} ${money(amount)} ${sub === 'give' ? 'to' : 'from'} ${target}.`);
      }
      if (sub === 'players') {
        const r = await sb.from('game_profiles').select('user_id,balance,driver_level,driver_xp').eq('guild_id', gid).order('updated_at', { ascending: false }).limit(50);
        if (r.error) throw r.error;
        return message.reply(r.data?.map(x => `<@${x.user_id}> • ${money(x.balance)} • Lv.${x.driver_level} • ${x.driver_xp} XP`).join('\n') || 'No registered players.');
      }
      return message.reply('👑 `?admin give @user amount` • `?admin take @user amount` • `?admin players`');
    }
    if (cmd === '?adminreset') {
      const RESET_PASSWORD = config.adminResetPassword;
      if (!RESET_PASSWORD) return message.channel.send('❌ Admin reset is not configured. Set ADMIN_RESET_PASSWORD on the bot server.');
      const supplied = args[0] || '';
      const targetToken = (args[1] || '').toLowerCase();
      const target = message.mentions.users.first();
      await message.delete().catch(() => {});
      if (supplied !== RESET_PASSWORD) return message.channel.send('❌ Invalid admin reset password.');
      if (!message.member.permissions.has('ManageGuild')) return message.channel.send('❌ Manage Server required.');
      const resetUser = async (userId) => {
        await sb.from('marketplace').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('guild_id', gid).eq('seller_id', userId).eq('status', 'active');
        const dv = await sb.from('user_vehicles').delete().eq('guild_id', gid).eq('user_id', userId);
        if (dv.error) throw dv.error;
        const payload = { balance: 0, driver_xp: 0, driver_level: 1, active_vehicle_id: null, race_vehicle_id: null, daily_streak: 0, daily_claimed_on: null, season_xp: 0, updated_at: new Date().toISOString() };
        const up = await sb.from('game_profiles').update(payload).eq('guild_id', gid).eq('user_id', userId).select('user_id');
        if (up.error) throw up.error;
        if (!up.data?.length) {
          const ins = await sb.from('game_profiles').insert({ guild_id: gid, user_id: userId, ...payload });
          if (ins.error) throw ins.error;
        }
        const ul = await sb.from('users').update({ vehicle_index: 0, messages: 0, vc_seconds: 0, last_vc_join: null }).eq('guild_id', gid).eq('user_id', userId);
        if (ul.error) throw ul.error;
        resetUserProgress(userId, gid);
        await sb.from('missions').delete().eq('guild_id', gid).eq('user_id', userId);
        await sb.from('achievements').delete().eq('guild_id', gid).eq('user_id', userId);
        await sb.from('event_entries').delete().eq('guild_id', gid).eq('user_id', userId);
      };
      if (targetToken === 'everyone') {
        const ids = [];
        const a = await sb.from('users').select('user_id').eq('guild_id', gid);
        if (a.error) throw a.error;
        ids.push(...(a.data || []).map(x => x.user_id));
        const b = await sb.from('game_profiles').select('user_id').eq('guild_id', gid);
        if (b.error) throw b.error;
        ids.push(...(b.data || []).map(x => x.user_id));
        const unique = [...new Set(ids)];
        for (const id of unique) await resetUser(id);
        return message.channel.send(`🧹 **Full reset complete.** Reset **${unique.length}** player(s): balance **₹0**, vehicles **0**, VC **0**, messages **0**, driver XP **0**, level **1**.`);
      }
      if (!target) return message.channel.send('❌ Use the admin reset command with a mentioned user or `everyone`.');
      await resetUser(target.id);
      return message.channel.send(`🧹 **Reset complete for ${target}.** Balance **₹0** • Vehicles **0** • VC **0** • Messages **0** • Driver XP **0** • Level **1**.`);
    }
    return false;
  } catch (e) {
    console.error('Vehicle Life game error:', e);
    const msg = e.message === 'INSUFFICIENT_FUNDS' ? '❌ Insufficient funds.' : e.message === 'ALREADY_LISTED' ? '❌ That vehicle is already listed.' : `❌ Game system error: ${e.message}`;
    await message.reply(msg).catch(() => {});
    return true;
  }
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  try {
    const id = String(interaction.customId || '');

    if (id.startsWith('vlmenu:')) {
      const action = id.split(':')[1];
      await interaction.deferUpdate();
      const gid = interaction.guild.id, uid = interaction.user.id;
      if (action === 'main') {
        const p = await profile(gid, uid);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🚗 VEHICLE LIFE • MAIN MENU').setDescription(`Welcome **${interaction.member.displayName}**!\n\nUse the buttons below to manage your garage, race, rewards, marketplace and events.\n\n💰 Balance: **${money(p.balance)}** • 🧑‍✈️ Level: **${p.driver_level}**`).setColor(0x168cff)], components: mainMenuRows() });
      }
      if (action === 'profile') {
        const p = await profile(gid, uid); const owned = await vehiclesOf(gid, uid); const best = [...owned].map(o => V[o.vehicle_id - 1]).filter(Boolean).sort((a,b) => classRank(b.class)-classRank(a.class)||b.performance-a.performance)[0];
        return interaction.editReply({ embeds: [profileEmbed(interaction.member, p, owned, best)], components: mainMenuRows() });
      }
      if (action === 'balance') {
        const p = await profile(gid, uid);
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('💰 VEHICLE LIFE BALANCE').setDescription(`Balance: **${money(p.balance)}**\n🧑‍✈️ Driver Level: **${p.driver_level}**\n⭐ XP: **${p.driver_xp}**\n🔥 Daily Streak: **${p.daily_streak || 0}**`).setColor(0x168cff)], components: mainMenuRows() });
      }
      if (action === 'daily') {
        const p = await profile(gid, uid); const today = todayKey();
        if (p.daily_claimed_on === today) return interaction.editReply({ content: '⏳ You already claimed today’s reward.', embeds: [], components: mainMenuRows() });
        const yesterday = new Date(Date.now() - 86400000);
        const ykey = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.PROGRESSION_TIMEZONE || 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).format(yesterday);
        const streak = p.daily_claimed_on === ykey ? Number(p.daily_streak || 0) + 1 : 1;
        const reward = 10000 + Math.min(streak, 30) * 1000;
        const u = await sb.from('game_profiles').update({ daily_claimed_on: today, daily_streak: streak }).eq('guild_id', gid).eq('user_id', uid); if (u.error) throw u.error;
        await changeBalance(gid, uid, reward, 'daily_reward', today); await addDriverXp(gid, uid, 50);
        return interaction.editReply({ content: `🎁 **Daily Reward Claimed!**\n💰 ${money(reward)}\n🔥 Streak: **${streak}**\n🧑‍✈️ +50 XP`, embeds: [], components: mainMenuRows() });
      }
      if (action === 'dealership') {
        const d = dealershipPage(0);
        return interaction.editReply({ content: '', embeds: [d.embed], components: d.rows });
      }
      if (action === 'garage') {
        const d = await garageDashboard(gid, uid, 0);
        return interaction.editReply(d);
      }
      if (action === 'missions') {
        const r = await sb.from('missions').select('*').eq('guild_id', gid).eq('user_id', uid).eq('period_key', todayKey()).order('id'); if (r.error) throw r.error;
        return interaction.editReply({ content: (r.data || []).map(m => `${m.completed ? '✅' : '⬜'} **${m.mission_key}** • ${m.progress}/${m.target} • ${money(m.reward)}`).join('\n') || 'No missions.', embeds: [], components: mainMenuRows() });
      }
      if (action === 'achievements') {
        const r = await sb.from('achievements').select('achievement_key').eq('guild_id', gid).eq('user_id', uid); if (r.error) throw r.error;
        const unlocked = new Set((r.data || []).map(x => x.achievement_key));
        return interaction.editReply({ content: Object.entries(ACHIEVEMENTS).map(([k,v]) => `${unlocked.has(k) ? '🏆' : '🔒'} **${v[0]}** — ${v[1]}`).join('\n'), embeds: [], components: mainMenuRows() });
      }
      if (action === 'market') {
        const r = await sb.from('marketplace').select('*').eq('guild_id', gid).eq('status','active').order('created_at',{ascending:false}).limit(15); if (r.error) throw r.error;
        return interaction.editReply({ content: r.data?.length ? r.data.map(x => `🛒 **#${x.id}** • ${V[x.vehicle_id-1]?.name || 'Unknown'} • **${money(x.price)}** • Seller <@${x.seller_id}>`).join('\n') : '🛒 Marketplace is empty.', embeds: [], components: mainMenuRows() });
      }
      if (action === 'events') {
        await ensureLiveWorld(gid);
        const r = await sb.from('events').select('*').eq('guild_id',gid).eq('status','open').order('starts_at'); if (r.error) throw r.error;
        return interaction.editReply({ content: r.data?.length ? r.data.map(e => `🎉 **#${e.id} ${e.name}** • 🕒 ${new Date(e.starts_at).toLocaleString('en-IN')} → ${new Date(e.ends_at).toLocaleString('en-IN')}\n💰 Entry: ${money(e.entry_fee)}\n${e.description}`).join('\n\n') : 'No active events.', embeds: [], components: mainMenuRows() });
      }
      if (action === 'race') {
        return interaction.editReply({ content: '🏁 **Racing**\nUse the challenge command `?race @user`, then the challenged player receives the Accept/Decline buttons privately.\n\nYou can also use `?betrace <amount> @user` for a money race.', embeds: [], components: mainMenuRows() });
      }
    }

    if (id.startsWith('garagepage:')) {
      const [, direction, ownerId, pageText] = id.split(':');
      if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ Only the garage owner can use these buttons.', ephemeral: true });
      await interaction.deferUpdate();
      const gid = interaction.guild?.id;
      if (!gid) return interaction.editReply({ content: '❌ Garage navigation must be used inside the server.', embeds: [], components: [] });
      const current = Number(pageText) || 0;
      const next = direction === 'next' ? current + 1 : current - 1;
      return interaction.editReply(await garageDashboard(gid, ownerId, next));
    }

    if (id.startsWith('vehicleaction:')) {
      const [, action, ownerId, vehicleIdText] = id.split(':');
      if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ Only the garage owner can use these buttons.', ephemeral: true });
      await interaction.deferUpdate();
      const gid = interaction.guild.id, uid = interaction.user.id, vehicleId = Number(vehicleIdText), v = V[vehicleId - 1];
      if (!v) return interaction.editReply({ content: '❌ Vehicle unavailable.', embeds: [], components: [] });
      const o = await own(gid, uid, v);
      if (!o) return interaction.editReply({ content: '❌ You no longer own this vehicle.', embeds: [], components: [] });
      if (action === 'active') {
        const r = await sb.from('game_profiles').update({ active_vehicle_id: vehicleId, updated_at: new Date().toISOString() }).eq('guild_id',gid).eq('user_id',uid); if (r.error) throw r.error;
        return interaction.editReply(await garageDashboard(gid, uid, 0));
      }
      if (action === 'race') {
        const r = await sb.from('game_profiles').update({ race_vehicle_id: vehicleId, updated_at: new Date().toISOString() }).eq('guild_id',gid).eq('user_id',uid); if (r.error) throw r.error;
        return interaction.editReply(await garageDashboard(gid, uid, 0));
      }
      if (action === 'sell') {
        const value = Math.floor(v.price * 0.55), saleId = `${gid}:${uid}:${v.id}:${Date.now()}`;
        pendingSales.set(saleId, { guildId: gid, userId: uid, vehicleId: v.id, value, expires: Date.now() + 60000 });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`sellconfirm:${saleId}`).setLabel(`Confirm • ${money(value)}`).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`sellcancel:${saleId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        try { await interaction.user.send({ content: `⚠️ **SELL CONFIRMATION**\nSell **${v.name}** for **${money(value)}**?\nOnly you can use these buttons.`, components: [row] });
        } catch { pendingSales.delete(saleId); return interaction.editReply({ content: '❌ I could not DM you. Enable DMs from server members.', embeds: [], components: vehicleActionRows(vehicleId, uid) }); }
        return interaction.editReply({ content: '📩 Sell confirmation sent to your DM. The confirmation buttons are private to you.', embeds: [], components: vehicleActionRows(vehicleId, uid) });
      }
    }

    if (interaction.customId.startsWith('dealer:')) {
      const [, dir, currentText] = interaction.customId.split(':');
      const current = Number(currentText) || 0;
      const d = dealershipPage(dir === 'next' ? current + 1 : current - 1);
      return interaction.update({ embeds: [d.embed], components: d.rows });
    }
    if (interaction.customId.startsWith('buy:')) {
      const v = V[Number(interaction.customId.split(':')[1]) - 1];
      if (!v) return interaction.reply({ content: '❌ Vehicle unavailable.', ephemeral: true });
      return interaction.reply({ content: await buy(interaction.guild, interaction.member, String(v.id)), ephemeral: true });
    }
    if (interaction.customId.startsWith('sellcancel:')) {
      await interaction.deferUpdate();
      pendingSales.delete(interaction.customId.slice(12));
      return interaction.editReply({ content: '↩️ Sale cancelled.', components: [] });
    }
    if (interaction.customId.startsWith('sellconfirm:')) {
      await interaction.deferUpdate();
      const id = interaction.customId.slice(12), sale = pendingSales.get(id);
      if (!sale || Date.now() > sale.expires) return interaction.editReply({ content: '❌ Sale expired.', components: [] });
      if (interaction.user.id !== sale.userId) return interaction.editReply({ content: '❌ Only the seller can confirm.', components: [] });
      const v = V[sale.vehicleId - 1];
      const o = await own(sale.guildId, sale.userId, v);
      if (!o) return interaction.editReply({ content: '❌ Vehicle is no longer in your garage.', components: [] });
      const del = await sb.from('user_vehicles').delete().eq('id', o.id);
      if (del.error) throw del.error;
      await changeBalance(sale.guildId, sale.userId, sale.value, 'vehicle_sale', v.id, { vehicle: v.name }, true);
      pendingSales.delete(id);
      return interaction.editReply({ content: `💵 **${v.name}** sold for **${money(sale.value)}**.`, components: [] });
    }
    if (interaction.customId.startsWith('racedecline:')) {
      const id = interaction.customId.slice(13);
      const r = pendingRaces.get(id);
      if (!r || Date.now() > r.expires) return interaction.reply({ content: '❌ Race challenge expired.', ephemeral: true });
      if (interaction.user.id !== r.to) return interaction.reply({ content: '❌ Only the challenged player can decline this race.', ephemeral: true });
      await interaction.deferUpdate();
      if (interaction.user.id !== r.to) return interaction.editReply({ content: '❌ Only the challenged player can respond to this race.', components: [] });
      pendingRaces.delete(id);
      return interaction.editReply({ content: '❌ Race challenge declined.', components: [] });
    }
    if (interaction.customId.startsWith('raceaccept:')) {
      await interaction.deferUpdate();
      const id = interaction.customId.slice(11);
      const r = pendingRaces.get(id);
      if (!r || Date.now() > r.expires) return interaction.editReply({ content: '❌ Race challenge expired.', components: [] });
      if (interaction.user.id !== r.to) return interaction.editReply({ content: '❌ Only the challenged player can accept this race.', components: [] });
      pendingRaces.delete(id);
      const guild = interaction.guild || interaction.client.guilds.cache.get(r.guildId);
      if (!guild) return interaction.editReply({ content: '❌ The server is no longer available.', components: [] });
      const a = await guild.members.fetch(r.from).catch(() => null);
      const b = await guild.members.fetch(r.to).catch(() => null);
      if (!a || !b) return interaction.editReply({ content: '❌ One of the players is no longer in the server.', components: [] });
      const result = await runRace(guild, a, r.type, b);
      return interaction.editReply({ content: `🏁 **RACE ACCEPTED**\n${raceText(r.type, result)}\n\n👤 Challenger: <@${r.from}>\n👤 Accepted by: <@${r.to}>`, components: [] });
    }
    if (interaction.customId.startsWith('betdecline:')) {
      const id = interaction.customId.slice(11), b = pendingBets.get(id);
      if (!b || Date.now() > b.expires) return interaction.reply({ content: '❌ Bet challenge expired.', ephemeral: true });
      if (interaction.user.id !== b.to) return interaction.reply({ content: '❌ Only the challenged player can decline this bet.', ephemeral: true });
      await interaction.deferUpdate();
      pendingBets.delete(id);
      return interaction.editReply({ content: '❌ Bet race declined.', components: [] });
    }
    if (interaction.customId.startsWith('betaccept:')) {
      await interaction.deferUpdate();
      const id = interaction.customId.slice(10), b = pendingBets.get(id);
      if (!b || Date.now() > b.expires) return interaction.editReply({ content: '❌ Bet challenge expired.', components: [] });
      if (b.settling) return interaction.editReply({ content: '⏳ This bet race is already being settled.', components: [] });
      if (interaction.user.id !== b.to) return interaction.editReply({ content: '❌ Only the challenged player can accept.', components: [] });
      b.settling = true;
      pendingBets.set(id, b);
      const p = await profile(b.guildId, b.from), q = await profile(b.guildId, b.to);
      if (p.balance < b.amount || q.balance < b.amount) return interaction.editReply({ content: '❌ Stake is no longer affordable.', components: [] });
      await changeBalance(b.guildId, b.from, -b.amount, 'bet_lock', id, {}, false);
      await changeBalance(b.guildId, b.to, -b.amount, 'bet_lock', id, {}, false);
      try {
        const guild = interaction.guild || interaction.client.guilds.cache.get(b.guildId);
        if (!guild) throw new Error('The server is no longer available.');
        const a = await guild.members.fetch(b.from), o = await guild.members.fetch(b.to);
        const result = await runRace(guild, a, 'race', o, { noRewards: true, stake: b.amount, pot: b.amount * 2 });
        if (result.error) throw new Error(result.error);
        await changeBalance(b.guildId, result.winnerId, b.amount * 2, 'bet_payout', id, { winner: result.winnerId }, false);
        pendingBets.delete(id);
        return interaction.editReply({ content: `💵 **BET RACE SETTLED**\n${raceText('race', result)}\n💰 Pot **${money(b.amount * 2)}** paid to <@${result.winnerId}>.`, components: [] });
      } catch (e) {
        await changeBalance(b.guildId, b.from, b.amount, 'bet_refund', id, {}, false).catch(() => {});
        await changeBalance(b.guildId, b.to, b.amount, 'bet_refund', id, {}, false).catch(() => {});
        pendingBets.delete(id);
        throw e;
      }
    }
    if (interaction.customId.startsWith('tradedecline:')) {
      const id = interaction.customId.slice(13);
      const t = pendingTrades.get(id);
      if (!t || Date.now() > t.expires) return interaction.reply({ content: '❌ Trade unavailable or expired.', ephemeral: true });
      if (interaction.user.id !== t.to) return interaction.reply({ content: '❌ Only the receiving player can decline this trade.', ephemeral: true });
      await interaction.deferUpdate();
      if (t?.tradeDbId) await sb.from('trades').update({ status: 'cancelled' }).eq('id', t.tradeDbId);
      pendingTrades.delete(id);
      return interaction.editReply({ content: '❌ Trade declined.', components: [] });
    }
    if (interaction.customId.startsWith('tradeaccept:')) {
      await interaction.deferUpdate();
      const id = interaction.customId.slice(12), t = pendingTrades.get(id);
      if (!t || Date.now() > t.expires || interaction.user.id !== t.to) return interaction.editReply({ content: '❌ Trade unavailable or expired.', components: [] });
      t.accepted = true;
      pendingTrades.set(id, t);
      return interaction.editReply({ content: `🤝 Trade accepted between <@${t.from}> and <@${t.to}>.\n<@${t.from}> can now use \`?tradeoffer @user <your vehicle> <their vehicle>\`.`, components: [] });
    }
    if (interaction.customId.startsWith('tradeconfirm:')) {
      await interaction.deferUpdate();
      const id = interaction.customId.slice(13), t = pendingTrades.get(id);
      if (!t || Date.now() > t.expires || !t.accepted || interaction.user.id !== t.to || !t.offer) return interaction.editReply({ content: '❌ Trade offer unavailable or expired.', components: [] });
      if (t.settling) return interaction.editReply({ content: '⏳ This trade is already being completed.', components: [] });
      t.settling = true;
      pendingTrades.set(id, t);
      const rpc = await sb.rpc('complete_vehicle_trade', { p_trade_id: t.tradeDbId });
      if (rpc.error) throw rpc.error;
      pendingTrades.delete(id);
      return interaction.editReply({ content: `🤝 **Trade complete!**\n<@${t.from}> gave **${V[t.offer.fromVehicle - 1]?.name}** and received **${V[t.offer.toVehicle - 1]?.name}**.`, components: [] });
    }
  } catch (e) {
    console.error('Game button error:', e);
    return interaction.reply({ content: `❌ Game action failed: ${e.message}`, ephemeral: true }).catch(() => {});
  }
  return false;
}

module.exports = {
  handle,
  handleButton,
  vehicles: V,
  startAutomation,
  grantProgressionVehicle,
  getTopGarages: topGarages,
  profile,
  vehiclesOf,
  runRace,
  raceScore,
  vehicleStats,
  activeSeason,
  changeBalance
};
