const { createClient } = require('@supabase/supabase-js');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const { vehicles } = require('./vehicles');

const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession:false, autoRefreshToken:false } });
const pendingBets = new Map();
const pendingTrades = new Map();
const pendingSales = new Map();

const rarityNames = ['COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','MYTHIC','EXCLUSIVE'];
const classNames = ['D','C','B','A','S','S+','X'];
const upgradeBase = { engine:5, turbo:8, ecu:4, transmission:5, suspension:4, brakes:5, tires:4, weight:4 };
const missionDefs = [
  ['races','Complete 5 races',5,50000], ['wins','Win 3 races',3,75000], ['earn','Earn ₹50000',50000,60000],
  ['upgrade','Upgrade a vehicle',1,30000], ['rare','Use a Rare+ vehicle',1,40000]
];
const achievementDefs = {
  first_vehicle:['First Vehicle','Own your first vehicle'], first_race:['First Race','Complete your first race'], first_win:['First Win','Win your first race'],
  millionaire:['Millionaire','Reach ₹1,000,000'], wins10:['10 Wins','Win 10 races'], wins50:['50 Wins','Win 50 races'], wins100:['100 Wins','Win 100 races'],
  supercar:['Supercar Collector','Own 5 supercars'], legendary:['Legendary Collector','Own a Legendary vehicle'], fullgarage:['Full Garage',`Own all ${vehicles.length} vehicles`],
  speed:['Speed Demon','Own a vehicle above 300 km/h'], master:['Master Racer','Complete 100 races']
};

