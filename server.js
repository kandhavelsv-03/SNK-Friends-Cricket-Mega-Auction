'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
const { Server } = require('socket.io');
const { TEAM_CONFIG, money, effectiveOverseas, validateSquadAddition, calculateTradePurses } = require('./lib/auction-rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'cricket_auction';
if (!MONGODB_URI) console.warn('MONGODB_URI is not configured. Set it in your environment before starting the app.');

let mongoClient;
let db;
let dbPromise;

async function connectDB() {
  if (db) return db;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is required. Configure your MongoDB Atlas connection string.');
  if (!dbPromise) {
    dbPromise = (async () => {
      mongoClient = new MongoClient(MONGODB_URI, {
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000)
      });
      await mongoClient.connect();
      db = mongoClient.db(DB_NAME);
      await ensureIndexes();
      await seedTeamsIfEmpty();
      return db;
    })().catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

async function ensureIndexes() {
  try { await db.createCollection('players'); } catch (error) { if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error; }
  // A prior experimental migration may have created a unique normalized-name index.
  // Keep a regular index instead so all source workbook rows (including same-name rows) survive import.
  const playerIndexes = await db.collection('players').listIndexes().toArray();
  const normalizedNameIndex = playerIndexes.find(index => index.key?.name_normalized === 1);
  if (normalizedNameIndex?.unique) await db.collection('players').dropIndex(normalizedNameIndex.name);
  await Promise.all([
    db.collection('teams').createIndex({ id: 1 }, { unique: true }),
    db.collection('teams').createIndex({ name: 1 }, { unique: true }),
    db.collection('players').createIndex({ id: 1 }, { unique: true }),
    db.collection('players').createIndex({ name_normalized: 1 }),
    db.collection('players').createIndex({ status: 1, name: 1 }),
    db.collection('team_squads').createIndex({ id: 1 }, { unique: true }),
    db.collection('team_squads').createIndex({ player_id: 1 }, { unique: true }),
    db.collection('team_squads').createIndex({ team_id: 1 }),
    db.collection('auction_bids').createIndex({ id: 1 }, { unique: true }),
    db.collection('auction_bids').createIndex({ player_id: 1, amount: -1 }),
    db.collection('trades').createIndex({ id: 1 }, { unique: true }),
    db.collection('auction_events').createIndex({ id: 1 }, { unique: true }),
    db.collection('auction_events').createIndex({ player_id: 1, id: -1 }),
    
  ]);
}

async function nextId(counterName, count = 1, mongoSession) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid ID allocation count');
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: counterName }, { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after', ...(mongoSession ? { session: mongoSession } : {}) }
  );
  const last = result && result.seq;
  return count === 1 ? last : { first: last - count + 1, last };
}

async function setCounter(counterName, seq, mongoSession) {
  await db.collection('counters').updateOne({ _id: counterName }, { $set: { seq } }, { upsert: true, ...(mongoSession ? { session: mongoSession } : {}) });
}

async function seedTeamsIfEmpty() {
  const teams = db.collection('teams');
  const meta = db.collection('app_meta');
  if (await teams.countDocuments() > 0) {
    await meta.updateOne({ _id: 'snk_default_teams_seeded' }, { $set: { value: true } }, { upsert: true });
    return;
  }
  if (await meta.findOne({ _id: 'snk_default_teams_seeded' })) return;
  const docs = TEAM_CONFIG.map(([code, purse], index) => ({
    id: index + 1, name: code, short_name: code, logo_url: '',
    initial_purse: purse, remaining_purse: purse, indian_rtm: 3, overseas_rtm: 3,
    created_at: new Date()
  }));
  await teams.insertMany(docs, { ordered: true });
  await setCounter('teams', docs.length);
  await meta.updateOne({ _id: 'snk_default_teams_seeded' }, { $set: { value: true } }, { upsert: true });
  console.log(`Seeded ${docs.length} SNK teams.`);
}

