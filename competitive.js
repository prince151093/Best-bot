const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const config = require('./config');
const game = require('./game');
const { garageRoleMention, memberHasGarageRole } = require('./server-settings');

const sb = require('@supabase/supabase-js').createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_DAYS = [7, 7, 7, 9];
const STAGE_SIZES = [48, 36, 24, 12];
const RACES_PER_DAY = 3;
const MATCH_HOURS = [17, 18, 19];
const TZ = process.env.PROGRESSION_TIMEZONE || 'Asia/Kolkata';
const started = new Set();

// Shared currency formatter for event UI.
// Keep this local to avoid relying on a missing import/global helper.
function money(amount) {
  const value = Number(amount) || 0;
  return `₹${value.toLocaleString('en-IN')}`;
}

function isoAtDay(base, dayOffset, hour) {
  const d = new Date(base.getTime() + dayOffset * DAY_MS);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const get = t => parts.find(x => x.type === t).value;
  return new Date(`${get('year')}-${get('month')}-${get('day')}T${String(hour).padStart(2, '0')}:00:00+05:30`);
}

function stageFor(elapsedDay) {
  if (elapsedDay < 7) return 1;
  if (elapsedDay < 14) return 2;
  if (elapsedDay < 21) return 3;
  return 4;
}

function stageDay(champ, now = new Date()) {
  if (!champ?.stage_started_at) return 0;
  return Math.floor((now - new Date(champ.stage_started_at)) / DAY_MS) + 1;
}

function remainingText(end) {
  if (!end) return '—';
  const ms = Math.max(0, new Date(end).getTime() - Date.now());
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / 3600000);
  return days ? `${days}d ${hours}h` : `${hours}h`;
}

async function competitionChannel(guild) {
  const id = config.competitionChannelId;
  if (id) {
    const c = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (c?.isTextBased()) return c;
  }
  return guild.systemChannel || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages')) || null;
}

async function announce(guild, title, description, components = []) {
  const channel = await competitionChannel(guild);
  if (!channel) return;
  const roleMention = await garageRoleMention(guild.id).catch(() => '');
  await channel.send({
    content: roleMention || undefined,
    allowedMentions: roleMention ? { roles: [roleMention.match(/\d+/)?.[0]] } : { parse: [] },
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp()],
    components
  }).catch(() => {});
}

function dailyKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}

async function claimDailyAnnouncement(guildId, kind, key) {
  const id = `${guildId}:${kind}:${key}`;
  const ins = await sb.from('vehicle_life_announcements').insert({ announcement_key: id, guild_id: String(guildId), kind, day_key: key });
  if (!ins.error) return true;
  if (String(ins.error.code || '') === '23505' || /duplicate/i.test(String(ins.error.message || ''))) return false;
  throw ins.error;
}

