const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const game = require('./game');

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

function isoAtDay(base, dayOffset, hour) {
  const d = new Date(base.getTime() + dayOffset * DAY_MS);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
  const get = t => parts.find(x => x.type === t).value;
  return new Date(`${get('year')}-${get('month')}-${get('day')}T${String(hour).padStart(2,'0')}:00:00+05:30`);
}

function stageFor(elapsedDay) {
  if (elapsedDay < 7) return 1;
  if (elapsedDay < 14) return 2;
  if (elapsedDay < 21) return 3;
  return 4;
}

function stageDay(champ, now = new Date()) {
  return Math.floor((now - new Date(champ.stage_started_at)) / DAY_MS) + 1;
}

async function competitionChannel(guild) {
  const id = config.competitionChannelId;
  if (id) {
    const c = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (c?.isTextBased()) return c;
  }
  return guild.systemChannel || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages')) || null;
}

async function announce(guild, title, description) {
  const channel = await competitionChannel(guild);
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp()] }).catch(() => {});
}

async function activeChampionship(guildId, seasonId) {
  const q = await sb.from('championships').select('*').eq('guild_id', guildId).eq('season_id', seasonId).in('status', ['active','finished']).order('created_at', { ascending:false }).limit(1).maybeSingle();
  if (q.error) throw q.error;
  return q.data;
}

async function eligiblePlayers(guildId) {
  const q = await sb.from('game_profiles').select('user_id,race_vehicle_id,driver_xp').eq('guild_id', guildId).not('race_vehicle_id','is',null).order('driver_xp',{ascending:false}).limit(200);
  if (q.error) throw q.error;
  return (q.data || []).map(x => String(x.user_id));
}