async function getDb() { return connectDB(); }
const C = name => db.collection(name);
const parseId = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid record ID');
  return id;
};
const normalizeName = value => String(value || '').trim().toLocaleLowerCase('en');
const safeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const createdAt = value => value instanceof Date ? value : (value ? new Date(value) : new Date());

async function getTeamState(teamId, mongoSession) {
  const opts = mongoSession ? { session: mongoSession } : {};
  const team = await C('teams').findOne({ id: parseId(teamId) }, opts);
  if (!team) throw new Error('Team not found');
  const squad = await C('team_squads').find({ team_id: team.id }, opts).toArray();
  const playerIds = squad.map(row => row.player_id);
  const players = playerIds.length ? await C('players').find({ id: { $in: playerIds } }, opts).toArray() : [];
  const counts = { Indian: 0, Overseas: 0, Associate: 0 };
  for (const player of players) if (Object.prototype.hasOwnProperty.call(counts, player.category)) counts[player.category]++;
  const total = counts.Indian + counts.Overseas + counts.Associate;
  return { team, counts, total, effOverseas: effectiveOverseas(counts) };
}

async function validateAddition(teamId, player, amount, mongoSession) {
  const state = await getTeamState(teamId, mongoSession);
  validateSquadAddition(state.counts, state.team.remaining_purse, amount, player.category);
  return state;
}

async function addPlayerToTeam(teamId, player, amount, type, mongoSession) {
  const state = await validateAddition(teamId, player, amount, mongoSession);
  const opts = mongoSession ? { session: mongoSession } : {};
  const amt = money(amount);
  await C('teams').updateOne({ id: state.team.id }, { $inc: { remaining_purse: -amt } }, opts);
  await C('team_squads').insertOne({
    id: await nextId('team_squads', 1, mongoSession), team_id: state.team.id, player_id: player.id,
    amount: amt, acquisition_type: type, created_at: new Date()
  }, opts);
  await C('players').updateOne({ id: player.id }, { $set: {
    status: type === 'Retention' ? 'RETAINED' : 'SOLD', current_team_id: state.team.id,
    sold_price: amt, acquisition_type: type
  } }, opts);
}

async function insertEvent({ player_id = null, team_id = null, event_type, amount = null, details = null }, mongoSession) {
  const doc = { id: await nextId('auction_events', 1, mongoSession), player_id, team_id, event_type, amount, details, created_at: new Date() };
  await C('auction_events').insertOne(doc, mongoSession ? { session: mongoSession } : {});
  return doc;
}

async function inTransaction(work) {
  await getDb();
  const mongoSession = mongoClient.startSession();
  try {
    let result;
    await mongoSession.withTransaction(async () => { result = await work(mongoSession); });
    return result;
  } finally { await mongoSession.endSession(); }
}

function handleError(res, error, status = 400) {
  if (res.headersSent) return;
  res.status(status).json({ error: error && error.message ? error.message : 'Unexpected server error' });
}

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-deploying',
  resave: false, saveUninitialized: false,
  store: MONGODB_URI ? MongoStore.create({ mongoUrl: MONGODB_URI, dbName: DB_NAME, collectionName: 'sessions', ttl: 14 * 24 * 60 * 60 }) : undefined,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  socket.on('broadcast:state', async payload => {
    if (!payload || typeof payload !== 'object') return;
    const safe = {
      status: String(payload.status || 'AUCTION LIVE').slice(0, 24),
      player: String(payload.player || 'Waiting for next player').slice(0, 150),
      details: String(payload.details || '').slice(0, 250),
      teamShort: String(payload.teamShort || '').slice(0, 20),
      amount: String(payload.amount || '').slice(0, 30),
      updated_at: new Date()
    };
    try { await getDb(); await C('broadcast_state').updateOne({ _id: 'current' }, { $set: safe }, { upsert: true }); } catch (error) { console.error('Broadcast state persistence failed:', error.message); }
    socket.broadcast.emit('broadcast:state', safe);
  });
});

