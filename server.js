'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const MongoStoreModule = require('connect-mongo');
const MongoStore = MongoStoreModule.default || MongoStoreModule;
const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
const { Server } = require('socket.io');
const { TEAM_CONFIG } = require('./lib/auction-rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'cricket_auction';
if (!mongoUri) console.warn('MONGODB_URI is not configured.');
const client = new MongoClient(mongoUri || 'mongodb://127.0.0.1:27017', {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000)
});
const clientPromise = client.connect();
const dbPromise = clientPromise.then(c => c.db(dbName));
const col = async name => (await dbPromise).collection(name);
const money = n => Number(Number(n).toFixed(2));
const now = () => new Date();
const effectiveOverseas = counts => counts.Overseas + Math.max(0, counts.Associate - 2);

async function ensureIndexes() {
  const db = await dbPromise;
  await Promise.all([
   
    db.collection('players').createIndex({ id: 1 }, { unique: true }),
    db.collection('players').createIndex({ status: 1, name: 1 }),
    db.collection('players').createIndex({ name_normalized: 1 }),
    db.collection('teams').createIndex({ id: 1 }, { unique: true }),
    db.collection('teams').createIndex({ short_name: 1 }, { unique: true, sparse: true }),
    db.collection('team_squads').createIndex({ player_id: 1 }, { unique: true }),
    db.collection('auction_bids').createIndex({ player_id: 1, amount: -1, id: -1 }),
    db.collection('auction_events').createIndex({ id: -1 }),
    db.collection('trades').createIndex({ id: -1 })

  ]);
  // Keep the numeric IDs already present in the existing MongoDB players collection.
  for (const name of ['players','teams','team_squads','auction_bids','trades','auction_events']) {
    const last = await db.collection(name).find({ id: { $type: 'number' } }).sort({ id: -1 }).limit(1).next();
    if (last) await db.collection('counters').updateOne({ _id: name }, { $max: { seq: Number(last.id) } }, { upsert: true });
  }
}
async function seedTeamsIfEmpty() {
  const teams = await col('teams');
  if (await teams.countDocuments() > 0) return;
  for (const [shortName, purse] of TEAM_CONFIG) {
    const id = await nextId('teams');
    const displayName = shortName === 'KD2' ? 'KD²' : shortName;
    await teams.insertOne({ id, name: displayName, short_name: shortName, logo_url: `/assets/team-${shortName.toLowerCase()}.webp`, initial_purse: purse, remaining_purse: purse, indian_rtm: 3, overseas_rtm: 3, created_at: now() });
  }
}
async function nextId(name) {
  const c = await col('counters');
  const doc = await c.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return Number(doc.seq);
}
async function withTransaction(work) {
  const c = await clientPromise;
  const session = c.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); return result; }
  finally { await session.endSession(); }
}
async function getTeamState(teamId, session) {
  const teams = await col('teams');
  const team = await teams.findOne({ id: Number(teamId) }, { session });
  if (!team) throw new Error('Team not found');
  const squad = await (await col('team_squads')).find({ team_id: Number(teamId) }, { session }).toArray();
  const playerIds = squad.map(x => x.player_id);
  const players = playerIds.length ? await (await col('players')).find({ id: { $in: playerIds } }, { session }).toArray() : [];
  const counts = { Indian: 0, Overseas: 0, Associate: 0 };
  players.forEach(p => { if (counts[p.category] !== undefined) counts[p.category]++; });
  const total = counts.Indian + counts.Overseas + counts.Associate;
  return { team, counts, total, effOverseas: effectiveOverseas(counts) };
}
async function validateAddition(teamId, player, amount, session) {
  const s = await getTeamState(teamId, session); const amt = money(amount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('Invalid amount');
  if (Number(s.team.remaining_purse) + 0.0001 < amt) throw new Error('Insufficient purse');
  if (s.total >= 20) throw new Error('Maximum squad size is 20');
  const next = { ...s.counts, [player.category]: s.counts[player.category] + 1 };
  const nextEff = effectiveOverseas(next);
  if (next.Indian > 9) throw new Error('Indian maximum is 9');
  if (nextEff > 9) throw new Error('Effective Overseas maximum is 9');
  if (next.Associate > 11) throw new Error('Maximum Associate player count is 11 (2 dedicated + 9 overseas slots)');
  if (s.total + 1 === 20) {
    if (next.Indian < 8) throw new Error('A 20-player squad must contain at least 8 Indian players');
    if (nextEff < 8) throw new Error('A 20-player squad must contain at least 8 Overseas-equivalent players');
    if (next.Associate < 1) throw new Error('A 20-player squad must contain at least 1 Associate player');
  }
  return s;
}
async function addPlayerToTeam(teamId, player, amount, type, session) {
  await validateAddition(teamId, player, amount, session);
  const amt = money(amount);
  await (await col('teams')).updateOne({ id: Number(teamId) }, { $inc: { remaining_purse: -amt } }, { session });
  await (await col('team_squads')).insertOne({ id: await nextId('team_squads'), team_id: Number(teamId), player_id: Number(player.id), amount: amt, acquisition_type: type, created_at: now() }, { session });
  await (await col('players')).updateOne({ id: Number(player.id) }, { $set: { status: type === 'Retention' ? 'RETAINED' : 'SOLD', current_team_id: Number(teamId), sold_price: amt, acquisition_type: type } }, { session });
}
async function addEvent(data, session) {
  await (await col('auction_events')).insertOne({ id: await nextId('auction_events'), player_id: data.player_id ?? null, team_id: data.team_id ?? null, event_type: data.event_type, amount: data.amount ?? null, details: data.details || null, created_at: now() }, { session });
}

io.on('connection', socket => socket.on('broadcast:state', payload => {
  if (!payload || typeof payload !== 'object') return;
  const safe = { status: String(payload.status || 'AUCTION LIVE').slice(0,24), player: String(payload.player || 'Waiting for next player').slice(0,150), details: String(payload.details || '').slice(0,250), teamShort: String(payload.teamShort || '').slice(0,20), amount: String(payload.amount || '').slice(0,30), teamLogo: payload.teamShort === 'BR' ? '/assets/br-bulls-logo.png' : '' };
  socket.broadcast.emit('broadcast:state', safe);
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'development-only-change-me', resave: false, saveUninitialized: false, store: MongoStore.create({ clientPromise, dbName, collectionName: 'sessions', ttl: 14 * 24 * 60 * 60 }), cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/broadcast/state', async (_req,res) => { try { const state=await (await col('broadcast_state')).findOne({ _id: 'current' }); res.json(state?.state || { status:'AUCTION LIVE', player:'Waiting for next player', details:'' }); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/broadcast/state', async (req,res) => { try { const p=req.body||{}; const state={ status:String(p.status||'AUCTION LIVE').slice(0,24), player:String(p.player||'Waiting for next player').slice(0,150), details:String(p.details||'').slice(0,250), teamShort:String(p.teamShort||'').slice(0,20), amount:String(p.amount||'').slice(0,30), teamLogo:p.teamShort==='BR'?'/assets/br-bulls-logo.png':'' }; await (await col('broadcast_state')).updateOne({_id:'current'},{$set:{state,updated_at:now()}},{upsert:true}); io.emit('broadcast:state',state); res.json({ok:true}); } catch(e) { res.status(500).json({error:e.message}); } });

app.get('/api/health', async (_req,res) => {
  try { await dbPromise; await (await col('app_meta')).updateOne({ _id: 'health' }, { $set: { checked_at: now() } }, { upsert: true }); res.json({ ok: true, database: dbName, provider: 'mongodb' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/teams', async (_req,res) => {
  try { const teams = await (await col('teams')).find({}).sort({ name: 1 }).toArray(); const out=[]; for (const t of teams) { const s=await getTeamState(t.id); out.push({ ...t, squad_size:s.total, indian_count:s.counts.Indian, overseas_count:s.counts.Overseas, associate_count:s.counts.Associate, effective_overseas:s.effOverseas, spent:money(Number(t.initial_purse||0)-Number(t.remaining_purse||0)) }); } res.json(out); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/teams', async (req,res) => {
  try { const {name,short_name,logo_url}=req.body; if(!name) throw new Error('Team name required'); const id=await nextId('teams'); const doc={id,name:String(name).trim(),short_name:short_name||'',logo_url:logo_url||'',initial_purse:90,remaining_purse:90,indian_rtm:3,overseas_rtm:3,created_at:now()}; await (await col('teams')).insertOne(doc); res.json({id,name:doc.name}); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.get('/api/players', async (req,res) => {
  try { const q={}; const {status,search,category,role}=req.query; if(status)q.status=status;if(category)q.category=category;if(role)q.role=role;if(search)q.name={$regex:String(search).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}; const rows=await (await col('players')).find(q).sort({name:1}).toArray(); const teams=await (await col('teams')).find({}).toArray();const tm=new Map(teams.map(t=>[t.id,t.name]));res.json(rows.map(p=>({...p,current_team:tm.get(p.current_team_id)||null}))); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/players', async (req,res) => {
  try { const p=req.body;if(!p.name||!['Indian','Overseas','Associate'].includes(p.category))throw new Error('Player name and valid category required'); const existing=await (await col('players')).findOne({name_normalized:String(p.name).trim().toLowerCase()});if(existing)throw new Error('Player already exists');const id=await nextId('players');await (await col('players')).insertOne({id,name:String(p.name).trim(),name_normalized:String(p.name).trim().toLowerCase(),country:p.country||'',category:p.category,role:p.role||'Batter',previous_price:Number(p.previous_price||0),previous_team:p.previous_team||'',base_price:Number(p.base_price||0.5),photo_url:p.photo_url||null,status:'AVAILABLE',current_team_id:null,sold_price:null,acquisition_type:null,created_at:now()});res.json({id}); }
  catch(e){res.status(400).json({error:e.message});}
});
async function importTeamCodes(wb) {
  const sh=wb.Sheets['Team Code Reference'];if(!sh)return {teamsImported:0,teamsSkipped:0};const rows=XLSX.utils.sheet_to_json(sh,{defval:''});const purses={KCG:90,ARC:90,DCS:90,VTK:90,SS:90,FCK:90,TG:87,BBC:87,AKS:67,KD2:67,BR:67,CC:53,RH:47,'7SV':12};let teamsImported=0,teamsSkipped=0;
  for(const row of rows){const rawCode=String(row['Previous Team Code']||'').trim();if(!rawCode)continue;const code=rawCode.replace('²','2');const exists=await (await col('teams')).findOne({short_name:code});if(exists){teamsSkipped++;continue;}const id=await nextId('teams');await (await col('teams')).insertOne({id,name:rawCode,short_name:code,logo_url:`/assets/team-${code.toLowerCase()}.webp`,initial_purse:Number(purses[code]??90),remaining_purse:Number(purses[code]??90),indian_rtm:3,overseas_rtm:3,created_at:now()});teamsImported++;}return {teamsImported,teamsSkipped};
}
app.post('/api/import', upload.single('file'), async (req,res) => {
  try { if(!req.file)throw new Error('Choose an Excel file');const wb=XLSX.read(req.file.buffer,{type:'buffer'});const sheet=wb.Sheets['Player Import']||wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(sheet,{defval:''});const teamImport=await importTeamCodes(wb);let imported=0,skipped=0;
    for(const row of rows){const n={};Object.keys(row).forEach(k=>n[k.toLowerCase().trim().replace(/[^a-z0-9]/g,'')]=row[k]);const name=n.playername||n.name||n.player;if(!name){skipped++;continue;}const cat=String(n.category||n.countrycategory||n.type||'').trim();if(!['Indian','Overseas','Associate'].includes(cat)){skipped++;continue;}const role=String(n.role||n.playerrole||'Batter').trim();const prevTeam=String(n.previousteam||n.team||'').trim();const normalized=String(name).trim().toLowerCase();if(await (await col('players')).findOne({name_normalized:normalized})){skipped++;continue;}const baseRaw=n.baseprice;const base=baseRaw===undefined||baseRaw===''?0.5:Number(String(baseRaw).replace(/[₹,]/g,'').replace(/\s*Cr\s*/i,'').replace(/C$/i,''));const id=await nextId('players');await (await col('players')).insertOne({id,name:String(name).trim(),name_normalized:normalized,country:String(n.country||cat),category:cat,role:['Batter','Batting All-Rounder','Bowling All-Rounder','Bowler','Wicket Keeper'].includes(role)?role:'Batter',previous_price:Number(n.previousprice||n.previoussoldprice||n.soldprice||0),previous_team:prevTeam,base_price:Number.isFinite(base)&&base>0?base:0.5,photo_url:String(n.photourl||n.photo||n.imageurl||'').trim()||null,status:'AVAILABLE',current_team_id:null,sold_price:null,acquisition_type:null,created_at:now()});imported++;}
    res.json({imported,skipped,...teamImport});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/retention', async (req,res) => { try { const result=await withTransaction(async s=>{const {player_id,team_id,amount}=req.body;const p=await (await col('players')).findOne({id:Number(player_id),status:'AVAILABLE'},{session:s});if(!p)throw new Error('Player is not available for retention');const t=await (await col('teams')).findOne({id:Number(team_id)},{session:s});if(!t)throw new Error('Team not found');if(!p.previous_team||p.previous_team.trim().toLowerCase()!==t.name.trim().toLowerCase())throw new Error('A player can only be retained by their previous-season team');const key=p.category==='Indian'?'indian_rtm':'overseas_rtm';if(Number(t[key]||0)<=0)throw new Error('No matching RTM entitlement remains for this category');await addPlayerToTeam(team_id,p,amount,'Retention',s);await (await col('teams')).updateOne({id:Number(team_id)},{$inc:{[key]:-1}},{session:s});await addEvent({player_id:p.id,team_id:Number(team_id),event_type:'RETENTION',amount:money(amount)},s);return true;});io.emit('auction:update');res.json({ok:result});}catch(e){res.status(400).json({error:e.message});} });
app.post('/api/release', async (req,res) => { try {const result=await withTransaction(async s=>{const {player_id}=req.body;const p=await (await col('players')).findOne({id:Number(player_id),status:'RETAINED'},{session:s});if(!p)throw new Error('Retained player not found');const teamId=p.current_team_id,amount=money(p.sold_price||0),key=p.category==='Indian'?'indian_rtm':'overseas_rtm';await (await col('teams')).updateOne({id:teamId},{$inc:{remaining_purse:amount,[key]:1}},{session:s});await (await col('team_squads')).deleteOne({player_id:p.id},{session:s});await (await col('players')).updateOne({id:p.id},{$set:{status:'AVAILABLE',current_team_id:null,sold_price:null,acquisition_type:null}},{session:s});await addEvent({player_id:p.id,team_id:teamId,event_type:'RELEASE',amount,details:{refunded_purse:true,returned_rtm:true}},s);return amount;});io.emit('auction:update');res.json({ok:true,refunded:result,rtmReturned:true});}catch(e){res.status(400).json({error:e.message});} });
app.post('/api/trade', async (req,res) => { try {const out=await withTransaction(async s=>{const {player_id,from_team_id,to_team_id,amount}=req.body;const pid=Number(player_id),sellerId=Number(from_team_id),buyerId=Number(to_team_id);if(sellerId===buyerId)throw new Error('Choose a different buying team');const p=await (await col('players')).findOne({id:pid,current_team_id:sellerId},{session:s});if(!p)throw new Error('Player does not belong to selling team');const seller=await (await col('teams')).findOne({id:sellerId},{session:s}),buyer=await (await col('teams')).findOne({id:buyerId},{session:s});if(!seller||!buyer)throw new Error('Seller or buyer team not found');const amt=money(Number(amount));if(!Number.isFinite(amt)||amt<=0)throw new Error('Enter a valid trade amount greater than zero');if(Number(buyer.remaining_purse)<amt)throw new Error('Buyer team does not have enough purse');await validateAddition(buyerId,p,amt,s);await (await col('team_squads')).deleteOne({player_id:pid},{session:s});await (await col('teams')).updateOne({id:buyerId},{$inc:{remaining_purse:-amt}},{session:s});await (await col('teams')).updateOne({id:sellerId},{$inc:{remaining_purse:amt}},{session:s});await (await col('team_squads')).insertOne({id:await nextId('team_squads'),team_id:buyerId,player_id:pid,amount:amt,acquisition_type:'Trade',created_at:now()},{session:s});await (await col('players')).updateOne({id:pid},{$set:{current_team_id:buyerId,sold_price:amt,acquisition_type:'Trade'}},{session:s});await (await col('trades')).insertOne({id:await nextId('trades'),player_id:pid,from_team_id:sellerId,to_team_id:buyerId,amount:amt,created_at:now()},{session:s});await addEvent({player_id:pid,team_id:buyerId,event_type:'TRADE',amount:amt,details:{from_team_id:sellerId,buyer_only_deduction:true}},s);return {amount:amt,buyer_remaining_purse:Number(buyer.remaining_purse)-amt,seller_remaining_purse:Number(seller.remaining_purse)+amt};});io.emit('auction:update');res.json({ok:true,buyer_purse_deducted:out.amount,seller_purse_credited:out.amount,...out});}catch(e){res.status(400).json({error:e.message});} });
app.post('/api/bid', async (req,res) => {try{const {player_id,team_id,amount}=req.body;const p=await (await col('players')).findOne({id:Number(player_id),status:'AVAILABLE'});if(!p)throw new Error('Player is not available');await validateAddition(team_id,p,amount);const id=await nextId('auction_bids');await (await col('auction_bids')).insertOne({id,player_id:Number(player_id),team_id:Number(team_id),amount:money(amount),created_at:now()});const team=await (await col('teams')).findOne({id:Number(team_id)});io.emit('auction:bid',{player_id:Number(player_id),team_id:Number(team_id),team:team?.name,amount:money(amount)});res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/sold', async (req,res) => {try{await withTransaction(async s=>{const {player_id,team_id,amount}=req.body;const p=await (await col('players')).findOne({id:Number(player_id),status:'AVAILABLE'},{session:s});if(!p)throw new Error('Player is not available');await addPlayerToTeam(team_id,p,amount,'Auction',s);await addEvent({player_id:p.id,team_id:Number(team_id),event_type:'SOLD',amount:money(amount)},s);});io.emit('auction:update');res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/unsold', async (req,res) => {try{const {player_id}=req.body;const r=await (await col('players')).updateOne({id:Number(player_id),status:'AVAILABLE'},{$set:{status:'UNSOLD',current_team_id:null}});if(!r.modifiedCount)throw new Error('Player is not available');await addEvent({player_id:Number(player_id),event_type:'UNSOLD'});io.emit('auction:update');res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/reauction', async (req,res) => {try{const r=await (await col('players')).updateOne({id:Number(req.body.player_id),status:'UNSOLD'},{$set:{status:'AVAILABLE'}});if(!r.modifiedCount)throw new Error('Player is not unsold');io.emit('auction:update');res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/sold', async (_req,res) => {try{const rows=await (await col('players')).find({status:'SOLD'}).sort({name:1}).toArray();const teams=await (await col('teams')).find({}).toArray();const tm=new Map(teams.map(t=>[t.id,t.name]));res.json(rows.map(p=>({...p,current_team:tm.get(p.current_team_id)||null})));}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/sold/bring-back', async (req,res) => {try{const refund=await withTransaction(async s=>{const pid=Number(req.body.player_id);const p=await (await col('players')).findOne({id:pid,status:'SOLD'},{session:s});if(!p)throw new Error('Sold player not found');const amount=money(p.sold_price||0),teamId=p.current_team_id;if(teamId){const inc={remaining_purse:amount};if(p.acquisition_type==='RTM')inc[p.category==='Indian'?'indian_rtm':'overseas_rtm']=1;await (await col('teams')).updateOne({id:teamId},{$inc:inc},{session:s});await (await col('team_squads')).deleteOne({player_id:pid},{session:s});}await (await col('players')).updateOne({id:pid},{$set:{status:'AVAILABLE',current_team_id:null,sold_price:null,acquisition_type:null}},{session:s});await addEvent({player_id:pid,team_id:teamId,event_type:'SALE_REVERSED',amount,details:{purse_refunded:true}},s);return {amount,teamId};});io.emit('auction:update');res.json({ok:true,refunded:refund.amount,team_id:refund.teamId});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/rtm', async (req,res) => {try{await withTransaction(async s=>{const {player_id,team_id,amount}=req.body;const p=await (await col('players')).findOne({id:Number(player_id),status:'AVAILABLE'},{session:s});if(!p)throw new Error('Player is not available');if(!p.previous_team)throw new Error('Previous team is not recorded; RTM eligibility cannot be verified');const team=await (await col('teams')).findOne({id:Number(team_id),name:p.previous_team},{session:s});if(!team)throw new Error("Only the player's previous team can use RTM");const key=p.category==='Indian'?'indian_rtm':'overseas_rtm';if(Number(team[key]||0)<=0)throw new Error('No eligible RTM card remains');await addPlayerToTeam(team_id,p,amount,'RTM',s);await (await col('teams')).updateOne({id:Number(team_id)},{$inc:{[key]:-1}},{session:s});await addEvent({player_id:p.id,team_id:Number(team_id),event_type:'RTM',amount:money(amount)},s);});io.emit('auction:update');res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/player/:id', async (req,res) => {try{const id=Number(req.params.id);const player=await (await col('players')).findOne({id});if(!player)return res.status(404).json({error:'Player not found'});const team=player.current_team_id?await (await col('teams')).findOne({id:player.current_team_id}):null;const bids=await (await col('auction_bids')).find({player_id:id}).sort({amount:-1,id:-1}).limit(10).toArray();const bidTeams=await (await col('teams')).find({id:{$in:bids.map(b=>b.team_id)}}).toArray();const btm=new Map(bidTeams.map(t=>[t.id,t]));const events=await (await col('auction_events')).find({player_id:id}).sort({id:-1}).limit(10).toArray();res.json({player:{...player,current_team:team?.name||null,current_team_short:team?.short_name||null},bids:bids.map(b=>({...b,team_name:btm.get(b.team_id)?.name,short_name:btm.get(b.team_id)?.short_name})),events});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/nomination-queue', async (_req,res) => {try{res.json(await (await col('players')).find({status:'AVAILABLE'},{projection:{id:1,name:1,category:1,role:1,base_price:1,photo_url:1}}).sort({category:1,role:1,name:1}).toArray());}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/squad/:teamId', async (req,res) => {try{const squad=await (await col('team_squads')).find({team_id:Number(req.params.teamId)}).sort({id:1}).toArray();const ids=squad.map(x=>x.player_id);const players=ids.length?await (await col('players')).find({id:{$in:ids}}).toArray():[];const sm=new Map(squad.map(x=>[x.player_id,x]));res.json(players.map(p=>({...p,amount:sm.get(p.id)?.amount,acquisition_type:sm.get(p.id)?.acquisition_type})).sort((a,b)=>String(a.category).localeCompare(String(b.category))||a.name.localeCompare(b.name)));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/stats', async (_req,res) => {try{const p=await (await col('players')).find({}).toArray();const squads=await (await col('team_squads')).find({}).toArray();res.json({total:p.length,available:p.filter(x=>x.status==='AVAILABLE').length,sold:p.filter(x=>x.status==='SOLD').length,unsold:p.filter(x=>x.status==='UNSOLD').length,retained:p.filter(x=>x.status==='RETAINED').length,total_spend:money(squads.reduce((a,x)=>a+Number(x.amount||0),0))});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/reports.xlsx', async (_req,res) => {try{const teams=await (await col('teams')).find({}).sort({name:1}).toArray();const players=await (await col('players')).find({}).toArray();const trades=await (await col('trades')).find({}).sort({id:-1}).toArray();const tm=new Map(teams.map(t=>[t.id,t.name]));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(teams),'Teams & Purse');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(players.map(p=>({...p,current_team:tm.get(p.current_team_id)||''})).map(({_id,...x})=>x)),'Player Register');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(trades.map(t=>({player:players.find(p=>p.id===t.player_id)?.name||'',seller:tm.get(t.from_team_id)||'',buyer:tm.get(t.to_team_id)||'',amount:t.amount,created_at:t.created_at}))), 'Trade History');res.setHeader('Content-Disposition','attachment; filename="SNK_Friends_Auction_Report.xlsx"');res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/backup', async (_req,res) => {try{const tables={};for(const name of ['teams','players','team_squads','auction_bids','trades','auction_events'])tables[name]=(await (await col(name)).find({}).toArray()).map(({_id,...x})=>x);res.setHeader('Content-Disposition','attachment; filename="SNK_Friends_Auction_Backup.json"');res.json({app:'SNK Friends Cricket Mega Auction',version:2,created_at:now().toISOString(),tables});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/reset-all-data', async (req,res) => {if(req.body?.confirm!=='DELETE ALL DATA')return res.status(400).json({error:'Reset confirmation phrase is required'});try{await withTransaction(async s=>{for(const n of ['auction_bids','trades','auction_events','team_squads','players','teams'])await (await col(n)).deleteMany({}, {session:s});});io.emit('auction:update');res.json({ok:true,message:'All auction data has been removed.'});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/restore', upload.single('file'), async (req,res) => {if(req.body?.confirm!=='RESTORE BACKUP')return res.status(400).json({error:'Type RESTORE BACKUP to confirm'});try{if(!req.file)throw new Error('Choose a backup JSON file');const backup=JSON.parse(req.file.buffer.toString('utf8'));const allowed=['teams','players','team_squads','auction_bids','trades','auction_events'];if(!backup.tables||allowed.some(t=>!Array.isArray(backup.tables[t])))throw new Error('Invalid backup format');await withTransaction(async s=>{for(const n of allowed){const c=await col(n);await c.deleteMany({}, {session:s});if(backup.tables[n].length)await c.insertMany(backup.tables[n].map(x=>({...x,created_at:x.created_at?new Date(x.created_at):now()})),{session:s});}});await ensureIndexes();io.emit('auction:update');res.json({ok:true,message:'Backup restored'});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/latest-team', async (_req,res) => {try{const e=await (await col('auction_events')).find({team_id:{$ne:null},event_type:{$in:['SOLD','RTM','RETENTION','TRADE']}}).sort({id:-1}).limit(1).next();const t=e?await (await col('teams')).findOne({id:e.team_id}):null;res.json(t?{id:t.id,name:t.name}:null);}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/history', async (_req,res) => {try{const events=await (await col('auction_events')).find({}).sort({id:-1}).limit(200).toArray();const pids=[...new Set(events.map(e=>e.player_id).filter(Boolean))],tids=[...new Set(events.flatMap(e=>[e.team_id,e.details?.from_team_id]).filter(Boolean))];const ps=await (await col('players')).find({id:{$in:pids}}).toArray(),ts=await (await col('teams')).find({id:{$in:tids}}).toArray();const pm=new Map(ps.map(x=>[x.id,x.name])),tm=new Map(ts.map(x=>[x.id,x.name]));res.json(events.map(e=>({...e,player_name:pm.get(e.player_id)||null,team_name:tm.get(e.team_id)||null,seller_team_name:tm.get(e.details?.from_team_id)||null})));}catch(e){res.status(500).json({error:e.message});}});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const ready = Promise.all([clientPromise, ensureIndexes()]).then(seedTeamsIfEmpty);
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  ready.then(() => server.listen(PORT, () => console.log(`SNK Cricket Mega Auction running at http://localhost:${PORT} (MongoDB: ${dbName})`)))
    .catch(err => { console.error('Startup failed:', err); process.exit(1); });
}
module.exports = { app, server, io, ready };
