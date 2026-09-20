const { createClient } = require('@supabase/supabase-js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const config = require('./config');
const { vehicles } = require('./vehicles');
const legacyDb = require('./db');

const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const pendingBets = new Map();
const pendingTrades = new Map();
const pendingSales = new Map();
const pendingListings = new Map();

const rarityNames = ['COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','MYTHIC','EXCLUSIVE'];
const classNames = ['D','C','B','A','S','S+','X'];
const upgradeBase = { engine:5, turbo:8, ecu:4, transmission:5, suspension:4, brakes:5, tires:4, weight:4 };
const missionDefs = [
  ['races','Complete 5 races',5,50000],
  ['wins','Win 3 races',3,75000],
  ['earn','Earn ₹50000',50000,60000],
  ['upgrade','Upgrade a vehicle',1,30000],
  ['rare','Use a Rare+ vehicle',1,40000]
];
const achievementDefs = {
  first_vehicle:['First Vehicle','Own your first vehicle'], first_race:['First Race','Complete your first race'], first_win:['First Win','Win your first race'],
  millionaire:['Millionaire','Reach ₹1,000,000'], wins10:['10 Wins','Win 10 races'], wins50:['50 Wins','Win 50 races'], wins100:['100 Wins','Win 100 races'],
  supercar:['Supercar Collector','Own 5 high-performance cars'], legendary:['Legendary Collector','Own a Legendary vehicle'], fullgarage:['Full Garage',`Own all ${vehicles.length} vehicles`],
  speed:['Speed Demon','Own a vehicle above 300 km/h'], master:['Master Racer','Complete 100 races']
};

function meta(v) {
  const i=v.id;
  const rarity = i<=15?'COMMON':i<=30?'UNCOMMON':i<=50?'RARE':i<=70?'EPIC':i<=90?'LEGENDARY':i<=105?'MYTHIC':'EXCLUSIVE';
  const cls = i<=15?'D':i<=30?'C':i<=50?'B':i<=70?'A':i<=90?'S':i<=105?'S+':'X';
  const power=Math.round(25+i*5.2), speed=Math.round(55+i*3.15), accel=40+(i%30), handling=40+((i*7)%58), braking=35+((i*9)%60), weight=Math.max(850,1900-i*7), launch=35+((i*11)%60);
  const performance=Math.round((power/3+speed/3+accel+handling+braking+launch)/4);
  const price=Math.round(15000*Math.pow(1.075,i-1)/1000)*1000;
  return {...v, rarity, class:cls, power, topSpeed:speed, acceleration:accel, handling, braking, weight, launch, performance, price};
}
const V = vehicles.map(meta);

function money(n){ return `₹${Math.max(0,Math.floor(Number(n)||0)).toLocaleString('en-IN')}`; }
function levelForXp(xp){ return Math.max(1,Math.floor(Math.sqrt(Math.max(0,xp)/100))+1); }
function todayKey(){ return new Date().toISOString().slice(0,10); }
function findVehicle(q){
  const s=String(q||'').trim().toLowerCase();
  if(!s) return null;
  const id=Number(s.replace(/^#/,''));
  if(Number.isInteger(id)&&id>=1&&id<=V.length) return V[id-1];
  return V.find(v=>v.name.toLowerCase()===s) || V.find(v=>v.name.toLowerCase().includes(s));
}
function vehicleImage(v){ return path.join(__dirname,v.image); }

async function profile(guildId,userId){
  let {data,error}=await sb.from('game_profiles').select('*').eq('guild_id',guildId).eq('user_id',userId).maybeSingle();
  if(error) throw error;
  if(!data){
    const row={guild_id:guildId,user_id:userId,balance:100000,driver_xp:0,driver_level:1,daily_streak:0,daily_claimed_on:null,active_vehicle_id:null};
    const r=await sb.from('game_profiles').insert(row).select().single();
    if(r.error) throw r.error;
    data=r.data;
  }
  return data;
}

async function vehiclesOf(guildId,userId){
  const r=await sb.from('user_vehicles').select('*').eq('guild_id',guildId).eq('user_id',userId).order('vehicle_id');
  if(r.error) throw r.error;
  return r.data||[];
}

async function own(guildId,userId,v){
  const r=await sb.from('user_vehicles').select('*').eq('guild_id',guildId).eq('user_id',userId).eq('vehicle_id',v.id).maybeSingle();
  if(r.error) throw r.error;
  return r.data;
}

async function tx(guildId,userId,type,amount,reference,metadata={}){
  const r=await sb.from('transactions').insert({guild_id:guildId,user_id:userId,type,amount,reference,metadata});
  if(r.error) throw r.error;
}

async function changeBalance(guildId,userId,delta,type,reference,metadata={}){
  const p=await profile(guildId,userId);
  const next=Number(p.balance)+Number(delta);
  if(next<0) throw new Error('INSUFFICIENT_FUNDS');
  const r=await sb.from('game_profiles').update({balance:next,updated_at:new Date().toISOString()}).eq('guild_id',guildId).eq('user_id',userId);
  if(r.error) throw r.error;
  await tx(guildId,userId,type,delta,reference,metadata);
  return next;
}

async function addXp(guildId,userId,delta){
  const p=await profile(guildId,userId);
  const xp=Number(p.driver_xp)+Math.max(0,delta);
  const level=levelForXp(xp);
  const r=await sb.from('game_profiles').update({driver_xp:xp,driver_level:level,updated_at:new Date().toISOString()}).eq('guild_id',guildId).eq('user_id',userId);
  if(r.error) throw r.error;
  return {xp,level};
}

function progressionCountFromActivity(legacyUser){
  const hours=Number(legacyUser?.vc_seconds||0)/3600;
  const messages=Number(legacyUser?.messages||0);
  let count=0;
  for(const v of V){
    if(hours>=Number(v.vcHours||0) && messages>=Number(v.messages||0)) count++;
    else break;
  }
  return count;
}

// Repairs the old V2 migration bug without treating vehicle_index as ownership.
// Existing rows created by the broken migration are reduced to the player's real
// activity-unlocked count. Future ownership is explicitly tagged by source.
async function repairLegacyGarage(guildId,userId){
  const legacy=legacyDb.getUser(userId,guildId);
  const rows=await vehiclesOf(guildId,userId);
  const legacyIndex=Math.max(0,Number(legacy?.vehicle_index||0));
  const allowed=progressionCountFromActivity(legacy);

  // The old system stored an unlock counter, not garage ownership. If that
  // counter got ahead of the real activity requirements, bring it back to the
  // sequential progression boundary. This prevents the old while-loop bug from
  // permanently unlocking the whole collection.
  if(legacyIndex>allowed){
    legacyDb.setVehicleIndex(userId,guildId,allowed);
  }

  if(!rows.length){
    if(allowed>0){
      for(let i=1;i<=allowed;i++) await grantProgressionVehicle(guildId,userId,i);
      return {rows:await vehiclesOf(guildId,userId),changed:allowed>0};
    }
    return {rows:[],changed:legacyIndex!==allowed};
  }

  // If the old migration populated the garage from vehicle_index, the row count
  // will be roughly the old unlock counter. In that case keep only vehicles that
  // are actually justified by current progression. Future purchases/listings are
  // explicitly tagged and therefore won't trigger this repair path.
  const sources=rows.map(r=>String(r.source||'legacy'));
  const allLegacyLike=sources.every(s=>s==='legacy' || s==='progression' || s==='');
  const suspicious = allLegacyLike && legacyIndex>0 && rows.length>=Math.min(legacyIndex,V.length) && rows.length>1;
  if(!suspicious) return {rows,changed:legacyIndex!==allowed};

  const keepIds=new Set(V.slice(0,allowed).map(v=>v.id));
  const remove=rows.filter(r=>!keepIds.has(Number(r.vehicle_id)));
  if(remove.length){
    const ids=remove.map(r=>r.id).filter(Boolean);
    if(ids.length){ const r=await sb.from('user_vehicles').delete().in('id',ids); if(r.error) throw r.error; }
  }
  for(let i=1;i<=allowed;i++){
    if(!rows.some(r=>Number(r.vehicle_id)===i)) await grantProgressionVehicle(guildId,userId,i);
  }
  const p=await profile(guildId,userId);
  if(p.active_vehicle_id && !keepIds.has(Number(p.active_vehicle_id))) await sb.from('game_profiles').update({active_vehicle_id:allowed?1:null}).eq('guild_id',guildId).eq('user_id',userId);
  return {rows:await vehiclesOf(guildId,userId),changed:true};
}

async function grantProgressionVehicle(guildId,userId,vehicleId){
  const v=V[vehicleId-1];
  if(!v) return false;
  const existing=await own(guildId,userId,v);
  if(existing) return false;
  const r=await sb.from('user_vehicles').insert({guild_id:guildId,user_id:userId,vehicle_id:v.id,source:'progression',condition:100,level:1,xp:0,upgrades:{},custom:{}});
  if(r.error && !String(r.error.message).toLowerCase().includes('duplicate')) throw r.error;
  const p=await profile(guildId,userId);
  if(!p.active_vehicle_id) await sb.from('game_profiles').update({active_vehicle_id:v.id}).eq('guild_id',guildId).eq('user_id',userId);
  await unlockAchievement(guildId,userId,'first_vehicle');
  return true;
}

async function acquire(guildId,userId,v,source='purchase'){
  const r=await sb.from('user_vehicles').insert({guild_id:guildId,user_id:userId,vehicle_id:v.id,source,condition:100,level:1,xp:0,upgrades:{},custom:{}});
  if(r.error && !String(r.error.message).toLowerCase().includes('duplicate')) throw r.error;
  const p=await profile(guildId,userId);
  if(!p.active_vehicle_id) await sb.from('game_profiles').update({active_vehicle_id:v.id}).eq('guild_id',guildId).eq('user_id',userId);
}

function vehicleStats(v,u){
  const up=u?.upgrades||{};
  return {
    power:v.power+(up.engine||0)*5+(up.turbo||0)*2+(up.ecu||0),
    speed:v.topSpeed+(up.engine||0)*2+(up.transmission||0)*2,
    accel:v.acceleration+(up.turbo||0)*3+(up.transmission||0),
    handling:v.handling+(up.suspension||0)*2+(up.tires||0),
    braking:v.braking+(up.brakes||0)*2+(up.tires||0),
    launch:v.launch+(up.engine||0)+(up.transmission||0)
  };
}
function raceScore(v,u,type){
  const s=vehicleStats(v,u); const cond=(Number(u?.condition??100))/100;
  if(type==='drag') return (s.launch*2+s.accel*2+s.power+s.speed*.5)*cond;
  if(type==='track') return (s.handling*2+s.braking*2+s.accel+s.speed*.3)*cond;
  return (s.power+s.speed+s.accel+s.handling+s.braking+s.launch)*cond;
}

async function updateMission(guildId,userId,key,amount=1){
  const period=todayKey(); const def=missionDefs.find(x=>x[0]===key); if(!def) return;
  const [mission_key,,target,reward]=def;
  let r=await sb.from('missions').select('*').eq('guild_id',guildId).eq('user_id',userId).eq('mission_key',mission_key).eq('period_key',period).maybeSingle();
  if(r.error) throw r.error;
  if(!r.data){
    r=await sb.from('missions').insert({guild_id:guildId,user_id:userId,mission_key,progress:0,target,reward,period_key:period,completed:false}).select().single();
    if(r.error) throw r.error;
  }
  const m=r.data; if(m.completed) return;
  const progress=Math.min(Number(target),Number(m.progress)+Math.max(0,Number(amount)||0));
  const completed=progress>=Number(target);
  r=await sb.from('missions').update({progress,completed}).eq('id',m.id);
  if(r.error) throw r.error;
  if(completed){ await changeBalance(guildId,userId,reward,'mission_reward',mission_key); await addXp(guildId,userId,100); }
}

async function ensureDailyMissions(guildId,userId){
  const period=todayKey();
  for(const d of missionDefs){
    const [mission_key,,target,reward]=d;
    const r=await sb.from('missions').select('id').eq('guild_id',guildId).eq('user_id',userId).eq('mission_key',mission_key).eq('period_key',period).maybeSingle();
    if(r.error) throw r.error;
    if(!r.data){
      const ins=await sb.from('missions').insert({guild_id:guildId,user_id:userId,mission_key,progress:0,target,reward,period_key:period,completed:false});
      if(ins.error && !String(ins.error.message).toLowerCase().includes('duplicate')) throw ins.error;
    }
  }
}

async function unlockAchievement(guildId,userId,key){
  if(!achievementDefs[key]) return;
  const r=await sb.from('achievements').insert({guild_id:guildId,user_id:userId,achievement_key:key});
  if(r.error && !String(r.error.message).toLowerCase().includes('duplicate')) throw r.error;
}
async function checkAchievements(guildId,userId){
  const p=await profile(guildId,userId), owneds=await vehiclesOf(guildId,userId);
  const races=await sb.from('races').select('*').eq('guild_id',guildId).or(`racer_a.eq.${userId},racer_b.eq.${userId}`);
  if(races.error) throw races.error;
  const rr=races.data||[], wins=rr.filter(r=>r.winner===userId).length;
  if(owneds.length>=1) await unlockAchievement(guildId,userId,'first_vehicle');
  if(rr.length>=1) await unlockAchievement(guildId,userId,'first_race');
  if(wins>=1) await unlockAchievement(guildId,userId,'first_win');
  if(Number(p.balance)>=1000000) await unlockAchievement(guildId,userId,'millionaire');
  if(wins>=10) await unlockAchievement(guildId,userId,'wins10');
  if(wins>=50) await unlockAchievement(guildId,userId,'wins50');
  if(wins>=100) await unlockAchievement(guildId,userId,'wins100');
  if(owneds.length>=V.length) await unlockAchievement(guildId,userId,'fullgarage');
  if(owneds.some(x=>V[x.vehicle_id-1]?.rarity==='LEGENDARY')) await unlockAchievement(guildId,userId,'legendary');
  if(owneds.filter(x=>V[x.vehicle_id-1]?.performance>=150).length>=5) await unlockAchievement(guildId,userId,'supercar');
  if(rr.length>=100) await unlockAchievement(guildId,userId,'master');
  if(owneds.some(x=>V[x.vehicle_id-1]?.topSpeed>=300)) await unlockAchievement(guildId,userId,'speed');
}

async function buy(guild,member,arg){
  const v=findVehicle(arg); if(!v) return '❌ Vehicle not found. Use `?dealership` or `?buy <vehicle number/name>`.';
  const p=await profile(guild.id,member.id); const existing=await own(guild.id,member.id,v);
  if(existing) return `❌ You already own **${v.name}**.`;
  if(Number(p.balance)<v.price) return `❌ You need ${money(v.price)} but have ${money(p.balance)}.`;
  await changeBalance(guild.id,member.id,-v.price,'vehicle_purchase',String(v.id),{vehicle:v.name});
  await acquire(guild.id,member.id,v,'purchase');
  await checkAchievements(guild.id,member.id);
  return `🎉 ${member} bought **${v.name}** for **${money(v.price)}**! It is now in your garage.`;
}

function dealershipEmbed(page=0){
  const per=5,total=Math.ceil(V.length/per),p=Math.max(0,Math.min(page,total-1)); const slice=V.slice(p*per,p*per+per);
  return new EmbedBuilder().setTitle('🏪 VEHICLE LIFE DEALERSHIP').setDescription(slice.map(v=>`**#${v.id} ${v.name}** • ${v.rarity} • Class ${v.class}\n💰 ${money(v.price)} • ⚡ ${v.performance}`).join('\n\n')).setFooter({text:`Page ${p+1}/${total} • ?buy <vehicle>`});
}

async function resolveRaceVehicle(guildId,userId,arg){
  const p=await profile(guildId,userId); const owneds=await vehiclesOf(guildId,userId);
  if(!owneds.length) return null;
  if(arg){ const v=findVehicle(arg); if(v){ const o=owneds.find(x=>Number(x.vehicle_id)===v.id); if(o) return {v,o}; return {error:`❌ You do not own **${v.name}**.`}; } }
  const o=owneds.find(x=>Number(x.vehicle_id)===Number(p.active_vehicle_id))||owneds[0];
  return {v:V[o.vehicle_id-1],o};
}

async function doRace(guild,member,arg,type='race',opponentMember=null){
  const selected=await resolveRaceVehicle(guild.id,member.id,arg); if(!selected) return '❌ You need a vehicle first. Use `?dealership` and `?buy <vehicle>`.'; if(selected.error) return selected.error;
  const {v, o:active}=selected; if(Number(active.condition)<=0) return '❌ This vehicle is at 0% condition. Repair it first.';
  if(opponentMember){
    const opp=await resolveRaceVehicle(guild.id,opponentMember.id,''); if(!opp) return `❌ ${opponentMember} has no vehicle.`;
    if(opp.error) return opp.error;
    if(Number(opp.o.condition)<=0) return `❌ ${opponentMember}'s vehicle needs repair.`;
    const bv=opp.v, bOwner=opp.o;
    const sa=raceScore(v,active,type), sbv=raceScore(bv,bOwner,type);
    const winner=sa>=sbv?member:opponentMember;
    const loser=winner.id===member.id?opponentMember:member;
    const winVehicle=winner.id===member.id?v:bv;
    const wa=Math.max(8,60-sa/10+(Math.random()*2)), wb=Math.max(8,60-sbv/10+(Math.random()*2));
    await changeBalance(guild.id,winner.id,5000,'race_reward',type);
    await addXp(guild.id,winner.id,100); await addXp(guild.id,loser.id,25);
    await updateMission(guild.id,winner.id,'wins'); await updateMission(guild.id,member.id,'races'); await updateMission(guild.id,opponentMember.id,'races');
    await sb.from('user_vehicles').update({condition:Math.max(0,Number(active.condition)-2)}).eq('id',active.id);
    await sb.from('user_vehicles').update({condition:Math.max(0,Number(bOwner.condition)-4)}).eq('id',bOwner.id);
    const r=await sb.from('races').insert({guild_id:guild.id,racer_a:member.id,racer_b:opponentMember.id,vehicle_a:v.id,vehicle_b:bv.id,type,winner:winner.id,stake:0,pot:5000,time_a:wa,time_b:wb,status:'finished'}).select().single(); if(r.error) throw r.error;
    await checkAchievements(guild.id,member.id); await checkAchievements(guild.id,opponentMember.id);
    return `🏁 **${type.toUpperCase()}**\n${member} **${v.name}** vs ${opponentMember} **${bv.name}**\n🏆 Winner: ${winner} (${winVehicle.name})\n💰 ${money(5000)} reward\n⏱️ ${wa.toFixed(2)}s vs ${wb.toFixed(2)}s`;
  }
  const score=raceScore(v,active,type), time=Math.max(8,60-score/10+(Math.random()*3));
  await sb.from('user_vehicles').update({condition:Math.max(0,Number(active.condition)-2)}).eq('id',active.id);
  await changeBalance(guild.id,member.id,2500,'race_reward',type); await addXp(guild.id,member.id,50); await updateMission(guild.id,member.id,'races');
  const r=await sb.from('races').insert({guild_id:guild.id,racer_a:member.id,vehicle_a:v.id,type,winner:member.id,stake:0,pot:2500,time_a:time,status:'finished'}).select().single(); if(r.error) throw r.error;
  await checkAchievements(guild.id,member.id);
  return `🏁 **${type.toUpperCase()} COMPLETE**\n🚗 ${v.name}\n⏱️ Time: **${time.toFixed(2)}s**\n💰 Reward: **${money(2500)}**\n🧑‍✈️ +50 Driver XP\n🛠️ Condition: **${Math.max(0,Number(active.condition)-2)}%**`;
}

function formatWhen(start,end){
  const a=start?new Date(start).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'Now';
  const b=end?new Date(end).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'Open';
  return `${a} → ${b}`;
}

async function ensureLiveWorld(guildId){
  const now=new Date();
  const seasonR=await sb.from('seasons').select('*').eq('guild_id',guildId).eq('active',true).order('season_no',{ascending:false}).limit(1).maybeSingle(); if(seasonR.error) throw seasonR.error;
  let season=seasonR.data;
  if(!season || !season.ends_at || new Date(season.ends_at)<=now){
    if(season?.id) await sb.from('seasons').update({active:false}).eq('id',season.id);
    const latest=await sb.from('seasons').select('season_no').eq('guild_id',guildId).order('season_no',{ascending:false}).limit(1).maybeSingle(); if(latest.error) throw latest.error;
    const no=Number(latest.data?.season_no||0)+1, starts=now.toISOString(), ends=new Date(now.getTime()+30*86400000).toISOString();
    const ins=await sb.from('seasons').insert({guild_id:guildId,season_no:no,name:`Season ${no} • Road to Glory`,active:true,starts_at:starts,ends_at:ends}).select().single(); if(ins.error) throw ins.error; season=ins.data;
  }
  const close=await sb.from('events').update({status:'closed'}).eq('guild_id',guildId).eq('status','open').lt('ends_at',now.toISOString()); if(close.error) throw close.error;
  const openR=await sb.from('events').select('*').eq('guild_id',guildId).eq('status','open').order('starts_at'); if(openR.error) throw openR.error;
  const open=openR.data||[];
  const templates=[
    {name:'Daily Sprint',description:'Complete races today and earn bonus Vehicle Life rewards.',entry_fee:0,hours:24,rewards:{cash:25000,xp:150}},
    {name:'Garage Rush',description:'Own, upgrade or race vehicles during this rotating event.',entry_fee:5000,hours:48,rewards:{cash:75000,xp:300}}
  ];
  for(let i=open.length;i<templates.length;i++){
    const t=templates[i], starts=now.toISOString(), ends=new Date(now.getTime()+t.hours*3600000).toISOString();
    const ins=await sb.from('events').insert({guild_id:guildId,name:t.name,description:t.description,entry_fee:t.entry_fee,status:'open',starts_at:starts,ends_at:ends,rewards:t.rewards}); if(ins.error) throw ins.error;
  }
  return season;
}

async function startAutomation(client){
  const tick=async()=>{
    for(const guild of client.guilds.cache.values()){
      try{
        await ensureLiveWorld(guild.id);
        const members=await guild.members.fetch().catch(()=>null);
        if(members){ for(const member of members.values()){ if(member.user.bot) continue; await profile(guild.id,member.id); await ensureDailyMissions(guild.id,member.id); await repairLegacyGarage(guild.id,member.id); } }
      }catch(e){ console.error(`Vehicle Life automation failed for ${guild.id}:`,e.message); }
    }
  };
  await tick();
  setInterval(tick,60*60*1000).unref?.();
}

async function handle(message){
  const c=message.content.trim(), a=c.split(/\s+/), cmd=(a[0]||'').toLowerCase(); if(!cmd.startsWith('?')) return false;
  const args=a.slice(1), gid=message.guild.id, uid=message.author.id;
  try{
    await ensureLiveWorld(gid); await profile(gid,uid); await ensureDailyMissions(gid,uid); await repairLegacyGarage(gid,uid);
    if(cmd==='?balance'){const p=await profile(gid,uid); return message.reply(`💰 **Vehicle Life Balance**\n${money(p.balance)}\n🧑‍✈️ Driver Level: **${p.driver_level}** • XP: **${p.driver_xp}**`);}
    if(cmd==='?daily'){const p=await profile(gid,uid), today=todayKey(); if(p.daily_claimed_on===today) return message.reply('⏳ You already claimed today’s reward.'); const streak=(p.daily_streak||0)+1, reward=10000+Math.min(streak,30)*1000; const r=await sb.from('game_profiles').update({daily_claimed_on:today,daily_streak:streak}).eq('guild_id',gid).eq('user_id',uid); if(r.error) throw r.error; await changeBalance(gid,uid,reward,'daily_reward',today); await addXp(gid,uid,50); return message.reply(`🎁 Daily reward claimed!\n💰 **${money(reward)}**\n🔥 Streak: **${streak}**\n🧑‍✈️ +50 XP`);}
    if(cmd==='?pay'){const target=message.mentions.users.first(), amount=Number(args.find(x=>/^\d+$/.test(x))); if(!target||!amount||amount<=0||target.id===uid) return message.reply('❌ Use `?pay @user <amount>`.'); await changeBalance(gid,uid,-amount,'payment',target.id); await changeBalance(gid,target.id,amount,'payment',uid); return message.reply(`💸 Sent **${money(amount)}** to ${target}.`);}
    if(cmd==='?dealership'){return message.reply({embeds:[dealershipEmbed(Number(args[0])||0)]});}
    if(cmd==='?buy'){return message.reply(await buy(message.guild,message.member,args.join(' ')));}
    if(cmd==='?sell'){
      const v=findVehicle(args.join(' ')); if(!v) return message.reply('❌ Vehicle not found.'); const o=await own(gid,uid,v); if(!o) return message.reply('❌ You do not own that vehicle.');
      const value=Math.floor(v.price*.55), id=`${gid}:${uid}:${v.id}:${Date.now()}`; pendingSales.set(id,{guildId:gid,userId:uid,vehicleId:v.id,value,expires:Date.now()+60000});
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`sellconfirm:${id}`).setLabel(`Confirm Sell • ${money(value)}`).setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`sellcancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
      return message.reply({content:`⚠️ **Confirm Vehicle Sale**\n\n${v.emoji} **${v.name}**\n💰 Sale value: **${money(value)}**\n\nThis vehicle will be removed from your garage.`,components:[row]});
    }
    if(cmd==='?garage'){
      const p=await profile(gid,uid), owneds=await vehiclesOf(gid,uid);
      const lines=owneds.slice(0,25).map((o,i)=>{const v=V[o.vehicle_id-1]; return v?`**#${i+1}** ${v.emoji} **${v.name}** • ${v.rarity} • Lv.${o.level||1} • ${o.condition??100}%`:null;}).filter(Boolean);
      return message.reply({embeds:[new EmbedBuilder().setTitle(`🏠 ${message.member.displayName}'S GARAGE`).setDescription(lines.join('\n')||'No vehicles yet. Complete progression or use `?dealership`.').addFields({name:'Collection',value:`${owneds.length}/${V.length}`,inline:true},{name:'Active',value:p.active_vehicle_id?V[p.active_vehicle_id-1]?.name||'None':'None',inline:true}).setColor(0x168cff)]});
    }
    if(cmd==='?vehicle'){
      const v=findVehicle(args.join(' ')); if(!v) return message.reply('❌ Vehicle not found.'); const o=await own(gid,uid,v);
      const e=new EmbedBuilder().setTitle(`${v.emoji} ${v.name}`).setDescription(`#${v.id} • ${v.rarity} • Class ${v.class}\n💰 ${money(v.price)} • Performance **${v.performance}**\n\n⚡ Power ${v.power}\n🏎️ Top Speed ${v.topSpeed} km/h\n🚀 Acceleration ${v.acceleration}\n🎯 Handling ${v.handling}\n🛑 Braking ${v.braking}\n⚖️ Weight ${v.weight} kg\n🟢 Launch ${v.launch}`);
      if(o) e.addFields({name:'Owned',value:`Level ${o.level||1} • XP ${o.xp||0} • Condition ${o.condition??100}%`}); else e.addFields({name:'Status',value:'🔒 Not owned'});
      e.setImage(`attachment://${v.image}`);
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`buy:${v.id}`).setLabel(o?'Owned':'Buy').setStyle(o?ButtonStyle.Secondary:ButtonStyle.Success).setDisabled(!!o));
      return message.reply({embeds:[e],files:[{attachment:vehicleImage(v),name:v.image}],components:[row]});
    }
    if(cmd==='?customize'||cmd==='?paint'){
      const raw=cmd==='?paint'?args.slice(0,-1).join(' '):args.join(' '), v=findVehicle(raw), o=v&&await own(gid,uid,v); if(!v||!o) return message.reply('❌ Own the vehicle first. Example: `?paint BMW M4 red`.');
      const paint=cmd==='?paint'?args.at(-1):'default', custom={...(o.custom||{}),paint}; const r=await sb.from('user_vehicles').update({custom}).eq('id',o.id); if(r.error) throw r.error; await changeBalance(gid,uid,-5000,'customization',String(v.id)); return message.reply(`🎨 **${v.name}** paint set to **${paint}** for ${money(5000)}.`);
    }
    if(cmd==='?upgrade'){
      const type=(args[0]||'').toLowerCase(), v=findVehicle(args.slice(1).join(' ')), o=v&&await own(gid,uid,v); if(!upgradeBase[type]||!v||!o) return message.reply('❌ Use `?upgrade <engine|turbo|ecu|transmission|suspension|brakes|tires|weight> <vehicle>`.');
      const upgrades={...(o.upgrades||{})}, lvl=Number(upgrades[type]||0); if(lvl>=10) return message.reply('❌ That upgrade is already level 10.'); const cost=15000*(lvl+1); await changeBalance(gid,uid,-cost,'upgrade',`${v.id}:${type}`); upgrades[type]=lvl+1; const r=await sb.from('user_vehicles').update({upgrades}).eq('id',o.id); if(r.error) throw r.error; await addXp(gid,uid,75); await updateMission(gid,uid,'upgrade'); return message.reply(`🔧 **${v.name}** ${type.toUpperCase()} upgraded to **Lv.${lvl+1}** for **${money(cost)}**.`);
    }
    if(cmd==='?repair'){const v=findVehicle(args.join(' ')), o=v&&await own(gid,uid,v); if(!v||!o) return message.reply('❌ Own the vehicle first.'); if(Number(o.condition)>=100) return message.reply('✅ Vehicle is already at 100% condition.'); const cost=Math.max(1000,Math.floor((100-Number(o.condition))*v.price*.002)); await changeBalance(gid,uid,-cost,'repair',String(v.id)); const r=await sb.from('user_vehicles').update({condition:100}).eq('id',o.id); if(r.error) throw r.error; return message.reply(`🛠️ Repaired **${v.name}** to **100%** for **${money(cost)}**.`);}
    if(cmd==='?race'||cmd==='?drag'||cmd==='?trackrace'||cmd==='?timetrial'){const target=message.mentions.members.first(); const type=cmd==='?drag'?'drag':cmd==='?trackrace'?'track':cmd==='?timetrial'?'time':'race'; const arg=target?args.filter(x=>!x.startsWith('<@')).join(' '):args.join(' '); return message.reply(await doRace(message.guild,message.member,arg,type,target));}
    if(cmd==='?racehistory'){const r=await sb.from('races').select('*').eq('guild_id',gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`).order('created_at',{ascending:false}).limit(10); if(r.error) throw r.error; return message.reply(r.data?.length?r.data.map(x=>`🏁 **${x.type}** • ${x.winner===uid?'WIN':'LOSS'} • ${String(x.created_at||'').slice(0,10)}`).join('\n'):'No races yet.');}
    if(cmd==='?racestats'){const r=await sb.from('races').select('*').eq('guild_id',gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`); if(r.error) throw r.error; const rows=r.data||[],wins=rows.filter(x=>x.winner===uid).length; return message.reply(`🏁 **Race Stats**\nRaces: **${rows.length}**\nWins: **${wins}**\nLosses: **${rows.length-wins}**\nWin rate: **${rows.length?Math.round(wins/rows.length*100):0}%**`);}
    if(cmd==='?missions'){const r=await sb.from('missions').select('*').eq('guild_id',gid).eq('user_id',uid).eq('period_key',todayKey()); if(r.error) throw r.error; return message.reply((r.data||[]).map(m=>`${m.completed?'✅':'⬜'} **${m.mission_key}** ${m.progress}/${m.target} • ${money(m.reward)}`).join('\n')||'No missions.');}
    if(cmd==='?achievements'){const r=await sb.from('achievements').select('*').eq('guild_id',gid).eq('user_id',uid); if(r.error) throw r.error; return message.reply(Object.entries(achievementDefs).map(([k,v])=>`${r.data?.some(x=>x.achievement_key===k)?'🏆':'🔒'} **${v[0]}** — ${v[1]}`).join('\n'));}
    if(cmd==='?market'){
      const r=await sb.from('marketplace').select('*').eq('guild_id',gid).eq('status','active').order('created_at',{ascending:false}).limit(10); if(r.error) throw r.error;
      return message.reply(r.data?.length?r.data.map(x=>`🆔 **#${x.id}** • ${V[x.vehicle_id-1]?.name||'Unknown'} • ${money(x.price)} • <@${x.seller_id}>`).join('\n'):'🛒 Marketplace is empty.\n\nList a vehicle with `?list <vehicle> <price>`.');
    }
    if(cmd==='?list'){
      const v=findVehicle(args.slice(0,-1).join(' ')), price=Number(args.at(-1)), o=v&&await own(gid,uid,v);
      if(!v||!o||!Number.isFinite(price)||price<=0) return message.reply('❌ Use `?list <vehicle> <price>` and own the vehicle.');
      const existing=await sb.from('marketplace').select('id').eq('guild_id',gid).eq('seller_id',uid).eq('vehicle_id',v.id).eq('status','active').maybeSingle(); if(existing.error) throw existing.error; if(existing.data) return message.reply('❌ That vehicle is already listed.');
      const r=await sb.from('marketplace').insert({guild_id:gid,seller_id:uid,vehicle_id:v.id,price,status:'active',metadata:{condition:o.condition,level:o.level,xp:o.xp,upgrades:o.upgrades,custom:o.custom}}).select().single(); if(r.error) throw r.error;
      await sb.from('user_vehicles').delete().eq('id',o.id);
      return message.reply(`🛒 Listed **${v.name}** for **${money(price)}**. Listing ID: **#${r.data.id}**\nUse [1m?marketbuy ${r.data.id}[0m to buy it from the marketplace.`.replace(/\u001b\[1m|\u001b\[0m/g,''));
    }
    if(cmd==='?marketbuy'){
      const id=Number(args[0]); if(!Number.isInteger(id)) return message.reply('❌ Use `?marketbuy <listing ID>`.');
      const r=await sb.from('marketplace').select('*').eq('id',id).eq('guild_id',gid).eq('status','active').maybeSingle(); if(r.error) throw r.error; if(!r.data) return message.reply('❌ Listing not found or already sold.');
      const listing=r.data; if(listing.seller_id===uid) return message.reply('❌ You cannot buy your own listing.');
      const v=V[listing.vehicle_id-1]; if(!v) return message.reply('❌ Vehicle data no longer exists.');
      if(await own(gid,uid,v)) return message.reply('❌ You already own this vehicle.');
      const p=await profile(gid,uid); if(Number(p.balance)<Number(listing.price)) return message.reply(`❌ You need ${money(listing.price)} but have ${money(p.balance)}.`);
      // Mark sold first. If another buyer wins the update, this buyer is rejected.
      const lock=await sb.from('marketplace').update({status:'sold',buyer_id:uid,sold_at:new Date().toISOString()}).eq('id',id).eq('status','active').select().maybeSingle();
      if(lock.error) throw lock.error; if(!lock.data) return message.reply('❌ Someone else already bought this listing.');
      try{
        await changeBalance(gid,uid,-Number(listing.price),'market_purchase',String(id));
        await changeBalance(gid,listing.seller_id,Number(listing.price),'market_sale',String(id));
        const meta=listing.metadata||{}; await acquire(gid,uid,v,'market'); await sb.from('user_vehicles').update({condition:meta.condition??100,level:meta.level??1,xp:meta.xp??0,upgrades:meta.upgrades||{},custom:meta.custom||{}}).eq('guild_id',gid).eq('user_id',uid).eq('vehicle_id',v.id);
      }catch(e){ await sb.from('marketplace').update({status:'active',buyer_id:null,sold_at:null}).eq('id',id).catch(()=>{}); throw e; }
      return message.reply(`✅ Bought **${v.name}** for **${money(listing.price)}**. It is now in your garage.`);
    }
    if(cmd==='?leaderboard'){const type=(args[0]||'richest').toLowerCase(); let r; if(type==='richest') r=await sb.from('game_profiles').select('*').eq('guild_id',gid).order('balance',{ascending:false}).limit(10); else if(type==='xp') r=await sb.from('game_profiles').select('*').eq('guild_id',gid).order('driver_xp',{ascending:false}).limit(10); else {const ps=await sb.from('game_profiles').select('*').eq('guild_id',gid); r={data:(ps.data||[]).sort((a,b)=>b.driver_xp-a.driver_xp).slice(0,10),error:null};} if(r.error) throw r.error; return message.reply((r.data||[]).map((x,i)=>`**#${i+1}** <@${x.user_id}> • ${money(x.balance)} • Lv.${x.driver_level} • ${x.driver_xp} XP`).join('\n')||'No players yet.');}
    if(cmd==='?events'){const season=await ensureLiveWorld(gid); const r=await sb.from('events').select('*').eq('guild_id',gid).eq('status','open').order('starts_at'); if(r.error) throw r.error; return message.reply((r.data||[]).length?(r.data||[]).map(e=>`🎉 **${e.name}** • Entry ${money(e.entry_fee)}\n🕒 ${formatWhen(e.starts_at,e.ends_at)}\n${e.description}`).join('\n\n'):`No active events.\n\n🗓️ ${season.name} is active; the event scheduler will refill the rotation automatically.`);}
    if(cmd==='?championship'){await ensureLiveWorld(gid); return message.reply('🏆 **Championship**\nQualifiers → Round 1 → Quarter Final → Semi Final → Final\nUse `?events` for active competitions.');}
    if(cmd==='?season'){const season=await ensureLiveWorld(gid); return message.reply(`🗓️ **${season.name}**\nSeason **#${season.season_no}** is active.\n🕒 ${formatWhen(season.starts_at,season.ends_at)}\n\nComplete missions, races and events to progress through the season.`);}
    if(cmd==='?trade'){const target=message.mentions.members.first(); if(!target||target.id===uid) return message.reply('❌ Use `?trade @user`.'); const id=`${gid}:${uid}:${target.id}:${Date.now()}`; pendingTrades.set(id,{guildId:gid,from:uid,to:target.id,expires:Date.now()+120000}); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tradeaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`tradedecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)); return message.reply({content:`🤝 ${target}, ${message.member} wants to start a trade.`,components:[row]});}
    if(cmd==='?betrace'){const amount=Number(args[0]), target=message.mentions.members.first(); if(!target||target.id===uid||!Number.isFinite(amount)||amount<=0) return message.reply('❌ Use `?betrace <amount> @user`.'); const p=await profile(gid,uid),op=await profile(gid,target.id); if(p.balance<amount||op.balance<amount) return message.reply('❌ Both players need enough balance for the stake.'); const id=`${gid}:${uid}:${target.id}:${Date.now()}`; pendingBets.set(id,{guildId:gid,from:uid,to:target.id,amount,expires:Date.now()+120000}); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`betaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`betdecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)); return message.reply({content:`💵 ${target}, ${message.member} challenged you to a **${money(amount)}** bet race.`,components:[row]});}
    if(cmd==='?admin'){
      if(!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.');
      const sub=(args[0]||'help').toLowerCase();
      if(sub==='give'){const target=message.mentions.users.first(),amt=Number(args.find(x=>/^\d+$/.test(x))); if(!target||!amt||amt<=0) return message.reply('❌ `?admin give @user amount`'); await changeBalance(gid,target.id,amt,'admin_grant',uid); return message.reply(`👑 Gave ${money(amt)} to ${target}.`);}
      if(sub==='take'){const target=message.mentions.users.first(),amt=Number(args.find(x=>/^\d+$/.test(x))); if(!target||!amt||amt<=0) return message.reply('❌ `?admin take @user amount`'); await changeBalance(gid,target.id,-amt,'admin_remove',uid); return message.reply(`👑 Removed ${money(amt)} from ${target}.`);}
      if(sub==='players'){const r=await sb.from('game_profiles').select('*').eq('guild_id',gid).order('updated_at',{ascending:false}).limit(50); if(r.error) throw r.error; return message.reply((r.data||[]).map(x=>`<@${x.user_id}> • ${money(x.balance)} • Lv.${x.driver_level}`).join('\n')||'No registered players.');}
      if(sub==='repairgarage'){const target=message.mentions.users.first()||message.author; const before=await vehiclesOf(gid,target.id); const result=await repairLegacyGarage(gid,target.id); return message.reply(`🧹 Garage repair complete for <@${target.id}>.\nBefore: **${before.length}** vehicles\nAfter: **${result.rows.length}** vehicles.`);}
      return message.reply('👑 Admin: `?admin give @user amount`, `?admin take @user amount`, `?admin players`, `?admin repairgarage @user`');
    }
    if(cmd==='?help'){return message.reply('🚗 **Vehicle Life**\n`?commands` for the full command guide.\nCore: `?dealership` `?buy` `?garage` `?vehicle` `?sell` `?market` `?race` `?upgrade` `?repair` `?missions` `?events`');}
    if(cmd==='?commands'){return false;}
    return false;
  }catch(e){
    console.error('Vehicle Life game error:',e);
    const msg=e.message==='INSUFFICIENT_FUNDS'?'❌ Insufficient funds.':`❌ Game system error: ${e.message}`;
    await message.reply(msg).catch(()=>{}); return true;
  }
}

async function handleButton(interaction){
  if(!interaction.isButton()) return false;
  try{
    if(interaction.customId.startsWith('buy:')){const v=V[Number(interaction.customId.split(':')[1])-1]; if(!v) return interaction.reply({content:'❌ Vehicle unavailable.',ephemeral:true}); return interaction.reply({content:await buy(interaction.guild,interaction.member,String(v.id)),ephemeral:true});}
    if(interaction.customId.startsWith('sellcancel:')){pendingSales.delete(interaction.customId.slice(11)); return interaction.update({content:'↩️ Vehicle sale cancelled.',components:[]});}
    if(interaction.customId.startsWith('sellconfirm:')){
      const id=interaction.customId.slice(12), sale=pendingSales.get(id); if(!sale||Date.now()>sale.expires) return interaction.reply({content:'❌ Sale confirmation expired. Use `?sell <vehicle>` again.',ephemeral:true});
      if(interaction.user.id!==sale.userId) return interaction.reply({content:'❌ Only the seller can confirm this sale.',ephemeral:true});
      const v=V[sale.vehicleId-1], o=await own(sale.guildId,sale.userId,v); if(!o){pendingSales.delete(id);return interaction.update({content:'❌ This vehicle is no longer in your garage.',components:[]});}
      const p=await profile(sale.guildId,sale.userId); if(p.active_vehicle_id===v.id) await sb.from('game_profiles').update({active_vehicle_id:null}).eq('guild_id',sale.guildId).eq('user_id',sale.userId);
      const del=await sb.from('user_vehicles').delete().eq('id',o.id); if(del.error) throw del.error; await changeBalance(sale.guildId,sale.userId,sale.value,'vehicle_sale',String(v.id)); pendingSales.delete(id);
      return interaction.update({content:`💵 **Sale Confirmed**\n${v.emoji} **${v.name}** sold for **${money(sale.value)}**.`,components:[]});
    }
    if(interaction.customId.startsWith('betdecline:')){pendingBets.delete(interaction.customId.slice(11));return interaction.update({content:'❌ Bet race declined.',components:[]});}
    if(interaction.customId.startsWith('betaccept:')){
      const id=interaction.customId.slice(10), b=pendingBets.get(id); if(!b||Date.now()>b.expires)return interaction.reply({content:'❌ Bet challenge expired.',ephemeral:true}); if(interaction.user.id!==b.to)return interaction.reply({content:'❌ Only the challenged player can accept.',ephemeral:true});
      const p=await profile(b.guildId,b.from),q=await profile(b.guildId,b.to); if(p.balance<b.amount||q.balance<b.amount)return interaction.reply({content:'❌ Stake is no longer affordable.',ephemeral:true});
      await changeBalance(b.guildId,b.from,-b.amount,'bet_lock',id); await changeBalance(b.guildId,b.to,-b.amount,'bet_lock',id);
      const g=interaction.guild,a=await g.members.fetch(b.from),o=await g.members.fetch(b.to); const result=await doRace(g,a,'','race',o);
      // doRace pays its normal race reward to the winner. Determine the winner from the race result text/DB instead of always paying the challenger.
      const rr=await sb.from('races').select('winner').eq('guild_id',b.guildId).eq('racer_a',b.from).eq('racer_b',b.to).order('created_at',{ascending:false}).limit(1).maybeSingle(); if(rr.error) throw rr.error;
      const winnerId=rr.data?.winner; if(!winnerId) throw new Error('BET_WINNER_NOT_FOUND'); await changeBalance(b.guildId,winnerId,b.amount*2,'bet_payout',id,{opponent:winnerId===b.from?b.to:b.from});
      pendingBets.delete(id); return interaction.update({content:`💵 **BET RACE SETTLED**\n${result}\n🎰 Bet pot: **${money(b.amount*2)}** paid to <@${winnerId}>.`,components:[]});
    }
    if(interaction.customId.startsWith('tradedecline:')){pendingTrades.delete(interaction.customId.slice(13));return interaction.update({content:'❌ Trade declined.',components:[]});}
    if(interaction.customId.startsWith('tradeaccept:')){const id=interaction.customId.slice(12),t=pendingTrades.get(id); if(!t||Date.now()>t.expires||interaction.user.id!==t.to)return interaction.reply({content:'❌ Trade unavailable or expired.',ephemeral:true}); pendingTrades.delete(id); return interaction.update({content:'🤝 Trade accepted. Full offer configuration is not enabled yet.',components:[]});}
  }catch(e){console.error('Game button error',e);return interaction.reply({content:`❌ Game action failed: ${e.message}`,ephemeral:true}).catch(()=>{});}
  return false;
}

module.exports={handle,handleButton,vehicles:V,startAutomation,grantProgressionVehicle,repairLegacyGarage};