function meta(v){
  const i=v.id; const rarity = i<=15?'COMMON':i<=30?'UNCOMMON':i<=50?'RARE':i<=70?'EPIC':i<=90?'LEGENDARY':i<=105?'MYTHIC':'EXCLUSIVE';
  const cls = i<=15?'D':i<=30?'C':i<=50?'B':i<=70?'A':i<=90?'S':i<=105?'S+':'X';
  const power=Math.round(25+i*5.2), speed=Math.round(55+i*3.15), accel=40+(i%30), handling=40+((i*7)%58), braking=35+((i*9)%60), weight=Math.max(850,1900-i*7), launch=35+((i*11)%60);
  const performance=Math.round((power/3+speed/3+accel+handling+braking+launch)/4);
  const price=Math.round(15000*Math.pow(1.075,i-1)/1000)*1000;
  return {...v, rarity, class:cls, power, topSpeed:speed, acceleration:accel, handling, braking, weight, launch, performance, price};
}
const V = vehicles.map(meta);
function findVehicle(q){ const s=String(q||'').trim().toLowerCase(); if(!s) return null; const id=Number(s.replace(/^#/,'')); return Number.isInteger(id)&&id>=1&&id<=V.length ? V[id-1] : V.find(v=>v.name.toLowerCase()===s) || V.find(v=>v.name.toLowerCase().includes(s)); }
function money(n){ return `₹${Math.max(0,Math.floor(Number(n)||0)).toLocaleString('en-IN')}`; }
function levelForXp(xp){ return Math.max(1,Math.floor(Math.sqrt(Math.max(0,xp)/100))+1); }
async function profile(guildId,userId){
  let {data,error}=await sb.from('game_profiles').select('*').eq('guild_id',guildId).eq('user_id',userId).maybeSingle();
  if(error) throw error;
  if(!data){ const row={guild_id:guildId,user_id:userId,balance:100000,driver_xp:0,driver_level:1,daily_streak:0}; const r=await sb.from('game_profiles').insert(row).select().single(); if(r.error) throw r.error; data=r.data; }
  return data;
}
async function vehiclesOf(guildId,userId){ const r=await sb.from('user_vehicles').select('*').eq('guild_id',guildId).eq('user_id',userId).order('vehicle_id'); if(r.error) throw r.error; return r.data||[]; }
async function ensureLegacyMigration(guildId,userId,legacyIndex){
  const owned=await vehiclesOf(guildId,userId);
  const count=Math.min(Math.max(Number(legacyIndex)||0,V.length),V.length);
  if(!count) return owned;
  const existing=new Set(owned.map(x=>Number(x.vehicle_id)));
  const rows=V.slice(0,count).filter(v=>!existing.has(v.id)).map(v=>({guild_id:guildId,user_id:userId,vehicle_id:v.id}));
  if(rows.length){ const r=await sb.from('user_vehicles').upsert(rows,{onConflict:'guild_id,user_id,vehicle_id'}); if(r.error) throw r.error; }
  return vehiclesOf(guildId,userId);
}
async function syncLegacyOwnership(guildId,userId){
  const legacy=require('./db').getUser(userId,guildId);
  return ensureLegacyMigration(guildId,userId,legacy?.vehicle_index||0);
}
async function tx(guildId,userId,type,amount,reference,metadata={}){ const r=await sb.from('transactions').insert({guild_id:guildId,user_id:userId,type,amount,reference,metadata}); if(r.error) throw r.error; }
async function changeBalance(guildId,userId,delta,type,reference,metadata={}){
  const p=await profile(guildId,userId); const next=Number(p.balance)+Number(delta); if(next<0) throw new Error('INSUFFICIENT_FUNDS');
  const r=await sb.from('game_profiles').update({balance:next,updated_at:new Date().toISOString()}).eq('guild_id',guildId).eq('user_id',userId); if(r.error) throw r.error; await tx(guildId,userId,type,delta,reference,metadata); return next;
}
async function addXp(guildId,userId,delta){ const p=await profile(guildId,userId); const xp=Number(p.driver_xp)+Math.max(0,delta); const level=levelForXp(xp); const r=await sb.from('game_profiles').update({driver_xp:xp,driver_level:level,updated_at:new Date().toISOString()}).eq('guild_id',guildId).eq('user_id',userId); if(r.error) throw r.error; return {xp,level}; }
async function own(guildId,userId,v){ const r=await sb.from('user_vehicles').select('*').eq('guild_id',guildId).eq('user_id',userId).eq('vehicle_id',v.id).maybeSingle(); if(r.error) throw r.error; return r.data; }
async function acquire(guildId,userId,v){ const r=await sb.from('user_vehicles').insert({guild_id:guildId,user_id:userId,vehicle_id:v.id}); if(r.error && !String(r.error.message).includes('duplicate')) throw r.error; await sb.from('game_profiles').update({active_vehicle_id:v.id}).eq('guild_id',guildId).eq('user_id',userId); }
function vehicleStats(v,u){ const up=u?.upgrades||{}; return {power:v.power+(up.engine||0)*5+(up.turbo||0)*2+(up.ecu||0),speed:v.topSpeed+(up.engine||0)*2+(up.transmission||0)*2,accel:v.acceleration+(up.turbo||0)*3+(up.transmission||0),handling:v.handling+(up.suspension||0)*2+(up.tires||0),braking:v.braking+(up.brakes||0)*2+(up.tires||0),launch:v.launch+(up.engine||0)+(up.transmission||0)}; }
function raceScore(v,u,type){ const s=vehicleStats(v,u); const cond=(u?.condition??100)/100; if(type==='drag') return (s.launch*2+s.accel*2+s.power+s.speed*.5)*cond; if(type==='track') return (s.handling*2+s.braking*2+s.accel+s.speed*.3)*cond; return (s.power+s.speed+s.accel+s.handling+s.braking+s.launch)*cond; }
async function updateMission(guildId,userId,key,amount=1){ const period=new Date().toISOString().slice(0,10); const def=missionDefs.find(x=>x[0]===key); if(!def) return; const [mission_key,,target,reward]=def; let r=await sb.from('missions').select('*').eq('guild_id',guildId).eq('user_id',userId).eq('mission_key',mission_key).eq('period_key',period).maybeSingle(); if(r.error) throw r.error; if(!r.data){ r=await sb.from('missions').insert({guild_id:guildId,user_id:userId,mission_key,progress:0,target,reward,period_key:period}).select().single(); if(r.error) throw r.error; } const m=r.data; if(m.completed) return; const progress=Math.min(target,Number(m.progress)+amount); const completed=progress>=target; r=await sb.from('missions').update({progress,completed}).eq('id',m.id); if(r.error) throw r.error; if(completed){await changeBalance(guildId,userId,reward,'mission_reward',mission_key); await addXp(guildId,userId,100);}}
async function unlockAchievement(guildId,userId,key){ if(!achievementDefs[key]) return; const r=await sb.from('achievements').insert({guild_id:guildId,user_id:userId,achievement_key:key}); if(r.error && !String(r.error.message).includes('duplicate')) throw r.error; }
async function checkAchievements(guildId,userId){ const p=await profile(guildId,userId), owneds=await vehiclesOf(guildId,userId); const races=await sb.from('races').select('*').eq('guild_id',guildId).or(`racer_a.eq.${userId},racer_b.eq.${userId}`); const rr=races.data||[]; const wins=rr.filter(r=>r.winner===userId).length; if(owneds.length>=1) await unlockAchievement(guildId,userId,'first_vehicle'); if(rr.length>=1) await unlockAchievement(guildId,userId,'first_race'); if(wins>=1) await unlockAchievement(guildId,userId,'first_win'); if(Number(p.balance)>=1000000) await unlockAchievement(guildId,userId,'millionaire'); if(wins>=10) await unlockAchievement(guildId,userId,'wins10'); if(wins>=50) await unlockAchievement(guildId,userId,'wins50'); if(wins>=100) await unlockAchievement(guildId,userId,'wins100'); if(owneds.length>=V.length) await unlockAchievement(guildId,userId,'fullgarage'); if(owneds.filter(x=>V[x.vehicle_id-1]?.rarity==='LEGENDARY').length>=1) await unlockAchievement(guildId,userId,'legendary'); if(owneds.filter(x=>V[x.vehicle_id-1]?.category==='car' && V[x.vehicle_id-1]?.performance>=150).length>=5) await unlockAchievement(guildId,userId,'supercar'); if(rr.length>=100) await unlockAchievement(guildId,userId,'master'); if(owneds.some(x=>V[x.vehicle_id-1]?.topSpeed>=300)) await unlockAchievement(guildId,userId,'speed'); }

async function buy(guild,member,arg){ const v=findVehicle(arg); if(!v) return '❌ Vehicle not found. Use `?dealership` or `?buy <vehicle number/name>`.'; const p=await profile(guild.id,member.id); const existing=await own(guild.id,member.id,v); if(existing) return `❌ You already own **${v.name}**.`; if(Number(p.balance)<v.price) return `❌ You need ${money(v.price)} but have ${money(p.balance)}.`; await changeBalance(guild.id,member.id,-v.price,'vehicle_purchase',String(v.id),{vehicle:v.name}); await acquire(guild.id,member.id,v); await updateMission(guild.id,member.id,'earn',0); await checkAchievements(guild.id,member.id); return `🎉 ${member} bought **${v.name}** for **${money(v.price)}**! It is now in your garage.`; }
function dealershipEmbed(page=0){
  const per=5,total=Math.ceil(V.length/per),p=Math.max(0,Math.min(Number(page)||0,total-1));
  const slice=V.slice(p*per,p*per+per);
  const e=new EmbedBuilder()
    .setTitle('🏪 VEHICLE LIFE DEALERSHIP')
    .setDescription(slice.map(v=>`**#${v.id} ${v.name}** • ${v.rarity} • Class ${v.class}\n💰 ${money(v.price)} • ⚡ ${v.performance}`).join('\n\n'))
    .setFooter({text:`Page ${p+1}/${total} • Use ?buy <vehicle ID> to purchase`});
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dealer:prev:${p}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(p<=0),
    new ButtonBuilder().setCustomId(`dealer:next:${p}`).setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(p>=total-1)
  );
  return {embed:e,row};
}
async function doRace(guild,member,arg,type='race',opponentMember=null){
  const p=await profile(guild.id,member.id); let owneds=await vehiclesOf(guild.id,member.id); if(!owneds.length) return '❌ You need a vehicle first. Use `?dealership` and `?buy <vehicle>`. ';  if(!p.race_vehicle_id) return '🏁 No race vehicle selected. Use `?setasracecar <vehicle ID>` first.'; let active=owneds.find(x=>x.vehicle_id===p.race_vehicle_id); if(!active) return '❌ Your selected race vehicle is no longer in your garage. Use `?setasracecar <vehicle ID>` again.'; const v=V[active.vehicle_id-1]; let bUser=null,bv=null,bOwner=null;
  if(opponentMember){ const bp=await profile(guild.id,opponentMember.id); if(!bp.race_vehicle_id) return `❌ ${opponentMember} has no race vehicle selected. They must use \`?setasracecar <vehicle ID>\`.`; const bo=await vehiclesOf(guild.id,opponentMember.id); bOwner=bo.find(x=>x.vehicle_id===bp.race_vehicle_id); if(!bOwner) return `❌ ${opponentMember}'s selected race vehicle is no longer in their garage.`; bv=V[bOwner.vehicle_id-1]; }
  else { const score=raceScore(v,active,type); const time=Math.max(8,60-score/10+(Math.random()*3)); active.condition=Math.max(0,active.condition-2); await sb.from('user_vehicles').update({condition:active.condition}).eq('id',active.id); await changeBalance(guild.id,member.id,2500,'race_reward',type); await addXp(guild.id,member.id,50); await updateMission(guild.id,member.id,'races'); await unlockAchievement(guild.id,member.id,'first_race'); await checkAchievements(guild.id,member.id); const r=await sb.from('races').insert({guild_id:guild.id,racer_a:member.id,vehicle_a:v.id,type,winner:member.id,stake:0,pot:2500,time_a:time,status:'finished'}).select().single(); if(r.error) throw r.error; return `🏁 **${type.toUpperCase()} COMPLETE**\n🚗 ${v.name}\n⏱️ Time: **${time.toFixed(2)}s**\n💰 Reward: **${money(2500)}**\n🧑‍✈️ +50 Driver XP\n🛠️ Condition: **${active.condition}%**`; }
  const sa=raceScore(v,active,type), sbv=raceScore(bv,bOwner,type); const winner=sa>=sbv?member:opponentMember; const winVehicle=winner.id===member.id?v:bv; const loser=winner.id===member.id?opponentMember:member; const wa=Math.max(8,60-sa/10+(Math.random()*2)); const wb=Math.max(8,60-sbv/10+(Math.random()*2)); await changeBalance(guild.id,winner.id,5000,'race_reward',type); await addXp(guild.id,winner.id,100); await addXp(guild.id,loser.id,25); const winnerOwned=winner.id===member.id?active:bOwner; const loserOwned=winner.id===member.id?bOwner:active; await sb.from('user_vehicles').update({condition:Math.max(0,winnerOwned.condition-2)}).eq('id',winnerOwned.id); await sb.from('user_vehicles').update({condition:Math.max(0,loserOwned.condition-4)}).eq('id',loserOwned.id); const r=await sb.from('races').insert({guild_id:guild.id,racer_a:member.id,racer_b:opponentMember.id,vehicle_a:v.id,vehicle_b:bv.id,type,winner:winner.id,stake:0,pot:5000,time_a:wa,time_b:wb,status:'finished'}).select().single(); if(r.error) throw r.error; await checkAchievements(guild.id,member.id); await checkAchievements(guild.id,opponentMember.id); return `🏁 **${type.toUpperCase()}**\n${member} **${v.name}** vs ${opponentMember} **${bv.name}**\n🏆 Winner: ${winner} (${winVehicle.name})\n💰 ${money(5000)} reward\n⏱️ ${wa.toFixed(2)}s vs ${wb.toFixed(2)}s`; }

function formatWhen(start,end){
  const a=start?new Date(start).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'Now';
  const b=end?new Date(end).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'Open';
  return `${a} → ${b}`;
}
async function ensureDailyMissions(guildId,userId){
  const period=new Date().toISOString().slice(0,10);
  for(const d of missionDefs){
    const [mission_key,,target,reward]=d;
    const r=await sb.from('missions').select('id').eq('guild_id',guildId).eq('user_id',userId).eq('mission_key',mission_key).eq('period_key',period).maybeSingle();
    if(r.error) throw r.error;
    if(!r.data){ const ins=await sb.from('missions').insert({guild_id:guildId,user_id:userId,mission_key,progress:0,target,reward,period_key:period}); if(ins.error && !String(ins.error.message).toLowerCase().includes('duplicate')) throw ins.error; }
  }
}
async function ensureLiveWorld(guildId){
  const now=new Date();
  const seasonR=await sb.from('seasons').select('*').eq('guild_id',guildId).eq('active',true).order('season_no',{ascending:false}).limit(1).maybeSingle();
  if(seasonR.error) throw seasonR.error;
  let season=seasonR.data;
  if(!season || !season.ends_at || new Date(season.ends_at)<=now){
    if(season?.id) await sb.from('seasons').update({active:false}).eq('id',season.id);
    const latest=await sb.from('seasons').select('season_no').eq('guild_id',guildId).order('season_no',{ascending:false}).limit(1).maybeSingle();
    if(latest.error) throw latest.error;
    const no=(latest.data?.season_no||0)+1; const starts=now.toISOString(); const ends=new Date(now.getTime()+30*24*60*60*1000).toISOString();
    const ins=await sb.from('seasons').insert({guild_id:guildId,season_no:no,name:`Season ${no} • Road to Glory`,active:true,starts_at:starts,ends_at:ends}).select().single();
    if(ins.error) throw ins.error; season=ins.data;
  }
  await sb.from('events').update({status:'closed'}).eq('guild_id',guildId).eq('status','open').lt('ends_at',now.toISOString());
  const openR=await sb.from('events').select('*').eq('guild_id',guildId).eq('status','open').order('starts_at');
  if(openR.error) throw openR.error;
  const open=openR.data||[];
  const templates=[
    {name:'Daily Sprint',description:'Complete races today and earn bonus Vehicle Life rewards.',entry_fee:0,hours:24,rewards:{cash:25000,xp:150}},
    {name:'Garage Rush',description:'Own, upgrade or race vehicles during this rotating event.',entry_fee:5000,hours:48,rewards:{cash:75000,xp:300}}
  ];
  for(let i=open.length;i<templates.length;i++){
    const t=templates[i]; const starts=now.toISOString(); const ends=new Date(now.getTime()+t.hours*60*60*1000).toISOString();
    const ins=await sb.from('events').insert({guild_id:guildId,name:t.name,description:t.description,entry_fee:t.entry_fee,status:'open',starts_at:starts,ends_at:ends,rewards:t.rewards});
    if(ins.error) throw ins.error;
  }
  return season;
}
async function startAutomation(client){
  const tick=async()=>{ for(const guild of client.guilds.cache.values()){ try{ await ensureLiveWorld(guild.id); const members=await guild.members.fetch().catch(()=>null); if(members){ for(const member of members.values()){ if(!member.user.bot) await ensureDailyMissions(guild.id,member.id); } } }catch(e){ console.error(`Vehicle Life automation failed for ${guild.id}:`,e.message); } } };
  await tick(); setInterval(tick,60*60*1000).unref?.();
}

async function handle(message){
  const c=message.content.trim(); const a=c.split(/\s+/); const cmd=(a[0]||'').toLowerCase(); if(!cmd.startsWith('?')) return false; const args=a.slice(1); const gid=message.guild.id, uid=message.author.id;
  try{
    await ensureLiveWorld(gid);
    await ensureDailyMissions(gid,uid);
    if(cmd==='?balance'){const p=await profile(gid,uid); return message.reply(`💰 **Vehicle Life Balance**\n${money(p.balance)}\n🧑‍✈️ Driver Level: **${p.driver_level}** • XP: **${p.driver_xp}**`);}
    if(cmd==='?daily'){const p=await profile(gid,uid), today=new Date().toISOString().slice(0,10); if(p.daily_claimed_on===today) return message.reply('⏳ You already claimed today’s reward.'); const streak=(p.daily_streak||0)+1; const reward=10000+Math.min(streak,30)*1000; const r=await sb.from('game_profiles').update({daily_claimed_on:today,daily_streak:streak}).eq('guild_id',gid).eq('user_id',uid); if(r.error) throw r.error; await changeBalance(gid,uid,reward,'daily_reward',today); await addXp(gid,uid,50); return message.reply(`🎁 Daily reward claimed!\n💰 **${money(reward)}**\n🔥 Streak: **${streak}**\n🧑‍✈️ +50 XP`);}
    if(cmd==='?pay'){const target=message.mentions.users.first(), amount=Number(args.find(x=>/^\d+$/.test(x))); if(!target||!amount||amount<=0||target.id===uid) return message.reply('❌ Use `?pay @user <amount>` and use a positive amount.'); await changeBalance(gid,uid,-amount,'payment',target.id); await changeBalance(gid,target.id,amount,'payment',uid); return message.reply(`💸 Sent **${money(amount)}** to ${target}.`);}
    if(cmd==='?dealership'){const d=dealershipEmbed(Number(args[0])||0); return message.reply({embeds:[d.embed],components:[d.row]});}
    if(cmd==='?buy'){return message.reply(await buy(message.guild,message.member,args.join(' ')));}
    if(cmd==='?sell'){
      await syncLegacyOwnership(gid,uid);
      const v=findVehicle(args.join(' ')); if(!v) return message.reply('❌ Vehicle not found.');
      const o=await own(gid,uid,v); if(!o) return message.reply('❌ You do not own that vehicle.');
      const value=Math.floor(v.price*.55); const id=`${gid}:${uid}:${v.id}:${Date.now()}`;
      pendingSales.set(id,{guildId:gid,userId:uid,vehicleId:v.id,value,expires:Date.now()+60000});
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sellconfirm:${id}`).setLabel(`Confirm Sell • ${money(value)}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sellcancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      return message.reply({content:`⚠️ **Confirm Vehicle Sale**\n\n${v.emoji} **${v.name}**\n💰 Sale value: **${money(value)}**\n\nThis vehicle will be removed from your garage.`,components:[row]});
    }
    if(cmd==='?garage'){const p=await profile(gid,uid); const owneds=await ensureLegacyMigration(gid,uid,(require('./db').getUser(uid,gid).vehicle_index)); const lines=owneds.slice(0,25).map((o,i)=>{const v=V[o.vehicle_id-1]; return `**#${i+1}** ${v.emoji} **${v.name}** • ${v.rarity} • Lv.${o.level} • ${o.condition}%`;}); return message.reply({embeds:[new EmbedBuilder().setTitle(`🏠 ${message.member.displayName}'S GARAGE`).setDescription(lines.join('\n')||'No vehicles yet. Use `?dealership`.').addFields({name:'Collection',value:`${owneds.length}/${V.length}`,inline:true},{name:'Active',value:p.active_vehicle_id?V[p.active_vehicle_id-1]?.name||'None':'None',inline:true}).setColor(0x168cff)]});}
    if(cmd==='?vehicle'){await syncLegacyOwnership(gid,uid); const v=findVehicle(args.join(' ')); if(!v) return message.reply('❌ Vehicle not found.'); const o=await own(gid,uid,v); const e=new EmbedBuilder().setTitle(`${v.emoji} ${v.name}`).setDescription(`#${v.id} • ${v.rarity} • Class ${v.class}\n💰 ${money(v.price)} • Performance **${v.performance}**\n\n⚡ Power ${v.power}\n🏎️ Top Speed ${v.topSpeed} km/h\n🚀 Acceleration ${v.acceleration}\n🎯 Handling ${v.handling}\n🛑 Braking ${v.braking}\n⚖️ Weight ${v.weight} kg\n🟢 Launch ${v.launch}`); if(o) e.addFields({name:'Owned',value:`Level ${o.level} • XP ${o.xp} • Condition ${o.condition}%`}); e.setImage(`attachment://vehicle-${String(v.id).padStart(2,'0')}.png`); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`buy:${v.id}`).setLabel(`Buy ${money(v.price)}`).setStyle(ButtonStyle.Success)); return message.reply({embeds:[e],files:[{attachment:require('path').join(__dirname,v.image),name:v.image}],components:[row]});}
    if(cmd==='?customize'||cmd==='?paint'){await syncLegacyOwnership(gid,uid); const v=findVehicle(args.slice(1).join(' ')||args.join(' ')); const o=v&&await own(gid,uid,v); if(!v||!o) return message.reply('❌ Own the vehicle first. Example: `?paint BMW M4 red`.'); const paint=cmd==='?paint'?args[args.length-1]:'default'; const custom={...(o.custom||{}),paint}; const r=await sb.from('user_vehicles').update({custom}).eq('id',o.id); if(r.error) throw r.error; await changeBalance(gid,uid,-5000,'customization',String(v.id)); return message.reply(`🎨 **${v.name}** paint set to **${paint}** for ${money(5000)}.`);}
    if(cmd==='?upgrade'){await syncLegacyOwnership(gid,uid); const v=findVehicle(args.slice(1).join(' ')||args[0]); const type=(args[0]&&upgradeBase[args[0].toLowerCase()])?args[0].toLowerCase():'engine'; const o=v&&await own(gid,uid,v); if(!v||!o) return message.reply('❌ Use `?upgrade <type> <vehicle>` and own the vehicle.'); const upgrades={...(o.upgrades||{})}; const lvl=Number(upgrades[type]||0); if(lvl>=10) return message.reply('❌ That upgrade is already level 10.'); const cost=15000*(lvl+1); await changeBalance(gid,uid,-cost,'upgrade',`${v.id}:${type}`); upgrades[type]=lvl+1; const r=await sb.from('user_vehicles').update({upgrades}).eq('id',o.id); if(r.error) throw r.error; await addXp(gid,uid,75); await updateMission(gid,uid,'upgrade'); return message.reply(`🔧 **${v.name}** ${type.toUpperCase()} upgraded to **Lv.${lvl+1}** for **${money(cost)}**.`);}
    if(cmd==='?repair'){await syncLegacyOwnership(gid,uid); const v=findVehicle(args.join(' ')); const o=v&&await own(gid,uid,v); if(!v||!o) return message.reply('❌ Own the vehicle first.'); if(o.condition>=100) return message.reply('✅ Vehicle is already at 100% condition.'); const cost=Math.max(1000,Math.floor((100-o.condition)*v.price*.002)); await changeBalance(gid,uid,-cost,'repair',String(v.id)); await sb.from('user_vehicles').update({condition:100}).eq('id',o.id); return message.reply(`🛠️ Repaired **${v.name}** to **100%** for **${money(cost)}**.`);}
    if(cmd==='?setasracecar'){
      const v=findVehicle(args.join(' '));
      if(!v) return message.reply('❌ Vehicle not found. Use `?setasracecar <vehicle ID/name>`.');
      const o=await own(gid,uid,v);
      if(!o) return message.reply(`❌ You do not own **${v.name}**. Buy/unlock it first.`);
      const r=await sb.from('game_profiles').update({race_vehicle_id:v.id,updated_at:new Date().toISOString()}).eq('guild_id',gid).eq('user_id',uid);
      if(r.error) throw r.error;
      return message.reply(`🏁 **Race vehicle set!**\n${v.emoji} **${v.name}** (#${v.id}) is now your race car.\nUse \`?race\`, \`?drag\`, \`?trackrace\` or \`?timetrial\` to race it.`);
    }
    if(cmd==='?racecar'){
      const p=await profile(gid,uid);
      if(!p.race_vehicle_id) return message.reply('🏁 **No race vehicle selected.**\nUse `?setasracecar <vehicle ID>` to choose one.');
      const v=V[p.race_vehicle_id-1]; const o=await own(gid,uid,v);
      if(!v||!o) return message.reply('❌ Your selected race vehicle is no longer in your garage.');
      return message.reply(`🏁 **YOUR RACE CAR**\n${v.emoji} **${v.name}** • #${v.id}\nClass: **${v.class}** • Performance: **${v.performance}**\nCondition: **${o.condition}%**`);
    }
    if(cmd==='?race'||cmd==='?drag'||cmd==='?trackrace'||cmd==='?timetrial'){const target=message.mentions.members.first(); const type=cmd==='?drag'?'drag':cmd==='?trackrace'?'track':cmd==='?timetrial'?'time':'race'; return message.reply(await doRace(message.guild,message.member,'',type,target));}
    if(cmd==='?racehistory'){const r=await sb.from('races').select('*').eq('guild_id',gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`).order('created_at',{ascending:false}).limit(10); if(r.error) throw r.error; return message.reply(r.data?.length?r.data.map(x=>`🏁 **${x.type}** • ${x.winner===uid?'WIN':'LOSS'} • ${x.created_at.slice(0,10)}`).join('\n'):'No races yet.');}
    if(cmd==='?racestats'){const r=await sb.from('races').select('*').eq('guild_id',gid).or(`racer_a.eq.${uid},racer_b.eq.${uid}`); const rows=r.data||[],wins=rows.filter(x=>x.winner===uid).length; return message.reply(`🏁 **Race Stats**\nRaces: **${rows.length}**\nWins: **${wins}**\nLosses: **${rows.length-wins}**\nWin rate: **${rows.length?Math.round(wins/rows.length*100):0}%**`);}
    if(cmd==='?missions'){const period=new Date().toISOString().slice(0,10); const r=await sb.from('missions').select('*').eq('guild_id',gid).eq('user_id',uid).eq('period_key',period); return message.reply((r.data||[]).map(m=>`${m.completed?'✅':'⬜'} **${m.mission_key}** ${m.progress}/${m.target} • ${money(m.reward)}`).join('\n')||'No missions.');}
    if(cmd==='?achievements'){const r=await sb.from('achievements').select('*').eq('guild_id',gid).eq('user_id',uid); return message.reply(Object.entries(achievementDefs).map(([k,v])=>`${r.data?.some(x=>x.achievement_key===k)?'🏆':'🔒'} **${v[0]}** — ${v[1]}`).join('\n'));}
    if(cmd==='?market'){const r=await sb.from('marketplace').select('*').eq('guild_id',gid).eq('status','active').order('created_at',{ascending:false}).limit(10); return message.reply(r.data?.length?r.data.map(x=>`#${x.id} • ${V[x.vehicle_id-1]?.name} • ${money(x.price)} • <@${x.seller_id}>`).join('\n'):'🛒 Marketplace is empty.');}
    if(cmd==='?list'){await syncLegacyOwnership(gid,uid); const v=findVehicle(args.slice(0,-1).join(' ')); const price=Number(args.at(-1)); const o=v&&await own(gid,uid,v); if(!v||!o||!Number.isFinite(price)||price<=0) return message.reply('❌ Use `?list <vehicle> <price>` and own the vehicle.'); const r=await sb.from('marketplace').insert({guild_id:gid,seller_id:uid,vehicle_id:v.id,price}).select().single(); if(r.error) throw r.error; await sb.from('user_vehicles').delete().eq('id',o.id); return message.reply(`🛒 Listed **${v.name}** for **${money(price)}**. Listing ID: **${r.data.id}**`);}
    if(cmd==='?marketbuy'){const id=Number(args[0]); const r=await sb.from('marketplace').select('*').eq('id',id).eq('guild_id',gid).eq('status','active').maybeSingle(); if(r.error) throw r.error; if(!r.data) return message.reply('❌ Listing not found.'); const listing=r.data; if(listing.seller_id===uid) return message.reply('❌ You cannot buy your own listing.'); await changeBalance(gid,uid,-listing.price,'market_purchase',String(id)); await changeBalance(gid,listing.seller_id,listing.price,'market_sale',String(id)); await sb.from('user_vehicles').insert({guild_id:gid,user_id:uid,vehicle_id:listing.vehicle_id}); await sb.from('marketplace').update({status:'sold',buyer_id:uid,sold_at:new Date().toISOString()}).eq('id',id); return message.reply(`✅ Bought **${V[listing.vehicle_id-1].name}** for **${money(listing.price)}**.`);}
    if(cmd==='?leaderboard'){const type=(args[0]||'richest').toLowerCase(); let r; if(type==='richest') r=await sb.from('game_profiles').select('user_id,balance,driver_level,driver_xp').eq('guild_id',gid).order('balance',{ascending:false}).limit(10); else if(type==='xp') r=await sb.from('game_profiles').select('user_id,balance,driver_level,driver_xp').eq('guild_id',gid).order('driver_xp',{ascending:false}).limit(10); else { const ps=await sb.from('game_profiles').select('user_id,balance,driver_level,driver_xp').eq('guild_id',gid); if(ps.error) throw ps.error; r={data:(ps.data||[]).sort((a,b)=>Number(b.driver_xp)-Number(a.driver_xp)).slice(0,10)}; } if(r.error) throw r.error; return message.reply((r.data||[]).map((x,i)=>`**#${i+1}** <@${x.user_id}> • ${money(x.balance)} • Lv.${x.driver_level} • ${x.driver_xp} XP`).join('\n')||'No players yet.');}
    if(cmd==='?events'){await ensureLiveWorld(gid); const r=await sb.from('events').select('*').eq('guild_id',gid).eq('status','open').order('starts_at'); return message.reply(r.data?.length?r.data.map(e=>`🎉 **${e.name}** • Entry ${money(e.entry_fee)}\n🕒 ${formatWhen(e.starts_at,e.ends_at)}\n${e.description}`).join('\n\n'):'No active events.');}
    if(cmd==='?championship'){await ensureLiveWorld(gid); return message.reply('🏆 **Championship**\nQualifiers → Round 1 → Quarter Final → Semi Final → Final\nUse `?events` to see the currently active competition events.');}
    if(cmd==='?season'){const season=await ensureLiveWorld(gid); return message.reply(`🗓️ **${season.name}**\nSeason **#${season.season_no}** is active.\n🕒 ${formatWhen(season.starts_at,season.ends_at)}\n\nComplete missions, races and events to progress through the season.`);}
    if(cmd==='?trade'){const target=message.mentions.members.first(); if(!target||target.id===uid) return message.reply('❌ Use `?trade @user`.'); const id=`${gid}:${uid}:${target.id}:${Date.now()}`; pendingTrades.set(id,{guildId:gid,from:uid,to:target.id}); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tradeaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`tradedecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)); return message.reply({content:`🤝 ${target}, ${message.member} wants to start a trade. Configure items in the trade flow.`,components:[row]});}
    if(cmd==='?betrace'){const amount=Number(args[0]), target=message.mentions.members.first(); if(!target||target.id===uid||!Number.isFinite(amount)||amount<=0) return message.reply('❌ Use `?betrace <amount> @user`.'); const p=await profile(gid,uid),op=await profile(gid,target.id); if(p.balance<amount||op.balance<amount) return message.reply('❌ Both players need enough balance for the stake.'); const id=`${gid}:${uid}:${target.id}:${Date.now()}`; pendingBets.set(id,{guildId:gid,from:uid,to:target.id,amount,expires:Date.now()+120000}); const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`betaccept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`betdecline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)); return message.reply({content:`💵 ${target}, ${message.member} challenged you to a **${money(amount)}** bet race.`,components:[row]});}
    if(cmd==='?adminreset'){
      // SECURITY: Prefix commands are public messages. Delete the command immediately
      // so the reset password is not left visible in the channel history.
      const RESET_PASSWORD='admin@151093';
      const supplied=args[0]||'';
      const targetToken=(args[1]||'').toLowerCase();
      const target=message.mentions.users.first();
      await message.delete().catch(()=>{});
      if(supplied!==RESET_PASSWORD) return message.channel.send('❌ Invalid admin reset password.');
      const resetUser=async (userId)=>{
        const listings=await sb.from('marketplace').select('id').eq('guild_id',gid).eq('seller_id',userId).eq('status','active');
        if(listings.error) throw listings.error;
        if((listings.data||[]).length) await sb.from('marketplace').update({status:'cancelled'}).eq('guild_id',gid).eq('seller_id',userId).eq('status','active');
        const delVehicles=await sb.from('user_vehicles').delete().eq('guild_id',gid).eq('user_id',userId);
        if(delVehicles.error) throw delVehicles.error;
        // Reset the actual game profile. UPDATE alone is not enough: if a
        // profile row is missing, Supabase updates 0 rows and the next game
        // command recreates it with the default balance. Use update+verify,
        // then insert a zeroed profile when no row exists.
        const resetPayload={
          guild_id:gid,
          user_id:userId,
          balance:0,
          driver_xp:0,
          driver_level:1,
          active_vehicle_id:null,
          race_vehicle_id:null,
          daily_streak:0,
          daily_claimed_on:null,
          updated_at:new Date().toISOString()
        };
        const resetProfile=await sb.from('game_profiles').update({
          balance:0,
          driver_xp:0,
          driver_level:1,
          active_vehicle_id:null,
          race_vehicle_id:null,
          daily_streak:0,
          daily_claimed_on:null,
          updated_at:new Date().toISOString()
        }).eq('guild_id',gid).eq('user_id',userId).select('user_id');
        if(resetProfile.error) throw resetProfile.error;
        if(!resetProfile.data || resetProfile.data.length===0){
          const created=await sb.from('game_profiles').insert(resetPayload).select('user_id').single();
          if(created.error) throw created.error;
        }
        const verifyProfile=await sb.from('game_profiles').select('balance,driver_xp,driver_level,active_vehicle_id,race_vehicle_id').eq('guild_id',gid).eq('user_id',userId).limit(1).maybeSingle();
        if(verifyProfile.error) throw verifyProfile.error;
        if(!verifyProfile.data || Number(verifyProfile.data.balance)!==0 || Number(verifyProfile.data.driver_xp)!==0 || Number(verifyProfile.data.driver_level)!==1 || verifyProfile.data.active_vehicle_id!==null || verifyProfile.data.race_vehicle_id!==null){
          throw new Error('RESET_VERIFY_FAILED');
        }
        const resetLegacy=await sb.from('users').update({vehicle_index:0,messages:0,vc_seconds:0,last_vc_join:null}).eq('guild_id',gid).eq('user_id',userId);
        if(resetLegacy.error) throw resetLegacy.error;
        await sb.from('missions').delete().eq('guild_id',gid).eq('user_id',userId);
        await sb.from('achievements').delete().eq('guild_id',gid).eq('user_id',userId);
      };
      if(targetToken==='everyone'){
        if(!message.member.permissions.has('ManageGuild')) return message.channel.send('❌ Manage Server required for `everyone`.');
        const r=await sb.from('users').select('user_id').eq('guild_id',gid);
        if(r.error) throw r.error;
        const ids=[...new Set((r.data||[]).map(x=>x.user_id))];
        const gp=await sb.from('game_profiles').select('user_id').eq('guild_id',gid);
        if(gp.error) throw gp.error;
        for(const x of gp.data||[]) ids.push(x.user_id);
        const unique=[...new Set(ids)];
        for(const id of unique) await resetUser(id);
        return message.channel.send(`🧹 **Full reset complete.** Reset **${unique.length}** player(s): balance **₹0**, inventory **0**, VC **0**, messages **0**, driver XP **0**, level **1**.`);
      }
      if(!target) return message.channel.send('❌ Use the admin reset command with a mentioned user or `everyone`.');
      await resetUser(target.id);
      return message.channel.send(`🧹 **Reset complete for ${target}.** Balance **₹0** • Vehicles **0** • VC **0** • Messages **0** • Driver XP **0** • Level **1**.`);
    }
    if(cmd==='?admin'){if(!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.'); const sub=(args[0]||'help').toLowerCase(); if(sub==='give'){const target=message.mentions.users.first(),amt=Number(args[1]); if(!target||!amt) return message.reply('❌ `?admin give @user amount`'); await changeBalance(gid,target.id,amt,'admin_grant',uid); return message.reply(`👑 Gave ${money(amt)} to ${target}.`);} if(sub==='take'){const target=message.mentions.users.first(),amt=Number(args[1]); if(!target||!amt) return message.reply('❌ `?admin take @user amount`'); await changeBalance(gid,target.id,-amt,'admin_remove',uid); return message.reply(`👑 Removed ${money(amt)} from ${target}.`);} if(sub==='players'){const r=await sb.from('game_profiles').select('*').eq('guild_id',gid).order('updated_at',{ascending:false}).limit(50); return message.reply((r.data||[]).map(x=>`<@${x.user_id}> • ${money(x.balance)} • Lv.${x.driver_level}`).join('\n')||'No registered players.');} return message.reply('👑 Admin: `?admin give @user amount`, `?admin take @user amount`, `?admin players`');}
    if(cmd==='?help'||cmd==='?commands'){return false;}
    return false;
  }catch(e){ console.error('Vehicle Life game error:',e); const msg=e.message==='INSUFFICIENT_FUNDS'?'❌ Insufficient funds.':e.message==='RESET_VERIFY_FAILED'?'❌ Reset verification failed. The database did not save the zeroed profile.':`❌ Game system error: ${e.message}`; await message.reply(msg).catch(()=>{}); return true; }
}

async function handleButton(interaction){
  if(!interaction.isButton()) return false;
  try{
    if(interaction.customId.startsWith('dealer:')){
      const parts=interaction.customId.split(':'); const dir=parts[1]; const current=Number(parts[2])||0; const next=dir==='next'?current+1:current-1;
      const d=dealershipEmbed(next);
      return interaction.update({embeds:[d.embed],components:[d.row]});
    }
    if(interaction.customId.startsWith('buy:')){const v=V[Number(interaction.customId.split(':')[1])-1]; if(!v) return interaction.reply({content:'❌ Vehicle unavailable.',ephemeral:true}); return interaction.reply({content:await buy(interaction.guild,interaction.member,String(v.id)),ephemeral:true});}
    if(interaction.customId.startsWith('sellcancel:')){ pendingSales.delete(interaction.customId.slice(11)); return interaction.update({content:'↩️ Vehicle sale cancelled.',components:[]}); }
    if(interaction.customId.startsWith('sellconfirm:')){
      const id=interaction.customId.slice(12), sale=pendingSales.get(id);
      if(!sale || Date.now()>sale.expires) return interaction.reply({content:'❌ Sale confirmation expired. Use `?sell <vehicle>` again.',ephemeral:true});
      if(interaction.user.id!==sale.userId) return interaction.reply({content:'❌ Only the seller can confirm this sale.',ephemeral:true});
      const v=V[sale.vehicleId-1]; const o=await own(sale.guildId,sale.userId,v);
      if(!o){ pendingSales.delete(id); return interaction.update({content:'❌ This vehicle is no longer in your garage.',components:[]}); }
      const p=await profile(sale.guildId,sale.userId); if(p.active_vehicle_id===v.id || p.race_vehicle_id===v.id) await sb.from('game_profiles').update({active_vehicle_id:p.active_vehicle_id===v.id?null:p.active_vehicle_id,race_vehicle_id:p.race_vehicle_id===v.id?null:p.race_vehicle_id}).eq('guild_id',sale.guildId).eq('user_id',sale.userId);
      await sb.from('user_vehicles').delete().eq('id',o.id); await changeBalance(sale.guildId,sale.userId,sale.value,'vehicle_sale',String(v.id)); pendingSales.delete(id);
      return interaction.update({content:`💵 **Sale Confirmed**\n${v.emoji} **${v.name}** sold for **${money(sale.value)}**.`,components:[]});
    }
    if(interaction.customId.startsWith('betdecline:')){pendingBets.delete(interaction.customId.slice(11)); return interaction.update({content:'❌ Bet race declined.',components:[]});}
    if(interaction.customId.startsWith('betaccept:')){const id=interaction.customId.slice(10),b=pendingBets.get(id); if(!b||Date.now()>b.expires) return interaction.reply({content:'❌ Bet challenge expired.',ephemeral:true}); if(interaction.user.id!==b.to) return interaction.reply({content:'❌ Only the challenged player can accept.',ephemeral:true}); const p=await profile(b.guildId,b.from),q=await profile(b.guildId,b.to); if(p.balance<b.amount||q.balance<b.amount) return interaction.reply({content:'❌ Stake is no longer affordable.',ephemeral:true}); await changeBalance(b.guildId,b.from,-b.amount,'bet_lock',id); await changeBalance(b.guildId,b.to,-b.amount,'bet_lock',id); const g=interaction.guild, a=await g.members.fetch(b.from), o=await g.members.fetch(b.to); const result=await doRace(g,a,'','race',o); await changeBalance(b.guildId,a.id,b.amount*2,'bet_payout',id); pendingBets.delete(id); return interaction.update({content:`💵 **BET RACE SETTLED**\n${result}\nPot: **${money(b.amount*2)}** awarded to the winner.`,components:[]});}
    if(interaction.customId.startsWith('tradedecline:')){pendingTrades.delete(interaction.customId.slice(13)); return interaction.update({content:'❌ Trade declined.',components:[]});}
    if(interaction.customId.startsWith('tradeaccept:')){const id=interaction.customId.slice(12),t=pendingTrades.get(id); if(!t||interaction.user.id!==t.to) return interaction.reply({content:'❌ Trade unavailable.',ephemeral:true}); pendingTrades.delete(id); return interaction.update({content:'🤝 Trade accepted. Use the trade configuration flow to add vehicles/money/items.',components:[]});}
  }catch(e){console.error('Game button error',e); return interaction.reply({content:'❌ Game action failed.',ephemeral:true}).catch(()=>{});}
  return false;
}
module.exports={handle,handleButton,vehicles:V,startAutomation};