function eventButtonRows(eventId) {
  const id = String(eventId);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:join:${id}`).setLabel('🎮 Join Event').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`event:details:${id}`).setLabel('ℹ️ Details').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`event:leaderboard:${id}`).setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Secondary)
    )
  ];
}

function dailyButtonRows(type, eventId = null) {
  if (type === 'event') return eventButtonRows(eventId || 'daily');
  if (type === 'season') return seasonRows();
  return [new ActionRowBuilder().addComponents(
    button('🏁 Register', 'champ:register', ButtonStyle.Success),
    button('👤 My Status', 'champ:status', ButtonStyle.Primary),
    button('📅 Schedule', 'champ:schedule', ButtonStyle.Secondary),
    button('🏆 Standings', 'champ:standings', ButtonStyle.Secondary)
  )];
}

async function sendClosedEventAnnouncements(guild) {
  const since = new Date(Date.now() - 2 * DAY_MS).toISOString();
  const r = await sb.from('events').select('*').eq('guild_id', guild.id).eq('status', 'closed').gte('ends_at', since).order('ends_at', { ascending: false }).limit(10);
  if (r.error) throw r.error;
  for (const event of r.data || []) {
    const key = String(event.id);
    if (!(await claimDailyAnnouncement(guild.id, 'event_close', key))) continue;
    const lb = await sb.from('event_entries').select('user_id,score').eq('event_id', event.id).order('score', { ascending: false }).limit(3);
    if (lb.error) throw lb.error;
    const rows = lb.data || [];
    const cash = Number(event.rewards?.cash || 0);
    const xp = Number(event.rewards?.xp || 0);
    const podium = rows.length
      ? rows.map((x, i) => `${['🥇','🥈','🥉'][i] || `#${i+1}`} <@${x.user_id}> — **${Number(x.score || 0)} pts**`).join('\n')
      : 'No players registered.';
    await announce(guild, `🏁 EVENT COMPLETE — ${event.name}`, `${podium}\n\n🎁 Configured prize: **${cash ? `₹${cash.toLocaleString('en-IN')}` : 'No cash prize'}**${xp ? ` + **${xp} XP**` : ''}\n\nPrize processing follows the event reward configuration.`);
  }
}

async function sendDailyWorldAnnouncements(guild) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(now);
  const hour = Number(parts.find(x => x.type === 'hour')?.value || 0);
  const minute = Number(parts.find(x => x.type === 'minute')?.value || 0);
  const key = dailyKey();

  // Events: 05:15 IST
  if (hour === 5 && minute === 15 && await claimDailyAnnouncement(guild.id, 'event_daily', key)) {
    const open = await sb.from('events').select('*').eq('guild_id', guild.id).eq('status','open').order('starts_at').limit(1);
    if (open.error) throw open.error;
    let event = open.data?.[0];
    if (!event) {
      const starts = new Date();
      const ends = new Date(starts.getTime() + DAY_MS);
      const ins = await sb.from('events').insert({ guild_id:guild.id, name:'Daily Sprint', description:'Complete PvP races during the event and climb the leaderboard. Free entry.', entry_fee:0, status:'open', starts_at:starts.toISOString(), ends_at:ends.toISOString(), rewards:{cash:25000,xp:150} }).select().single();
      if (ins.error) throw ins.error;
      event = ins.data;
    }
    const reward = Number(event.rewards?.cash || 0);
    await announce(guild, '🎉 DAILY EVENT IS LIVE', `**${event.name}**

🎟️ Entry: **FREE**
🏆 Prize: **${reward ? `₹${reward.toLocaleString('en-IN')}` : 'Configured event rewards'}**
⏳ Ends: <t:${Math.floor(new Date(event.ends_at).getTime()/1000)}:F>

Press **🎮 Join Event** to enter. Use **🏆 Leaderboard** to see live rankings.`, eventButtonRows(event.id));
  }

  // Season: 15:00 IST
  if (hour === 15 && minute === 0 && await claimDailyAnnouncement(guild.id, 'season_daily', key)) {
    const season = await game.activeSeason(guild.id);
    if (season) {
      const remaining = remainingText(season.ends_at);
      await announce(guild, `📈 ${season.name} — DAILY UPDATE`, `🗓️ **Season #${season.season_no}**
⏳ Remaining: **${remaining}**

The Season progression continues today. Use the buttons to view your stats, leaderboard and rewards.

ℹ️ **Season and Championship are separate systems.**`, dailyButtonRows('season'));
    }
  }

  // Championship: 21:00 IST
  if (hour === 21 && minute === 0 && await claimDailyAnnouncement(guild.id, 'championship_daily', key)) {
    const season = await game.activeSeason(guild.id);
    if (season) {
      let champ = await activeChampionship(guild.id, season.id);
      if (!champ) champ = await createChampionship(guild, season);
      const registered = champ ? await registrationCount(champ.id) : 0;
      if (champ?.status === 'registration') {
        await announce(guild, '🏆 CHAMPIONSHIP REGISTRATION', `Registration is **OPEN**.

👥 Registered: **${registered}/48**
🏁 Format: **48 → 36 → 24 → 12 → 3**
💰 Prizes: **₹300,000 / ₹200,000 / ₹100,000**

Only members with the configured Garage Role can register.`, dailyButtonRows('champ'));
      } else if (champ?.status === 'active') {
        await announce(guild, `🏆 CHAMPIONSHIP — STAGE ${champ.stage} DAILY UPDATE`, `👥 Current stage field: **${STAGE_SIZES[champ.stage-1] || 12} players**
🏁 **3 PvP races per player per day**
⏱️ Your races are scheduled automatically with at least **1 hour** between your own races.

Use the buttons to view your status, schedule and standings.`, dailyButtonRows('champ'));
      }
    }
  }
}

async function activeChampionship(guildId, seasonId) {
  const q = await sb.from('championships')
    .select('*')
    .eq('guild_id', guildId)
    .eq('season_id', seasonId)
    .in('status', ['registration', 'active', 'finished'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (q.error) throw q.error;
  return q.data;
}

async function registrationRows(champId) {
  const q = await sb.from('championship_players')
    .select('*')
    .eq('championship_id', champId)
    .eq('stage', 1)
    .order('created_at', { ascending: true });
  if (q.error) throw q.error;
  return q.data || [];
}

async function registrationCount(champId) {
  const q = await sb.from('championship_players')
    .select('id', { count: 'exact', head: true })
    .eq('championship_id', champId)
    .eq('stage', 1);
  if (q.error) throw q.error;
  return Number(q.count || 0);
}

async function eligibleForRegistration(guildId, userId) {
  const p = await sb.from('game_profiles')
    .select('user_id,race_vehicle_id')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .maybeSingle();
  if (p.error) throw p.error;
  return Boolean(p.data?.race_vehicle_id);
}

async function createChampionship(guild, season) {
  const existing = await activeChampionship(guild.id, season.id);
  if (existing) return existing;

  const now = new Date();
  const ins = await sb.from('championships').insert({
    guild_id: guild.id,
    season_id: season.id,
    status: 'registration',
    stage: 1,
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    stage_started_at: now.toISOString(),
    stage_ends_at: new Date(now.getTime() + 7 * DAY_MS).toISOString()
  }).select().single();

  if (ins.error) {
    // Another automation tick/button may have created the registration first.
    const retry = await activeChampionship(guild.id, season.id);
    if (retry) return retry;
    throw ins.error;
  }

  // The scheduled 21:00 IST announcement publishes the registration panel.


  return ins.data;
}

async function startChampionship(guild, champ) {
  if (!champ || champ.status !== 'registration') return champ;

  const rows = await registrationRows(champ.id);
  if (rows.length < 48) return champ;

  // Keep the first 48 successful registrations if a race-condition ever
  // produces more than the limit.
  const selected = rows.slice(0, 48);
  const extras = rows.slice(48);
  if (extras.length) {
    await sb.from('championship_players').delete().in('id', extras.map(x => x.id));
  }

  const now = new Date();
  const upd = await sb.from('championships').update({
    status: 'active',
    stage: 1,
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    stage_started_at: now.toISOString(),
    stage_ends_at: new Date(now.getTime() + 7 * DAY_MS).toISOString()
  }).eq('id', champ.id).eq('status', 'registration').select().single();
  if (upd.error) throw upd.error;

  await announce(
    guild,
    '🏆 CHAMPIONSHIP STARTED',
    `**48 drivers** have entered the 30-day Championship.\n\n` +
    `🏁 Stage 1: **48 → 36**\n` +
    `📅 Races are scheduled automatically every day.\n` +
    `🏎️ **${RACES_PER_DAY} PvP races per player per day**\n` +
    `⏱️ Minimum **1 hour** between a player's races.\n\n` +
    `❗ A single loss never directly eliminates a player.`
  );

  return upd.data;
}