app.get('/api/health', async (_, res) => {
  try { await getDb(); res.json({ ok: true, database: 'MongoDB Atlas', db: DB_NAME }); }
  catch (error) { handleError(res, error, 503); }
});

app.get('/api/teams', async (_, res) => {
  try {
    await getDb();
    const teams = await C('teams').find({}).sort({ name: 1 }).toArray();
    const output = [];
    for (const team of teams) {
      const state = await getTeamState(team.id);
      output.push({ ...team, squad_size: state.total, indian_count: state.counts.Indian,
        overseas_count: state.counts.Overseas, associate_count: state.counts.Associate,
        effective_overseas: state.effOverseas, spent: money(team.initial_purse - team.remaining_purse) });
    }
    res.json(output);
  } catch (error) { handleError(res, error, 500); }
});

app.post('/api/teams', async (req, res) => {
  try {
    await getDb();
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Team name required');
    const id = await nextId('teams');
    const purse = Number.isFinite(Number(req.body.initial_purse)) ? money(req.body.initial_purse) : 90;
    await C('teams').insertOne({ id, name, short_name: String(req.body.short_name || '').trim(),
      logo_url: String(req.body.logo_url || ''), initial_purse: purse, remaining_purse: purse,
      indian_rtm: 3, overseas_rtm: 3, created_at: new Date() });
    io.emit('auction:update'); res.json({ id, name });
  } catch (error) { handleError(res, error); }
});

app.get('/api/players', async (req, res) => {
  try {
    await getDb();
    const query = {};
    if (req.query.status) query.status = String(req.query.status);
    if (req.query.category) query.category = String(req.query.category);
    if (req.query.role) query.role = String(req.query.role);
    if (req.query.search) query.name = { $regex: safeRegex(req.query.search), $options: 'i' };
    const rows = await C('players').find(query).sort({ name: 1 }).toArray();
    const teamIds = [...new Set(rows.map(player => player.current_team_id).filter(Boolean))];
    const teamRows = teamIds.length ? await C('teams').find({ id: { $in: teamIds } }).toArray() : [];
    const teamMap = new Map(teamRows.map(team => [team.id, team.name]));
    res.json(rows.map(player => ({ ...player, current_team: teamMap.get(player.current_team_id) || null })));
  } catch (error) { handleError(res, error, 500); }
});

app.post('/api/players', async (req, res) => {
  try {
    await getDb();
    const p = req.body || {};
    if (!String(p.name || '').trim() || !['Indian', 'Overseas', 'Associate'].includes(p.category)) throw new Error('Player name and valid category required');
    const name = String(p.name).trim();
    const id = await nextId('players');
    await C('players').insertOne({ id, name, name_normalized: normalizeName(name), country: String(p.country || ''),
      category: p.category, role: p.role || 'Batter', previous_price: money(p.previous_price || 0),
      previous_team: String(p.previous_team || ''), base_price: money(p.base_price || 0.5),
      photo_url: p.photo_url || null, status: 'AVAILABLE', current_team_id: null,
      sold_price: null, acquisition_type: null, created_at: new Date() });
    io.emit('auction:update'); res.json({ id });
  } catch (error) { handleError(res, error); }
});

async function importTeamCodes(workbook) {
  const sheet = workbook.Sheets['Team Code Reference'];
  if (!sheet) return { teamsImported: 0, teamsSkipped: 0 };
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const codes = [...new Set(rows.map(row => String(row['Previous Team Code'] || '').trim()).filter(Boolean))];
  const current = await C('teams').find({ short_name: { $in: codes } }).toArray();
  const currentCodes = new Set(current.map(team => team.short_name));
  // Historical/previous-season codes are references, not additional auction franchises.
  return { teamsImported: 0, teamsSkipped: codes.filter(code => currentCodes.has(code)).length };
}