function shuffle(list) {
  const a = [...list];
  for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

async function createChampionship(guild, season) {
  const existing = await activeChampionship(guild.id, season.id);
  if (existing) return existing;
  const players = (await eligiblePlayers(guild.id)).slice(0,48);
  if (players.length < 48) return null;
  const now = new Date();
  const ends = new Date(now.getTime() + 30 * DAY_MS);
  const ins = await sb.from('championships').insert({
    guild_id:guild.id, season_id:season.id, status:'active', stage:1,
    stage_started_at:now.toISOString(), stage_ends_at:new Date(now.getTime()+7*DAY_MS).toISOString(),
    starts_at:now.toISOString(), ends_at:ends.toISOString()
  }).select().single();
  if (ins.error) throw ins.error;
  const rows = players.map(user_id => ({ championship_id:ins.data.id, user_id, stage:1, points:0, wins:0, losses:0, races:0, eliminated:false }));
  const pr = await sb.from('championship_players').insert(rows);
  if (pr.error) throw pr.error;
  await announce(guild,'🏆 CHAMPIONSHIP STARTED',`**48 drivers** have entered the 30-day Championship.\n\n🏁 Stage 1: **48 → 36**\n📅 Races are scheduled automatically every day.\n🏎️ **3 PvP races per player per day**\n⏱️ Minimum **1 hour** between a player's races.\n\n❗ A single loss never directly eliminates a player.`);
  return ins.data;
}

async function stagePlayers(champ, stage) {
  const q = await sb.from('championship_players').select('*').eq('championship_id',champ.id).eq('stage',stage).eq('eliminated',false).order('points',{ascending:false}).order('wins',{ascending:false}).order('races',{ascending:false});
  if (q.error) throw q.error;
  return q.data || [];
}

async function hasMatchForDay(champId, stage, dayNo) {
  const q = await sb.from('championship_matches').select('id').eq('championship_id',champId).eq('stage',stage).eq('day_no',dayNo).limit(1);
  if (q.error) throw q.error;
  return Boolean(q.data?.length);
}

async function scheduleDay(guild, champ, dayNo) {
  const stage = champ.stage;
  if (dayNo < 1 || dayNo > STAGE_DAYS[stage-1]) return;
  if (await hasMatchForDay(champ.id,stage,dayNo)) return;
  const players = (await stagePlayers(champ,stage)).map(x=>String(x.user_id));
  if (!players.length) return;
  const shuffled = shuffle(players);
  const base = new Date(champ.stage_started_at);
  const groups = [[],[],[]];
  // Each player gets exactly one match in each round. With an even field this
  // creates 3 matches per player per day and guarantees a one-hour gap.
  for (let round=0; round<3; round++) {
    const rotated = shuffled.slice();
    const offset = (round * 2) % Math.max(2, rotated.length);
    const left = rotated.slice(offset).concat(rotated.slice(0,offset));
    for (let i=0;i+1<left.length;i+=2) groups[round].push([left[i],left[i+1]]);
  }
  let matchNo = 1;
  for (let round=0;round<3;round++) {
    const when = isoAtDay(base, dayNo-1, MATCH_HOURS[round]);
    for (const [a,b] of groups[round]) {
      const ins = await sb.from('championship_matches').insert({
        championship_id:champ.id, stage, day_no:dayNo, match_no:matchNo++, scheduled_at:when.toISOString(),
        racer_a:a, racer_b:b, status:'scheduled'
      });
      if (ins.error) throw ins.error;
    }
  }
  const total = groups.reduce((n,g)=>n+g.length,0);
  const channel = await competitionChannel(guild);
  if (channel) {
    await channel.send({ embeds:[new EmbedBuilder().setTitle(`📅 STAGE ${stage} — DAY ${dayNo} SCHEDULE`).setDescription(`**${total} PvP matches** are scheduled today.\n\nEach player has **3 races** with at least **1 hour between their own races**.\n❗ A single loss does not eliminate a player.`)] }).catch(()=>{});
    const lines=[];
    let n=1;
    for(let round=0;round<3;round++){
      const label = `${String(MATCH_HOURS[round]).padStart(2,'0')}:00`;
      for(const [a,b] of groups[round]) lines.push(`🏁 **Match #${n++}** • <@${a}> 🆚 <@${b}> • 🕔 **${label}**`);
    }
    for(let i=0;i<lines.length;i+=20){
      await channel.send({content:lines.slice(i,i+20).join('\n')}).catch(()=>{});
    }
  }
}

async function standings(champ, stage) {
  const rows = await stagePlayers(champ,stage);
  return rows.sort((a,b)=>Number(b.points)-Number(a.points)||Number(b.wins)-Number(a.wins)||Number(b.races)-Number(a.races)||String(a.user_id).localeCompare(String(b.user_id)));
}

async function finishStage(guild, champ) {
  const stage = champ.stage;
  const rows = await standings(champ,stage);
  const keep = STAGE_SIZES[stage];
  const nextSize = stage === 4 ? 3 : STAGE_SIZES[stage];
  if (stage < 4) {
    const qualified = rows.slice(0,keep);
    const eliminated = rows.slice(keep);
    if (eliminated.length) await sb.from('championship_players').update({eliminated:true}).in('id',eliminated.map(x=>x.id));
    const nextStage = stage+1;
    await sb.from('championship_players').insert(qualified.map(x=>({ championship_id:champ.id,user_id:x.user_id,stage:nextStage,points:0,wins:0,losses:0,races:0,eliminated:false })));
    const nextStart = new Date(champ.stage_ends_at);
    const days = STAGE_DAYS[nextStage-1];
    const nextEnd = new Date(nextStart.getTime()+days*DAY_MS);
    await sb.from('championships').update({stage:nextStage,stage_started_at:nextStart.toISOString(),stage_ends_at:nextEnd.toISOString()}).eq('id',champ.id);
    await announce(guild,`🏆 STAGE ${stage} COMPLETE`,`🟢 **${keep} players qualified**\n🔴 **${eliminated.length} players eliminated**\n\nNext stage: **${keep} → ${nextSize === 3 ? 3 : nextSize}**\n📅 The next daily schedule will be generated automatically.`);
    return;
  }
  const top = rows.slice(0,3);
  await sb.from('championship_players').update({eliminated:true}).in('id',rows.slice(3).map(x=>x.id));
  const prizes=[300000,200000,100000];
  for (let i=0;i<top.length;i++) {
    const r=top[i];
    await sb.from('championship_players').update({final_position:i+1,final_prize:prizes[i]}).eq('id',r.id);
    await game.changeBalance?.(guild.id,r.user_id,prizes[i],'championship_prize',champ.id,{position:i+1},false).catch(()=>{});
  }
  await sb.from('championships').update({status:'finished',winner_user_id:top[0]?.user_id||null,finished_at:new Date().toISOString()}).eq('id',champ.id);
  await announce(guild,'🏆 CHAMPIONSHIP COMPLETE',`After 30 days, the final three drivers are:\n\n🥇 <@${top[0]?.user_id}> — **₹300,000**\n🥈 <@${top[1]?.user_id}> — **₹200,000**\n🥉 <@${top[2]?.user_id}> — **₹100,000**\n\n🏁 **48 → 36 → 24 → 12 → 3**`);
}

async function resolveMatch(guild, match) {
  if (match.status !== 'scheduled' || new Date(match.scheduled_at) > new Date()) return;
  const a = await guild.members.fetch(match.racer_a).catch(()=>null);
  const b = await guild.members.fetch(match.racer_b).catch(()=>null);
  if (!a || !b) {
    const winnerId = a && !b ? match.racer_a : (!a && b ? match.racer_b : null);
    if (winnerId) {
      const loserId = winnerId === match.racer_a ? match.racer_b : match.racer_a;
      const wp = await sb.from('championship_players').select('*').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',winnerId).single();
      const lp = await sb.from('championship_players').select('*').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',loserId).single();
      if (!wp.error && !lp.error) {
        await sb.from('championship_players').update({points:Number(wp.data.points||0)+3,wins:Number(wp.data.wins||0)+1,races:Number(wp.data.races||0)+1}).eq('id',wp.data.id);
        await sb.from('championship_players').update({losses:Number(lp.data.losses||0)+1,races:Number(lp.data.races||0)+1}).eq('id',lp.data.id);
      }
      await sb.from('championship_matches').update({status:'forfeit',winner:winnerId,loser:loserId,result_note:'Forfeit: one scheduled player was unavailable.',finished_at:new Date().toISOString()}).eq('id',match.id);
      await announce(guild,'⚠️ MATCH FORFEIT',`<@${winnerId}> receives the scheduled win because the opponent was unavailable.\n\n❗ A forfeit does not directly eliminate a player.`);
    } else {
      await sb.from('championship_matches').update({status:'forfeit',result_note:'Both scheduled players were unavailable.',finished_at:new Date().toISOString()}).eq('id',match.id);
    }
    return;
  }
  const result = await game.runRace(guild,a,'race',b,{noRewards:true,competition:true});
  if (result.error) {
    await sb.from('championship_matches').update({status:'forfeit',result_note:result.error}).eq('id',match.id);
    return;
  }
  const winner = result.winnerId, loser = result.loserId;
  // Stage points: 3 for a win, 1 for a loss. Opponent strength adds a small
  // bonus so players cannot farm only weak opponents.
  const oppA = await sb.from('championship_players').select('points,wins,losses,races').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',match.racer_b).maybeSingle();
  const oppB = await sb.from('championship_players').select('points,wins,losses,races').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',match.racer_a).maybeSingle();
  const strengthA = Number(oppA.data?.points||0);
  const strengthB = Number(oppB.data?.points||0);
  const winPts = 3 + Math.max(0, Math.min(2, Math.floor(strengthA / 10)));
  const losePts = 1 + Math.max(0, Math.min(1, Math.floor(strengthB / 15)));
  const p1 = await sb.from('championship_players').select('*').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',match.racer_a).single();
  const p2 = await sb.from('championship_players').select('*').eq('championship_id',match.championship_id).eq('stage',match.stage).eq('user_id',match.racer_b).single();
  if (p1.error || p2.error) throw p1.error || p2.error;
  const aWon = winner === match.racer_a;
  const u1={points:Number(p1.data.points||0)+(aWon?winPts:losePts),wins:Number(p1.data.wins||0)+(aWon?1:0),losses:Number(p1.data.losses||0)+(aWon?0:1),races:Number(p1.data.races||0)+1};
  const u2={points:Number(p2.data.points||0)+(aWon?losePts:winPts),wins:Number(p2.data.wins||0)+(aWon?0:1),losses:Number(p2.data.losses||0)+(aWon?1:0),races:Number(p2.data.races||0)+1};
  await sb.from('championship_players').update(u1).eq('id',p1.data.id);
  await sb.from('championship_players').update(u2).eq('id',p2.data.id);
  await sb.from('championship_matches').update({status:'finished',finished_at:new Date().toISOString(),winner: winner,loser: loser,win_chance_a:result.chanceA,win_chance_b:result.chanceB}).eq('id',match.id);
  await announce(guild,'🏁 MATCH RESULT',`**Match #${match.match_no}**\n<@${match.racer_a}> 🆚 <@${match.racer_b}>\n\n🏆 Winner: <@${winner}>\n📊 Win chance: **${result.chanceA}% — ${result.chanceB}%**\n🚗 ${result.vehicleA.name} 🆚 ${result.vehicleB.name}\n\n❗ A single loss does **not** eliminate a player.`);
}

async function tickGuild(guild) {
  const season = await game.activeSeason(guild.id);
  if (!season || !season.active) return;
  let champ = await activeChampionship(guild.id,season.id);
  if (!champ) champ = await createChampionship(guild,season);
  if (!champ || champ.status !== 'active') return;
  const now = new Date();
  const elapsed = Math.floor((now - new Date(champ.starts_at))/DAY_MS);
  const expectedStage = stageFor(elapsed);
  if (expectedStage > champ.stage) {
    await finishStage(guild,champ);
    champ = await activeChampionship(guild.id,season.id);
    if (!champ || champ.status !== 'active') return;
  }
  const d = stageDay(champ,now);
  if (d >= 1 && d <= STAGE_DAYS[champ.stage-1]) await scheduleDay(guild,champ,d);
  const q = await sb.from('championship_matches').select('*').eq('championship_id',champ.id).eq('status','scheduled').lte('scheduled_at',now.toISOString()).order('scheduled_at').limit(50);
  if (q.error) throw q.error;
  for (const match of q.data||[]) await resolveMatch(guild,match);
}

async function startCompetitiveAutomation(client) {
  if (started.size) return;
  const tick = async()=>{ for(const guild of client.guilds.cache.values()){ try{ await tickGuild(guild); }catch(e){ console.error(`Competitive automation failed for ${guild.id}:`,e.message); } } };
  await tick();
  const timer=setInterval(tick,60*1000); timer.unref?.(); started.add('running');
}

async function handleCommand(message) {
  const cmd = String(message.content||'').trim().split(/\s+/)[0]?.toLowerCase();
  if (!['?championship','?champ','?season'].includes(cmd)) return false;
  const sub = String(message.content||'').trim().split(/\s+/)[1]?.toLowerCase() || 'status';
  const season = await game.activeSeason(message.guild.id);
  if (!season) return message.reply('⏳ No active Season is available yet.');
  const champ = await activeChampionship(message.guild.id,season.id);
  if (sub==='status' || sub==='schedule') {
    if (!champ) return message.reply('🏆 Championship has not started yet. It will start automatically when 48 eligible players are available.');
    const rows=await standings(champ,champ.stage);
    const top=rows.slice(0,10).map((x,i)=>`**${i+1}.** <@${x.user_id}> • ${x.points} pts • ${x.wins}W/${x.losses}L`).join('\n');
    return message.reply({embeds:[new EmbedBuilder().setTitle(`🏆 CHAMPIONSHIP • STAGE ${champ.stage}`).setDescription(`📅 Stage day: **${Math.max(1,stageDay(champ))}/${STAGE_DAYS[champ.stage-1]}**\n👥 Players: **${rows.length}**\n\n${top||'No standings yet.'}`)]});
  }
  if (sub==='help') return message.reply('🏆 `?championship status` • View current stage\n📅 `?championship schedule` • View current standings');
  return message.reply('🏆 Use `?championship status` or `?championship schedule`.');
}

module.exports={startCompetitiveAutomation,handleCommand};