async function stagePlayers(champ, stage) {
  const q = await sb.from('championship_players')
    .select('*')
    .eq('championship_id', champ.id)
    .eq('stage', stage)
    .eq('eliminated', false)
    .order('points', { ascending: false })
    .order('wins', { ascending: false })
    .order('races', { ascending: false });
  if (q.error) throw q.error;
  return q.data || [];
}

async function hasMatchForDay(champId, stage, dayNo) {
  const q = await sb.from('championship_matches')
    .select('id')
    .eq('championship_id', champId)
    .eq('stage', stage)
    .eq('day_no', dayNo)
    .limit(1);
  if (q.error) throw q.error;
  return Boolean(q.data?.length);
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function scheduleDay(guild, champ, dayNo) {
  const stage = champ.stage;
  if (dayNo < 1 || dayNo > STAGE_DAYS[stage - 1]) return;
  if (await hasMatchForDay(champ.id, stage, dayNo)) return;

  const players = (await stagePlayers(champ, stage)).map(x => String(x.user_id));
  if (!players.length) return;

  const shuffled = shuffle(players);
  const groups = [[], [], []];

  for (let round = 0; round < RACES_PER_DAY; round++) {
    const rotated = shuffled.slice();
    const offset = (round * 2) % Math.max(2, rotated.length);
    const left = rotated.slice(offset).concat(rotated.slice(0, offset));
    for (let i = 0; i + 1 < left.length; i += 2) groups[round].push([left[i], left[i + 1]]);
  }

  let matchNo = 1;
  for (let round = 0; round < RACES_PER_DAY; round++) {
    const when = isoAtDay(new Date(champ.stage_started_at), dayNo - 1, MATCH_HOURS[round]);
    for (const [a, b] of groups[round]) {
      const ins = await sb.from('championship_matches').insert({
        championship_id: champ.id,
        stage,
        day_no: dayNo,
        match_no: matchNo++,
        scheduled_at: when.toISOString(),
        racer_a: a,
        racer_b: b,
        status: 'scheduled'
      });
      if (ins.error) throw ins.error;
    }
  }

  const total = groups.reduce((n, g) => n + g.length, 0);
  const channel = await competitionChannel(guild);
  if (!channel) return;

  const roleMention = await garageRoleMention(guild.id).catch(() => '');
  await channel.send({
    content: roleMention || undefined,
    allowedMentions: roleMention ? { roles: [roleMention.match(/\d+/)?.[0]] } : { parse: [] },
    embeds: [new EmbedBuilder()
      .setTitle(`📅 STAGE ${stage} — DAY ${dayNo} SCHEDULE`)
      .setDescription(`**${total} PvP matches** are scheduled today.\n\nEach player has **3 races** with at least **1 hour between their own races**.\n❗ A single loss does not eliminate a player.`)]
  }).catch(() => {});

  const lines = [];
  let n = 1;
  for (let round = 0; round < RACES_PER_DAY; round++) {
    const label = `${String(MATCH_HOURS[round]).padStart(2, '0')}:00`;
    for (const [a, b] of groups[round]) {
      lines.push(`🏁 **Match #${n++}** • <@${a}> 🆚 <@${b}> • 🕔 **${label}**`);
    }
  }
  for (let i = 0; i < lines.length; i += 20) {
    await channel.send({
      content: `${roleMention ? roleMention + '\n' : ''}${lines.slice(i, i + 20).join('\n')}`,
      allowedMentions: roleMention ? { roles: [roleMention.match(/\d+/)?.[0]] } : { parse: [] }
    }).catch(() => {});
  }
}

async function standings(champ, stage) {
  const rows = await stagePlayers(champ, stage);
  return rows.sort((a, b) =>
    Number(b.points) - Number(a.points) ||
    Number(b.wins) - Number(a.wins) ||
    Number(b.races) - Number(a.races) ||
    String(a.user_id).localeCompare(String(b.user_id))
  );
}

async function finishStage(guild, champ) {
  const stage = champ.stage;
  const rows = await standings(champ, stage);
  const keep = STAGE_SIZES[stage];

  if (stage < 4) {
    const qualified = rows.slice(0, keep);
    const eliminated = rows.slice(keep);
    if (eliminated.length) {
      await sb.from('championship_players').update({ eliminated: true }).in('id', eliminated.map(x => x.id));
    }

    const nextStage = stage + 1;
    await sb.from('championship_players').insert(qualified.map(x => ({
      championship_id: champ.id,
      user_id: x.user_id,
      stage: nextStage,
      points: 0,
      wins: 0,
      losses: 0,
      races: 0,
      eliminated: false
    })));

    const nextStart = new Date(champ.stage_ends_at);
    const days = STAGE_DAYS[nextStage - 1];
    const nextEnd = new Date(nextStart.getTime() + days * DAY_MS);
    await sb.from('championships').update({
      stage: nextStage,
      stage_started_at: nextStart.toISOString(),
      stage_ends_at: nextEnd.toISOString()
    }).eq('id', champ.id);

    await announce(
      guild,
      `🏆 STAGE ${stage} COMPLETE`,
      `🟢 **${keep} players qualified**\n🔴 **${eliminated.length} players eliminated**\n\nNext stage: **${keep} → ${nextStage === 4 ? 12 : STAGE_SIZES[nextStage]}**\n📅 The next daily schedule will be generated automatically.`
    );
    return;
  }

  const top = rows.slice(0, 3);
  if (rows.length > 3) {
    await sb.from('championship_players').update({ eliminated: true }).in('id', rows.slice(3).map(x => x.id));
  }

  const prizes = [300000, 200000, 100000];
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    await sb.from('championship_players').update({ final_position: i + 1, final_prize: prizes[i] }).eq('id', r.id);
    await game.changeBalance?.(guild.id, r.user_id, prizes[i], 'championship_prize', champ.id, { position: i + 1 }, false).catch(() => {});
  }

  await sb.from('championships').update({
    status: 'finished',
    winner_user_id: top[0]?.user_id || null,
    finished_at: new Date().toISOString()
  }).eq('id', champ.id);

  await announce(
    guild,
    '🏆 CHAMPIONSHIP COMPLETE',
    `After 30 days, the final three drivers are:\n\n` +
    `🥇 <@${top[0]?.user_id}> — **₹300,000**\n` +
    `🥈 <@${top[1]?.user_id}> — **₹200,000**\n` +
    `🥉 <@${top[2]?.user_id}> — **₹100,000**\n\n` +
    `🏁 **48 → 36 → 24 → 12 → 3**`
  );
}