app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    await getDb();
    if (!req.file) throw new Error('Choose an Excel file');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets['Player Import'] || workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('No player worksheet found');
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const teamImport = await importTeamCodes(workbook);
    const existing = await C('players').find({}, { projection: { name_normalized: 1 } }).toArray();
    const names = new Set(existing.map(row => row.name_normalized || normalizeName(row.name)));
    const pending = [];
    let skipped = 0;
    for (const row of rows) {
      const norm = {};
      Object.keys(row).forEach(key => { norm[key.toLowerCase().trim().replace(/[^a-z0-9]/g, '')] = row[key]; });
      const rawName = norm.playername || norm.name || norm.player;
      const name = String(rawName || '').trim();
      if (!name) { skipped++; continue; }
      const category = String(norm.category || norm.countrycategory || norm.type || '').trim();
      if (!['Indian', 'Overseas', 'Associate'].includes(category)) { skipped++; continue; }
      const normalized = normalizeName(name);
      if (names.has(normalized)) { skipped++; continue; }
      const role = String(norm.role || norm.playerrole || 'Batter').trim();
      const previousPrice = Number(norm.previousprice || norm.previoussoldprice || norm.soldprice || 0);
      const baseRaw = norm.baseprice;
      const basePrice = baseRaw === undefined || baseRaw === '' ? 0.5 : Number(String(baseRaw).replace(/[₹,]/g, '').replace(/\s*Cr\s*/i, '').replace(/C$/i, ''));
      const previousTeam = String(norm.previousteam || norm.team || '').trim();
      const country = String(norm.country || category);
      const photoUrl = String(norm.photourl || norm.photo || norm.imageurl || '').trim();
      pending.push({ name, name_normalized: normalized, country, category,
        role: ['Batter', 'Batting All-Rounder', 'Bowling All-Rounder', 'Bowler', 'Wicket Keeper'].includes(role) ? role : 'Batter',
        previous_price: Number.isFinite(previousPrice) ? money(previousPrice) : 0, previous_team: previousTeam,
        base_price: Number.isFinite(basePrice) && basePrice > 0 ? money(basePrice) : 0.5,
        photo_url: photoUrl || null, status: 'AVAILABLE', current_team_id: null,
        sold_price: null, acquisition_type: null, created_at: new Date() });
    }
    if (pending.length) {
      const range = await nextId('players', pending.length);
      pending.forEach((player, index) => { player.id = range.first + index; });
      await C('players').insertMany(pending, { ordered: true });
    }
    io.emit('auction:update');
    res.json({ imported: pending.length, skipped, ...teamImport });
  } catch (error) { handleError(res, error); }
});