async function resolveMatch(guild, match) {
  if (match.status !== 'scheduled' || new Date(match.scheduled_at) > new Date()) return;

  const a = await guild.members.fetch(match.racer_a).catch(() => null);
  const b = await guild.members.fetch(match.racer_b).catch(() => null);

  if (!a || !b) {
    const winnerId = a && !b ? match.racer_a : (!a && b ? match.racer_b : null);
    if (winnerId) {
      const loserId = winnerId === match.racer_a ? match.racer_b : match.racer_a;
      const wp = await sb.from('championship_players').select('*').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', winnerId).single();
      const lp = await sb.from('championship_players').select('*').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', loserId).single();
      if (!wp.error && !lp.error) {
        await sb.from('championship_players').update({
          points: Number(wp.data.points || 0) + 3,
          wins: Number(wp.data.wins || 0) + 1,
          races: Number(wp.data.races || 0) + 1
        }).eq('id', wp.data.id);
        await sb.from('championship_players').update({
          losses: Number(lp.data.losses || 0) + 1,
          races: Number(lp.data.races || 0) + 1
        }).eq('id', lp.data.id);
      }
      await sb.from('championship_matches').update({
        status: 'forfeit',
        winner: winnerId,
        loser: loserId,
        result_note: 'Forfeit: one scheduled player was unavailable.',
        finished_at: new Date().toISOString()
      }).eq('id', match.id);
      await announce(guild, '⚠️ MATCH FORFEIT', `<@${winnerId}> receives the scheduled win because the opponent was unavailable.\n\n❗ A forfeit does not directly eliminate a player.`);
    } else {
      await sb.from('championship_matches').update({
        status: 'forfeit',
        result_note: 'Both scheduled players were unavailable.',
        finished_at: new Date().toISOString()
      }).eq('id', match.id);
    }
    return;
  }

  const result = await game.runRace(guild, a, 'race', b, { noRewards: true, competition: true });
  if (result.error) {
    await sb.from('championship_matches').update({ status: 'forfeit', result_note: result.error, finished_at: new Date().toISOString() }).eq('id', match.id);
    return;
  }

  const winner = result.winnerId;
  const loser = result.loserId;
  const oppA = await sb.from('championship_players').select('points').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', match.racer_b).maybeSingle();
  const oppB = await sb.from('championship_players').select('points').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', match.racer_a).maybeSingle();
  const strengthA = Number(oppA.data?.points || 0);
  const strengthB = Number(oppB.data?.points || 0);
  const winPts = 3 + Math.max(0, Math.min(2, Math.floor(strengthA / 10)));
  const losePts = 1 + Math.max(0, Math.min(1, Math.floor(strengthB / 15)));

  const p1 = await sb.from('championship_players').select('*').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', match.racer_a).single();
  const p2 = await sb.from('championship_players').select('*').eq('championship_id', match.championship_id).eq('stage', match.stage).eq('user_id', match.racer_b).single();
  if (p1.error || p2.error) throw p1.error || p2.error;

  const aWon = winner === match.racer_a;
  await sb.from('championship_players').update({
    points: Number(p1.data.points || 0) + (aWon ? winPts : losePts),
    wins: Number(p1.data.wins || 0) + (aWon ? 1 : 0),
    losses: Number(p1.data.losses || 0) + (aWon ? 0 : 1),
    races: Number(p1.data.races || 0) + 1
  }).eq('id', p1.data.id);
  await sb.from('championship_players').update({
    points: Number(p2.data.points || 0) + (aWon ? losePts : winPts),
    wins: Number(p2.data.wins || 0) + (aWon ? 0 : 1),
    losses: Number(p2.data.losses || 0) + (aWon ? 1 : 0),
    races: Number(p2.data.races || 0) + 1
  }).eq('id', p2.data.id);

  await sb.from('championship_matches').update({
    status: 'finished',
    finished_at: new Date().toISOString(),
    winner,
    loser,
    win_chance_a: result.chanceA,
    win_chance_b: result.chanceB
  }).eq('id', match.id);

  await announce(
    guild,
    '🏁 MATCH RESULT',
    `**Match #${match.match_no}**\n<@${match.racer_a}> 🆚 <@${match.racer_b}>\n\n` +
    `🏆 Winner: <@${winner}>\n` +
    `📊 Win chance: **${result.chanceA}% — ${result.chanceB}%**\n` +
    `🚗 ${result.vehicleA.name} 🆚 ${result.vehicleB.name}\n\n` +
    `❗ A single loss does **not** eliminate a player.`
  );
}

async function tickGuild(guild) {
  const season = await game.activeSeason(guild.id);
  if (!season || !season.active) return;

  let champ = await activeChampionship(guild.id, season.id);
  if (!champ) champ = await createChampionship(guild, season);
  if (!champ) return;

  if (!champ) {
    return {
      season,
      champ: null,
      registered: 0,
      userRegistered: false,
      embed: new EmbedBuilder()
        .setTitle('🏆 VEHICLE LIFE CHAMPIONSHIP')
        .setDescription(
          `**Registration is opening…**\n\n` +
          `👥 Registered: **0/48**\n` +
          `🏁 Format: **48 → 36 → 24 → 12 → 3**\n` +
          `💰 Prizes: 🥇 ₹300,000 • 🥈 ₹200,000 • 🥉 ₹100,000\n\n` +
          `The Championship registration panel will be activated automatically.`
        )
    };
  }

  if (champ.status === 'registration') {
    const count = await registrationCount(champ.id);
    if (count >= 48) champ = await startChampionship(guild, champ);
    else return;
  }

  if (!champ || champ.status !== 'active') return;

  const now = new Date();
  const elapsed = Math.floor((now - new Date(champ.starts_at)) / DAY_MS);
  const expectedStage = stageFor(elapsed);
  if (expectedStage > champ.stage) {
    await finishStage(guild, champ);
    champ = await activeChampionship(guild, season.id);
    if (!champ || champ.status !== 'active') return;
  }

  const d = stageDay(champ, now);
  if (d >= 1 && d <= STAGE_DAYS[champ.stage - 1]) await scheduleDay(guild, champ, d);

  const q = await sb.from('championship_matches')
    .select('*')
    .eq('championship_id', champ.id)
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at')
    .limit(50);
  if (q.error) throw q.error;
  for (const match of q.data || []) await resolveMatch(guild, match);
}

async function startCompetitiveAutomation(client) {
  if (started.size) return;
  const tick = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        await sendClosedEventAnnouncements(guild);
        await sendDailyWorldAnnouncements(guild);
        await tickGuild(guild);
      } catch (e) {
        console.error(`Competitive automation failed for ${guild.id}:`, e.message);
      }
    }
  };
  await tick();
  const timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  started.add('running');
}

function button(label, customId, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
}