app.post('/api/retention', async (req, res) => {
  try {
    await inTransaction(async mongoSession => {
      const playerId = parseId(req.body.player_id), teamId = parseId(req.body.team_id), amount = req.body.amount;
      const player = await C('players').findOne({ id: playerId, status: 'AVAILABLE' }, { session: mongoSession });
      if (!player) throw new Error('Player is not available for retention');
      const team = await C('teams').findOne({ id: teamId }, { session: mongoSession });
      if (!team) throw new Error('Team not found');
      if (!player.previous_team || player.previous_team.trim().toLowerCase() !== team.name.trim().toLowerCase()) throw new Error("A player can only be retained by their previous-season team");
      const field = player.category === 'Indian' ? 'indian_rtm' : 'overseas_rtm';
      if (team[field] <= 0) throw new Error('No matching RTM entitlement remains for this category');
      await addPlayerToTeam(teamId, player, amount, 'Retention', mongoSession);
      await C('teams').updateOne({ id: teamId }, { $inc: { [field]: -1 } }, { session: mongoSession });
      await insertEvent({ player_id: playerId, team_id: teamId, event_type: 'RETENTION', amount: money(amount) }, mongoSession);
    });
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/release', async (req, res) => {
  try {
    await inTransaction(async mongoSession => {
      const playerId = parseId(req.body.player_id);
      const result = await C('players').updateOne({ id: playerId, status: 'RETAINED' },
        { $set: { status: 'AVAILABLE', current_team_id: null, sold_price: null, acquisition_type: null } }, { session: mongoSession });
      if (!result.matchedCount) throw new Error('Retained player not found');
      await C('team_squads').deleteOne({ player_id: playerId }, { session: mongoSession });
      await insertEvent({ player_id: playerId, event_type: 'RELEASE' }, mongoSession);
    });
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/trade', async (req, res) => {
  try {
    const result = await inTransaction(async mongoSession => {
      const playerId = parseId(req.body.player_id), sellerId = parseId(req.body.from_team_id), buyerId = parseId(req.body.to_team_id);
      if (sellerId === buyerId) throw new Error('Choose a different buying team');
      const player = await C('players').findOne({ id: playerId, current_team_id: sellerId }, { session: mongoSession });
      if (!player) throw new Error('Player does not belong to selling team');
      const teams = await C('teams').find({ id: { $in: [sellerId, buyerId] } }, { session: mongoSession }).toArray();
      const seller = teams.find(team => team.id === sellerId), buyer = teams.find(team => team.id === buyerId);
      if (!seller) throw new Error('Seller team not found');
      if (!buyer) throw new Error('Buyer team not found');
      const purse = calculateTradePurses(buyer.remaining_purse, seller.remaining_purse, req.body.amount);
      await validateAddition(buyerId, player, req.body.amount, mongoSession);
      await C('team_squads').deleteOne({ player_id: playerId }, { session: mongoSession });
      // Debit the buyer and credit the seller by the same trade amount.
      await C('teams').updateOne({ id: buyerId }, { $inc: { remaining_purse: -purse.buyer_purse_deducted } }, { session: mongoSession });
      await C('teams').updateOne({ id: sellerId }, { $inc: { remaining_purse: purse.seller_purse_credited } }, { session: mongoSession });
      await C('team_squads').insertOne({ id: await nextId('team_squads', 1, mongoSession), team_id: buyerId, player_id: playerId,
        amount: purse.buyer_purse_deducted, acquisition_type: 'Trade', created_at: new Date() }, { session: mongoSession });
      await C('players').updateOne({ id: playerId }, { $set: { current_team_id: buyerId,
        sold_price: purse.buyer_purse_deducted, acquisition_type: 'Trade' } }, { session: mongoSession });
      await C('trades').insertOne({ id: await nextId('trades', 1, mongoSession), player_id: playerId, from_team_id: sellerId,
        to_team_id: buyerId, amount: purse.buyer_purse_deducted, created_at: new Date() }, { session: mongoSession });
      await insertEvent({ player_id: playerId, team_id: buyerId, event_type: 'TRADE', amount: purse.buyer_purse_deducted,
        details: { from_team_id: sellerId, to_team_id: buyerId, buyer_purse_deduction: true, seller_purse_credit: true } }, mongoSession);
      return { ok: true, amount: purse.buyer_purse_deducted, ...purse };
    });
    io.emit('auction:update'); res.json(result);
  } catch (error) { handleError(res, error); }
});

app.post('/api/bid', async (req, res) => {
  try {
    await getDb();
    const playerId = parseId(req.body.player_id), teamId = parseId(req.body.team_id);
    const player = await C('players').findOne({ id: playerId, status: 'AVAILABLE' });
    if (!player) throw new Error('Player is not available');
    await validateAddition(teamId, player, req.body.amount);
    const amount = money(req.body.amount);
    await C('auction_bids').insertOne({ id: await nextId('auction_bids'), player_id: playerId,
      team_id: teamId, amount, created_at: new Date() });
    const team = await C('teams').findOne({ id: teamId }, { projection: { name: 1 } });
    if (!team) throw new Error('Team not found');
    io.emit('auction:bid', { player_id: playerId, team_id: teamId, team: team.name, amount });
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/sold', async (req, res) => {
  try {
    await inTransaction(async mongoSession => {
      const playerId = parseId(req.body.player_id), teamId = parseId(req.body.team_id);
      const player = await C('players').findOne({ id: playerId, status: 'AVAILABLE' }, { session: mongoSession });
      if (!player) throw new Error('Player is not available');
      await addPlayerToTeam(teamId, player, req.body.amount, 'Auction', mongoSession);
      await insertEvent({ player_id: playerId, team_id: teamId, event_type: 'SOLD', amount: money(req.body.amount) }, mongoSession);
    });
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/unsold', async (req, res) => {
  try {
    await getDb();
    const playerId = parseId(req.body.player_id);
    const result = await C('players').updateOne({ id: playerId, status: 'AVAILABLE' },
      { $set: { status: 'UNSOLD', current_team_id: null } });
    if (!result.matchedCount) throw new Error('Player is not available');
    await insertEvent({ player_id: playerId, event_type: 'UNSOLD' });
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/reauction', async (req, res) => {
  try {
    await getDb();
    const result = await C('players').updateOne({ id: parseId(req.body.player_id), status: 'UNSOLD' }, { $set: { status: 'AVAILABLE' } });
    if (!result.matchedCount) throw new Error('Player is not unsold');
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/rtm', async (req, res) => {
  try {
    await inTransaction(async mongoSession => {
      const playerId = parseId(req.body.player_id), teamId = parseId(req.body.team_id);
      const player = await C('players').findOne({ id: playerId, status: 'AVAILABLE' }, { session: mongoSession });
      if (!player) throw new Error('Player is not available');
      if (!player.previous_team) throw new Error('Previous team is not recorded; RTM eligibility cannot be verified');
      const team = await C('teams').findOne({ id: teamId, name: new RegExp(`^${safeRegex(player.previous_team.trim())}$`, 'i') }, { session: mongoSession });
      if (!team) throw new Error("Only the player's previous team can use RTM");
      const field = player.category === 'Indian' ? 'indian_rtm' : 'overseas_rtm';
      if (team[field] <= 0) throw new Error('No eligible RTM card remains');
      await addPlayerToTeam(teamId, player, req.body.amount, 'RTM', mongoSession);
      await C('teams').updateOne({ id: teamId }, { $inc: { [field]: -1 } }, { session: mongoSession });
      await insertEvent({ player_id: playerId, team_id: teamId, event_type: 'RTM', amount: money(req.body.amount) }, mongoSession);
    });
    io.emit('auction:update'); res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get('/api/player/:id', async (req, res) => {
  try {
    await getDb();
    const playerId = parseId(req.params.id);
    const player = await C('players').findOne({ id: playerId });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const team = player.current_team_id ? await C('teams').findOne({ id: player.current_team_id }) : null;
    const bidsRaw = await C('auction_bids').find({ player_id: playerId }).sort({ amount: -1, id: -1 }).limit(10).toArray();
    const bidTeams = bidsRaw.length ? await C('teams').find({ id: { $in: bidsRaw.map(bid => bid.team_id) } }).toArray() : [];
    const bidTeamMap = new Map(bidTeams.map(row => [row.id, row]));
    const bids = bidsRaw.map(bid => ({ ...bid, team_name: bidTeamMap.get(bid.team_id)?.name || '', short_name: bidTeamMap.get(bid.team_id)?.short_name || '' }));
    const events = await C('auction_events').find({ player_id: playerId }).sort({ id: -1 }).limit(10).toArray();
    res.json({ player: { ...player, current_team: team?.name || null, current_team_short: team?.short_name || null }, bids, events });
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/nomination-queue', async (_, res) => {
  try {
    await getDb();
    const rows = await C('players').find({ status: 'AVAILABLE' }, { projection: { id: 1, name: 1, category: 1, role: 1, base_price: 1, photo_url: 1 } }).sort({ category: 1, role: 1, name: 1 }).toArray();
    res.json(rows);
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/squad/:teamId', async (req, res) => {
  try {
    await getDb();
    const teamId = parseId(req.params.teamId);
    const squad = await C('team_squads').find({ team_id: teamId }).sort({ id: 1 }).toArray();
    const playerIds = squad.map(row => row.player_id);
    const players = playerIds.length ? await C('players').find({ id: { $in: playerIds } }).toArray() : [];
    const playerMap = new Map(players.map(player => [player.id, player]));
    res.json(squad.map(row => ({ ...(playerMap.get(row.player_id) || {}), amount: row.amount, acquisition_type: row.acquisition_type }))
      .filter(player => player.id));
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/stats', async (_, res) => {
  try {
    await getDb();
    const [total, available, sold, unsold, retained] = await Promise.all([
      C('players').countDocuments(), C('players').countDocuments({ status: 'AVAILABLE' }),
      C('players').countDocuments({ status: 'SOLD' }), C('players').countDocuments({ status: 'UNSOLD' }),
      C('players').countDocuments({ status: 'RETAINED' })
    ]);
    const spending = await C('team_squads').aggregate([{ $group: { _id: null, total_spend: { $sum: '$amount' } } }]).toArray();
    res.json({ total, available, sold, unsold, retained, total_spend: spending[0]?.total_spend || 0 });
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/reports.xlsx', async (_, res) => {
  try {
    await getDb();
    const teams = await C('teams').find({}).sort({ name: 1 }).toArray();
    const players = await C('players').find({}).sort({ name: 1 }).toArray();
    const teamMap = new Map(teams.map(team => [team.id, team.name]));
    const playerRows = players.map(player => ({ name: player.name, country: player.country, category: player.category,
      role: player.role, status: player.status, previous_team: player.previous_team, base_price: player.base_price,
      sold_price: player.sold_price, current_team: teamMap.get(player.current_team_id) || '' }));
    const trades = await C('trades').find({}).sort({ id: -1 }).toArray();
    const tradeRows = trades.map(trade => ({ player: players.find(p => p.id === trade.player_id)?.name || '',
      seller: teamMap.get(trade.from_team_id) || '', buyer: teamMap.get(trade.to_team_id) || '',
      amount: trade.amount, created_at: trade.created_at }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(teams.map(team => ({ id: team.id, name: team.name,
      short_name: team.short_name, initial_purse: team.initial_purse, remaining_purse: team.remaining_purse,
      indian_rtm: team.indian_rtm, overseas_rtm: team.overseas_rtm }))), 'Teams & Purse');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(playerRows), 'Player Register');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tradeRows), 'Trade History');
    const data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="SNK_Friends_Auction_Report.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(data);
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/backup', async (_, res) => {
  try {
    await getDb();
    const backup = { app: 'SNK Friends Cricket Mega Auction', version: 2, database: 'MongoDB', created_at: new Date().toISOString(), tables: {} };
    for (const collection of ['teams', 'players', 'team_squads', 'auction_bids', 'trades', 'auction_events']) {
      backup.tables[collection] = await C(collection).find({}).sort({ id: 1 }).toArray();
    }
    res.setHeader('Content-Disposition', 'attachment; filename="SNK_Friends_Auction_Backup.json"');
    res.json(backup);
  } catch (error) { handleError(res, error, 500); }
});

app.post('/api/reset-all-data', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE ALL DATA') throw new Error('Reset confirmation phrase is required');
    await inTransaction(async mongoSession => {
      for (const collection of ['auction_bids', 'trades', 'auction_events', 'team_squads', 'players', 'teams']) {
        await C(collection).deleteMany({}, { session: mongoSession });
      }
      for (const counter of ['auction_bids', 'trades', 'auction_events', 'team_squads', 'players', 'teams']) {
        await setCounter(counter, 0, mongoSession);
      }
    });
    io.emit('auction:update'); res.json({ ok: true, message: 'All auction data has been removed.' });
  } catch (error) { handleError(res, error, 500); }
});

app.post('/api/restore', upload.single('file'), async (req, res) => {
  try {
    if (req.body?.confirm !== 'RESTORE BACKUP') throw new Error('Type RESTORE BACKUP to confirm');
    if (!req.file) throw new Error('Choose a backup JSON file');
    const backup = JSON.parse(req.file.buffer.toString('utf8'));
    const allowed = ['teams', 'players', 'team_squads', 'auction_bids', 'trades', 'auction_events'];
    if (!backup.tables || allowed.some(name => !Array.isArray(backup.tables[name]))) throw new Error('Invalid backup format');
    await inTransaction(async mongoSession => {
      for (const name of allowed) {
        await C(name).deleteMany({}, { session: mongoSession });
        const rows = backup.tables[name].map(row => {
          const doc = { ...row };
          delete doc._id;
          if (doc.created_at) doc.created_at = createdAt(doc.created_at);
          if (name === 'players' && !doc.name_normalized) doc.name_normalized = normalizeName(doc.name);
          return doc;
        });
        if (rows.length) await C(name).insertMany(rows, { ordered: true, session: mongoSession });
        await setCounter(name, rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0), mongoSession);
      }
    });
    io.emit('auction:update'); res.json({ ok: true, message: 'Backup restored' });
  } catch (error) { handleError(res, error); }
});

app.get('/api/latest-team', async (_, res) => {
  try {
    await getDb();
    const event = await C('auction_events').find({ event_type: { $in: ['SOLD', 'RTM', 'RETENTION', 'TRADE'] }, team_id: { $ne: null } }).sort({ id: -1 }).limit(1).next();
    const team = event ? await C('teams').findOne({ id: event.team_id }, { projection: { id: 1, name: 1 } }) : null;
    res.json(team || null);
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/history', async (_, res) => {
  try {
    await getDb();
    const events = await C('auction_events').find({}).sort({ id: -1 }).limit(200).toArray();
    const playerIds = [...new Set(events.map(event => event.player_id).filter(Boolean))];
    const teamIds = [...new Set(events.flatMap(event => [event.team_id, event.details?.from_team_id]).filter(Boolean))];
    const [players, teams] = await Promise.all([
      playerIds.length ? C('players').find({ id: { $in: playerIds } }).toArray() : [],
      teamIds.length ? C('teams').find({ id: { $in: teamIds } }).toArray() : []
    ]);
    const playerMap = new Map(players.map(player => [player.id, player.name]));
    const teamMap = new Map(teams.map(team => [team.id, team.name]));
    res.json(events.map(event => ({ ...event, player_name: playerMap.get(event.player_id) || null,
      team_name: teamMap.get(event.team_id) || null,
      seller_team_name: teamMap.get(event.details?.from_team_id) || null })));
  } catch (error) { handleError(res, error, 500); }
});

app.get('/api/broadcast/state', async (_, res) => {
  try {
    await getDb();
    const state = await C('broadcast_state').findOne({ _id: 'current' });
    res.json(state || { status: 'AUCTION LIVE', player: 'Waiting for next player', details: '', teamShort: '', amount: '' });
  } catch (error) { handleError(res, error, 500); }
});

app.post('/api/broadcast/state', async (req, res) => {
  try {
    await getDb();
    const payload = req.body || {};
    const safe = { status: String(payload.status || 'AUCTION LIVE').slice(0, 24),
      player: String(payload.player || 'Waiting for next player').slice(0, 150),
      details: String(payload.details || '').slice(0, 250), teamShort: String(payload.teamShort || '').slice(0, 20),
      amount: String(payload.amount || '').slice(0, 30), updated_at: new Date() };
    await C('broadcast_state').updateOne({ _id: 'current' }, { $set: safe }, { upsert: true });
    io.emit('broadcast:state', safe);
    res.json({ ok: true });
  } catch (error) { handleError(res, error, 500); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  connectDB().then(() => {
    server.listen(PORT, () => console.log(`SNK Friends Cricket Mega Auction running on port ${PORT} · MongoDB database: ${DB_NAME}`));
  }).catch(error => {
    console.error('MongoDB startup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, server, io, connectDB, inTransaction };