function championshipRows(champ, registered, userRegistered) {
  const registrationOpen = champ?.status === 'registration';
  return [
    new ActionRowBuilder().addComponents(
      button('🏁 Register', 'champ:register', ButtonStyle.Success, !registrationOpen || userRegistered || registered >= 48),
      button('👤 My Status', 'champ:status', ButtonStyle.Primary),
      button('📅 Schedule', 'champ:schedule', ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      button('🏆 Standings', 'champ:standings', ButtonStyle.Secondary),
      button('📜 Rules', 'champ:rules', ButtonStyle.Secondary),
      button('🔄 Refresh', 'champ:refresh', ButtonStyle.Secondary)
    )
  ];
}

async function championshipDashboard(guildId, userId) {
  const season = await game.activeSeason(guildId);
  if (!season) {
    return {
      season: null,
      champ: null,
      embed: new EmbedBuilder().setTitle('🏆 CHAMPIONSHIP').setDescription('⏳ No active Season is available yet.')
    };
  }

  let champ = await activeChampionship(guildId, season.id);
  const registered = champ ? await registrationCount(champ.id) : 0;
  const userRow = champ ? await sb.from('championship_players').select('*').eq('championship_id', champ.id).eq('user_id', userId).eq('stage', 1).maybeSingle() : { data: null };
  const userRegistered = Boolean(userRow.data);

  if (champ.status === 'registration') {
    const needed = Math.max(0, 48 - registered);
    return {
      season,
      champ,
      registered,
      userRegistered,
      embed: new EmbedBuilder()
        .setTitle('🏆 VEHICLE LIFE CHAMPIONSHIP')
        .setDescription(
          `**Registration is OPEN**\n\n` +
          `👥 Registered: **${registered}/48**\n` +
          `🎯 Needed to start: **${needed}**\n\n` +
          `🏁 Format: **48 → 36 → 24 → 12 → 3**\n` +
          `📅 Duration: **30 days after the 48th registration**\n` +
          `🏎️ **3 PvP races per player per day**\n` +
          `💰 Prizes: 🥇 ₹300,000 • 🥈 ₹200,000 • 🥉 ₹100,000\n\n` +
          (userRegistered ? '✅ **You are registered.**' : '👇 Press **🏁 Register** below to join.')
        )
        .setFooter({ text: `Season ${season.season_no} • Registration closes at 48 players` })
    };
  }

  const rows = await standings(champ, champ.stage);
  const mine = rows.find(x => String(x.user_id) === String(userId));
  const position = mine ? rows.findIndex(x => x.id === mine.id) + 1 : null;

  return {
    season,
    champ,
    registered: 48,
    userRegistered: Boolean(mine),
    embed: new EmbedBuilder()
      .setTitle(`🏆 CHAMPIONSHIP • STAGE ${champ.stage}`)
      .setDescription(
        `👥 Drivers: **${rows.length}**\n` +
        `📅 Stage day: **${Math.max(1, stageDay(champ))}/${STAGE_DAYS[champ.stage - 1]}**\n` +
        `⏳ Stage remaining: **${remainingText(champ.stage_ends_at)}**\n\n` +
        (mine
          ? `👤 **Your position:** #${position}\n📊 **${mine.points} pts** • ${mine.wins}W / ${mine.losses}L\n🏁 ${mine.races} races\n\n`
          : '❌ You are not a Championship player.\n\n') +
        `🏁 **48 → 36 → 24 → 12 → 3**\n` +
        `💰 🥇 ₹300,000 • 🥈 ₹200,000 • 🥉 ₹100,000`
      )
      .setFooter({ text: `Season ${season.season_no} • Championship ends in ${remainingText(champ.ends_at)}` })
  };
}

async function seasonDashboard(guildId, userId, section = 'overview') {
  const season = await game.activeSeason(guildId);
  if (!season) {
    return { embed: new EmbedBuilder().setTitle('📈 SEASON').setDescription('⏳ No active Season is available yet.') };
  }

  const p = await game.profile(guildId, userId);
  const xp = Number(p?.season_xp || 0);
  const level = Math.floor(xp / 1000) + 1;
  const inLevel = xp % 1000;
  const remaining = remainingText(season.ends_at);

  if (section === 'leaderboard') {
    const r = await sb.from('game_profiles').select('user_id,season_xp,driver_level').eq('guild_id', guildId).order('season_xp', { ascending: false }).limit(10);
    if (r.error) throw r.error;
    const list = (r.data || []).map((x, i) => `**#${i + 1}** <@${x.user_id}> • **${Number(x.season_xp || 0)} XP** • Lv.${Math.floor(Number(x.season_xp || 0) / 1000) + 1}`).join('\n') || 'No season activity yet.';
    return {
      embed: new EmbedBuilder().setTitle(`📈 ${season.name} • LEADERBOARD`).setDescription(`⏳ **${remaining}** remaining\n\n${list}`)
    };
  }

  if (section === 'stats') {
    return {
      embed: new EmbedBuilder().setTitle(`👤 MY SEASON • ${season.name}`).setDescription(
        `⭐ Season XP: **${xp}**\n` +
        `📈 Season Level: **${level}**\n` +
        `🎯 Progress: **${inLevel}/1000 XP** to Level ${level + 1}\n` +
        `⏳ Remaining: **${remaining}**\n\n` +
        `Earn Season XP through races and other supported Vehicle Life activities.`
      )
    };
  }

  if (section === 'rewards') {
    return {
      embed: new EmbedBuilder().setTitle(`🎁 ${season.name} • SEASON REWARDS`).setDescription(
        `Season progression is based on **Season XP**.\n\n` +
        `⭐ Level 5 — milestone\n⭐ Level 10 — milestone\n⭐ Level 20 — milestone\n⭐ Level 30 — milestone\n\n` +
        `Use **My Stats** to track your Season XP and level.`
      )
    };
  }

  return {
    embed: new EmbedBuilder().setTitle(`📈 ${season.name}`)
      .setDescription(
        `🗓️ **Season #${season.season_no}**\n` +
        `⏳ Remaining: **${remaining}**\n\n` +
        `👤 Your Season Level: **${level}**\n` +
        `⭐ Season XP: **${xp}**\n` +
        `🎯 Progress: **${inLevel}/1000 XP**\n\n` +
        `The **Season** and **Championship** are separate systems.\n` +
        `Use the buttons below to navigate.`
      )
  };
}

function seasonRows() {
  return [
    new ActionRowBuilder().addComponents(
      button('📈 Overview', 'season:overview', ButtonStyle.Primary),
      button('👤 My Stats', 'season:stats', ButtonStyle.Secondary),
      button('🏆 Leaderboard', 'season:leaderboard', ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      button('🎁 Rewards', 'season:rewards', ButtonStyle.Secondary),
      button('🔄 Refresh', 'season:refresh', ButtonStyle.Secondary),
      button('🏆 Championship', 'season:championship', ButtonStyle.Success)
    )
  ];
}

async function sendChampionshipDashboard(message) {
  const data = await championshipDashboard(message.guild.id, message.author.id);
  return message.reply({ embeds: [data.embed], components: championshipRows(data.champ, data.registered || 0, data.userRegistered) });
}

async function sendSeasonDashboard(message) {
  const data = await seasonDashboard(message.guild.id, message.author.id);
  return message.reply({ embeds: [data.embed], components: seasonRows() });
}

async function handleCommand(message) {
  const cmd = String(message.content || '').trim().split(/\s+/)[0]?.toLowerCase();
  if (!['?championship', '?champ', '?season'].includes(cmd)) return false;

  if (cmd === '?season') return sendSeasonDashboard(message);
  return sendChampionshipDashboard(message);
}

async function getOpenEvent(guildId, eventId = null) {
  let q = sb.from('events').select('*').eq('guild_id', guildId).eq('status', 'open');
  if (eventId && eventId !== 'daily') q = q.eq('id', Number(eventId));
  q = q.order('starts_at', { ascending: false }).limit(1).maybeSingle();
  const r = await q;
  if (r.error) throw r.error;
  return r.data;
}

function eventProgressBar(score, max = 20) {
  const n = Math.max(0, Number(score) || 0);
  const filled = Math.min(10, Math.round((n / Math.max(1, max)) * 10));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

async function eventEmbed(guildId, userId, event) {
  if (!event) return new EmbedBuilder().setTitle('🎉 VEHICLE LIFE • EVENT').setDescription('❌ No active event is available right now.');
  const entry = await sb.from('event_entries').select('score,joined_at').eq('event_id', event.id).eq('user_id', userId).maybeSingle();
  if (entry.error) throw entry.error;
  const score = Number(entry.data?.score || 0);
  const joined = Boolean(entry.data);
  const lb = await sb.from('event_entries').select('user_id,score').eq('event_id', event.id).order('score', { ascending: false }).order('joined_at', { ascending: true }).limit(100);
  if (lb.error) throw lb.error;
  const rows = lb.data || [];
  const pos = joined ? rows.findIndex(x => String(x.user_id) === String(userId)) + 1 : null;
  const reward = Number(event.rewards?.cash || 0);
  const xp = Number(event.rewards?.xp || 0);
  return new EmbedBuilder()
    .setTitle(`🎉 ${event.name.toUpperCase()}`)
    .setDescription(
      `🏁 **Complete races and climb the live leaderboard.**\n\n` +
      `🎟️ Entry: **${Number(event.entry_fee || 0) ? money(event.entry_fee) : 'FREE'}**\n` +
      `🏆 Reward: **${reward ? money(reward) : 'Configured prize'}**${xp ? ` + **${xp} XP**` : ''}\n` +
      `⏳ Ends: <t:${Math.floor(new Date(event.ends_at).getTime() / 1000)}:R>\n\n` +
      `👤 **Your status:** ${joined ? `#${pos} • **${score} pts**` : 'Not joined'}\n` +
      `${eventProgressBar(score)} ${score} pts\n\n` +
      `📌 **Scoring**\n` +
      `• PvP win: **+3 pts**\n` +
      `• PvP loss: **+1 pt**\n` +
      `• Solo race: **+1 pt**`
    )
    .addFields({ name: '📜 Event', value: event.description || 'Compete in Vehicle Life races.', inline: false })
    .setFooter({ text: `Event #${event.id} • Live rankings update after races` })
    .setTimestamp();
}

async function eventLeaderboardEmbed(guildId, userId, event) {
  if (!event) return new EmbedBuilder().setTitle('🏆 EVENT LEADERBOARD').setDescription('❌ No active event is available right now.');
  const r = await sb.from('event_entries').select('user_id,score,joined_at').eq('event_id', event.id).order('score', { ascending: false }).order('joined_at', { ascending: true }).limit(50);
  if (r.error) throw r.error;
  const rows = r.data || [];
  const mine = rows.findIndex(x => String(x.user_id) === String(userId));
  const lines = rows.slice(0, 10).map((x, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    return `${medal} <@${x.user_id}> — **${Number(x.score || 0)} pts**`;
  });
  if (mine >= 10) lines.push(`\n📍 **Your position:** #${mine + 1} • **${Number(rows[mine].score || 0)} pts**`);
  return new EmbedBuilder()
    .setTitle(`🏆 ${event.name.toUpperCase()} • LEADERBOARD`)
    .setDescription(lines.join('\n') || 'No players have joined yet.\n\nBe the first to enter the event!')
    .addFields(
      { name: '👥 Players', value: `**${rows.length}**`, inline: true },
      { name: '⏳ Ends', value: `<t:${Math.floor(new Date(event.ends_at).getTime() / 1000)}:R>`, inline: true },
      { name: '🎯 Your Score', value: mine >= 0 ? `**${Number(rows[mine].score || 0)} pts** • #${mine + 1}` : '**Not joined**', inline: true }
    )
    .setFooter({ text: `Event #${event.id} • Top 10 shown` })
    .setTimestamp();
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  const id = String(interaction.customId || '');
  if (!id.startsWith('champ:') && !id.startsWith('season:') && !id.startsWith('event:')) return false;

  try {
    if (!interaction.guild) return interaction.reply({ content: '❌ This button only works inside a server.', ephemeral: true });

    if (id.startsWith('event:')) {
      const [, action, eventId] = id.split(':');
      const event = await getOpenEvent(interaction.guild.id, eventId);
      if (!event) return interaction.reply({ content: '❌ This event is no longer active.', ephemeral: true });

      if (action === 'join') {
        const existing = await sb.from('event_entries').select('id,score').eq('event_id', event.id).eq('user_id', interaction.user.id).maybeSingle();
        if (existing.error) throw existing.error;
        if (!existing.data) {
          const fee = Number(event.entry_fee || 0);
          if (fee > 0) await game.changeBalance(interaction.guild.id, interaction.user.id, -fee, 'event_entry', event.id, {}, false);
          const ins = await sb.from('event_entries').insert({ event_id: event.id, guild_id: interaction.guild.id, user_id: interaction.user.id, score: 0, joined_at: new Date().toISOString() });
          if (ins.error) {
            if (fee > 0) await game.changeBalance(interaction.guild.id, interaction.user.id, fee, 'event_entry_refund', event.id, {}, false).catch(() => {});
            if (String(ins.error.code || '') === '23505' || /duplicate/i.test(String(ins.error.message || ''))) {
              return interaction.reply({ content: '✅ You are already in this event.', ephemeral: true });
            }
            throw ins.error;
          }
        }
        return interaction.update({ embeds: [await eventEmbed(interaction.guild.id, interaction.user.id, event)], components: eventButtonRows(event.id) });
      }

      if (action === 'details') {
        return interaction.reply({ embeds: [await eventEmbed(interaction.guild.id, interaction.user.id, event)], components: eventButtonRows(event.id), ephemeral: true });
      }

      if (action === 'leaderboard') {
        return interaction.reply({ embeds: [await eventLeaderboardEmbed(interaction.guild.id, interaction.user.id, event)], components: eventButtonRows(event.id), ephemeral: true });
      }
    }

    if (id === 'champ:register') {
      if (!(await memberHasGarageRole(interaction.guild.id, interaction.member))) {
        return interaction.reply({ content: '❌ Championship registration is available only to members with the configured Garage Role.', ephemeral: true });
      }
      const season = await game.activeSeason(interaction.guild.id);
      if (!season) return interaction.reply({ content: '⏳ There is no active Season right now.', ephemeral: true });
      let champ = await activeChampionship(interaction.guild.id, season.id);
      if (!champ) champ = await createChampionship(interaction.guild, season);
      if (champ.status !== 'registration') return interaction.reply({ content: '🏆 Championship registration is closed because the Championship has already started.', ephemeral: true });
      if (await sb.from('championship_players').select('id').eq('championship_id', champ.id).eq('user_id', interaction.user.id).eq('stage', 1).maybeSingle().then(x => x.data)) {
        return interaction.reply({ content: '✅ You are already registered for this Championship.', ephemeral: true });
      }
      if (!(await eligibleForRegistration(interaction.guild.id, interaction.user.id))) {
        return interaction.reply({ content: '❌ You need to select a race vehicle first. Use `?setasracecar <vehicle ID>`.', ephemeral: true });
      }

      const count = await registrationCount(champ.id);
      if (count >= 48) {
        await startChampionship(interaction.guild, champ);
        return interaction.reply({ content: '🏆 Registration just reached 48/48. The Championship is starting now!', ephemeral: true });
      }

      const ins = await sb.from('championship_players').insert({
        championship_id: champ.id,
        user_id: interaction.user.id,
        stage: 1,
        points: 0,
        wins: 0,
        losses: 0,
        races: 0,
        eliminated: false
      });
      if (ins.error) {
        if (String(ins.error.message || '').toLowerCase().includes('duplicate') || String(ins.error.code || '') === '23505') {
          return interaction.reply({ content: '✅ You are already registered for this Championship.', ephemeral: true });
        }
        throw ins.error;
      }

      const after = await registrationCount(champ.id);
      if (after >= 48) {
        await startChampionship(interaction.guild, champ);
        return interaction.update({
          embeds: [new EmbedBuilder().setTitle('🏆 CHAMPIONSHIP STARTING').setDescription('**48/48 registrations complete!**\n\nThe Championship has started. Your Stage 1 schedule will be posted automatically.')],
          components: []
        });
      }

      const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
      return interaction.update({ embeds: [data.embed], components: championshipRows(data.champ, data.registered, data.userRegistered) });
    }

    if (id === 'champ:status') {
      const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
      if (!data.champ || data.champ.status === 'registration') {
        return interaction.reply({ content: data.userRegistered ? '✅ You are registered.' : 'ℹ️ You are not registered yet. Press **🏁 Register** on the Championship panel.', ephemeral: true });
      }
      const rows = await standings(data.champ, data.champ.stage);
      const mine = rows.find(x => String(x.user_id) === String(interaction.user.id));
      if (!mine) return interaction.reply({ content: '❌ You are not in the current Championship stage.', ephemeral: true });
      const pos = rows.findIndex(x => x.id === mine.id) + 1;
      const q = await sb.from('championship_matches').select('*').eq('championship_id', data.champ.id).eq('stage', data.champ.stage).or(`racer_a.eq.${interaction.user.id},racer_b.eq.${interaction.user.id}`).order('scheduled_at').limit(50);
      if (q.error) throw q.error;
      const upcoming = (q.data || []).filter(m => m.status === 'scheduled').slice(0, 3).map(m => `🏁 #${m.match_no} • <@${m.racer_a}> 🆚 <@${m.racer_b}> • <t:${Math.floor(new Date(m.scheduled_at).getTime() / 1000)}:R>`).join('\n') || 'No upcoming matches yet.';
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('👤 MY CHAMPIONSHIP STATUS').setDescription(
          `🏆 Stage: **${data.champ.stage}**\n` +
          `📊 Position: **#${pos}/${rows.length}**\n` +
          `⭐ Points: **${mine.points}**\n` +
          `✅ Wins: **${mine.wins}**\n` +
          `❌ Losses: **${mine.losses}**\n` +
          `🏁 Races: **${mine.races}**\n\n` +
          `📅 **Upcoming matches**\n${upcoming}`
        )],
        ephemeral: true
      });
    }

    if (id === 'champ:schedule') {
      const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
      if (!data.champ || data.champ.status !== 'active') return interaction.reply({ content: '📅 The Championship schedule will appear here after the Championship starts.', ephemeral: true });
      const q = await sb.from('championship_matches').select('*').eq('championship_id', data.champ.id).eq('stage', data.champ.stage).or(`racer_a.eq.${interaction.user.id},racer_b.eq.${interaction.user.id}`).order('scheduled_at').limit(9);
      if (q.error) throw q.error;
      const text = (q.data || []).map(m => `🏁 **Match #${m.match_no}** • <@${m.racer_a}> 🆚 <@${m.racer_b}>\n🕔 <t:${Math.floor(new Date(m.scheduled_at).getTime() / 1000)}:F> • ${m.status === 'finished' ? '✅ Finished' : '⏳ Scheduled'}`).join('\n\n') || 'No matches scheduled yet.';
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📅 MY SCHEDULE • STAGE ${data.champ.stage}`).setDescription(text)], ephemeral: true });
    }

    if (id === 'champ:standings') {
      const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
      if (!data.champ || data.champ.status === 'registration') return interaction.reply({ content: '🏆 Standings will appear when the 48-player Championship starts.', ephemeral: true });
      const rows = await standings(data.champ, data.champ.stage);
      const text = rows.slice(0, 12).map((x, i) => `**#${i + 1}** <@${x.user_id}> • **${x.points} pts** • ${x.wins}W/${x.losses}L`).join('\n') || 'No standings yet.';
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🏆 STANDINGS • STAGE ${data.champ.stage}`).setDescription(text)], ephemeral: true });
    }

    if (id === 'champ:rules') {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('📜 CHAMPIONSHIP RULES').setDescription(
          '👥 **48 registered players**\n' +
          '🏁 **48 → 36 → 24 → 12 → 3**\n' +
          '🏎️ **3 PvP races per player per day**\n' +
          '⏱️ **1-hour minimum gap** between your own races\n' +
          '🎯 Race outcome starts at **50/50** and vehicle stats modify the chance\n' +
          '❗ A single loss does **not** eliminate you\n' +
          '📊 Elimination happens only at the end of each stage\n\n' +
          '💰 **Prizes**\n🥇 ₹300,000\n🥈 ₹200,000\n🥉 ₹100,000'
        )],
        ephemeral: true
      });
    }

    if (id === 'champ:refresh') {
      const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
      return interaction.update({ embeds: [data.embed], components: championshipRows(data.champ, data.registered || 0, data.userRegistered) });
    }

    if (id.startsWith('season:')) {
      const section = id === 'season:refresh' ? 'overview' : id.slice('season:'.length);
      if (section === 'championship') {
        const data = await championshipDashboard(interaction.guild.id, interaction.user.id);
        return interaction.update({ embeds: [data.embed], components: championshipRows(data.champ, data.registered || 0, data.userRegistered) });
      }
      const data = await seasonDashboard(interaction.guild.id, interaction.user.id, section);
      return interaction.update({ embeds: [data.embed], components: seasonRows() });
    }
  } catch (e) {
    console.error('Competitive button error:', e);
    return interaction.reply({ content: `❌ Competitive UI error: ${e.message}`, ephemeral: true }).catch(() => {});
  }

  return false;
}

module.exports = {
  startCompetitiveAutomation,
  handleCommand,
  handleButton
};
