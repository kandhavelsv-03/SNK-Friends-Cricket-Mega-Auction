
'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const session = require('express-session');

const MongoStoreModule = require('connect-mongo');
const MongoStore = MongoStoreModule.default || MongoStoreModule.MongoStore;

const multer = require('multer');
const XLSX = require('xlsx');
const { MongoClient } = require('mongodb');
const { Server } = require('socket.io');
const { TEAM_CONFIG } = require('./lib/auction-rules');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'cricket_auction';

if (!mongoUri) {
  throw new Error('MONGODB_URI is required. Configure it in the environment before starting the auction server.');
}

const client = new MongoClient(mongoUri, {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
    serverSelectionTimeoutMS: Number(
      process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000
    )
  }
);

const clientPromise = client.connect();
const dbPromise = clientPromise.then(c => c.db(dbName));

const col = async name => (await dbPromise).collection(name);
const money = n => Number(Number(n).toFixed(2));
const now = () => new Date();

const effectiveOverseas = counts =>
  counts.Overseas + Math.max(0, counts.Associate - 2);


// INDEXES

async function ensureIndexes() {
  const db = await dbPromise;

  await Promise.all([
    db.collection('players').createIndex({ id: 1 }, { unique: true }),
    db.collection('players').createIndex({ status: 1, name: 1 }),
    db.collection('players').createIndex({ name_normalized: 1 }),

    db.collection('teams').createIndex({ id: 1 }, { unique: true }),
    db.collection('teams').createIndex(
      { short_name: 1 },
      { unique: true, sparse: true }
    ),

    db.collection('team_squads').createIndex(
      { player_id: 1 },
      { unique: true }
    ),

    db.collection('auction_bids').createIndex({
      player_id: 1,
      amount: -1,
      id: -1
    }),

    db.collection('auction_events').createIndex({ id: -1 }),
    db.collection('trades').createIndex({ id: -1 })
  ]);

  // Preserve existing numeric IDs.
  for (const name of [
    'players',
    'teams',
    'team_squads',
    'auction_bids',
    'trades',
    'auction_events'
  ]) {
    const last = await db.collection(name)
      .find({ id: { $type: 'number' } })
      .sort({ id: -1 })
      .limit(1)
      .next();

    if (last) {
      await db.collection('counters').updateOne(
        { _id: name },
        { $max: { seq: Number(last.id) } },
        { upsert: true }
      );
    }
  }
}


// SEED TEAMS

async function seedTeamsIfEmpty() {
  const teams = await col('teams');

  if (await teams.countDocuments() > 0) return;

  for (const [shortName, purse] of TEAM_CONFIG) {
    const id = await nextId('teams');

    const displayName = shortName === 'KD2' ? 'KD²' : shortName;

    await teams.insertOne({
      id,
      name: displayName,
      short_name: shortName,
      logo_url: `/assets/team-${shortName.toLowerCase()}.webp`,
      initial_purse: purse,
      remaining_purse: purse,
      indian_rtm: 3,
      overseas_rtm: 3,
      created_at: now()
    });
  }
}


// AUTO ID

async function nextId(name) {
  const c = await col('counters');

  const doc = await c.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );

  return Number(doc.seq);
}


// TRANSACTIONS

async function withTransaction(work) {
  const c = await clientPromise;
  const session = c.startSession();

  let result;

  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
}


// TEAM STATE

async function getTeamState(teamId, session) {
  const teams = await col('teams');

  const team = await teams.findOne(
    { id: Number(teamId) },
    { session }
  );

  if (!team) throw new Error('Team not found');

  const squad = await (await col('team_squads'))
    .find({ team_id: Number(teamId) }, { session })
    .toArray();

  const playerIds = squad.map(x => x.player_id);

  const players = playerIds.length
    ? await (await col('players'))
        .find({ id: { $in: playerIds } }, { session })
        .toArray()
    : [];

  const counts = {
    Indian: 0,
    Overseas: 0,
    Associate: 0
  };

  players.forEach(p => {
    if (counts[p.category] !== undefined) {
      counts[p.category]++;
    }
  });

  const total =
    counts.Indian + counts.Overseas + counts.Associate;

  return {
    team,
    counts,
    total,
    effOverseas: effectiveOverseas(counts)
  };
}


// ==========================================
// SQUAD VALIDATION
// ==========================================

async function validateAddition(teamId, player, amount, session) {
  const s = await getTeamState(teamId, session);
  const amt = money(amount);

  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error('Invalid amount');
  }

  if (!['Indian', 'Overseas', 'Associate'].includes(player.category)) {
    throw new Error('Invalid player category');
  }

  const remainingPurse = Number(s.team.remaining_purse);

  if (!Number.isFinite(remainingPurse) || remainingPurse < amt) {
    throw new Error('Insufficient purse');
  }

  const MAX_SQUAD = 20;
  const MIN_SQUAD = 17;
  const RESERVE_PER_SLOT = 0.50;

  if (s.total >= MAX_SQUAD) {
    throw new Error('Maximum squad size is 20');
  }

  const next = {
    Indian: Number(s.counts.Indian || 0),
    Overseas: Number(s.counts.Overseas || 0),
    Associate: Number(s.counts.Associate || 0)
  };

  next[player.category] += 1;

  const totalAfter = s.total + 1;
  const nextEff = effectiveOverseas(next);

  // Maximum category limits
  if (next.Indian > 9) {
    throw new Error('Indian maximum is 9');
  }

  if (nextEff > 9) {
    throw new Error('Effective Overseas maximum is 9');
  }

  if (next.Associate > 11) {
    throw new Error('Maximum Associate player count is 11');
  }

  // Remaining slots needed to reach minimum squad size
  const slotsAfter = Math.max(0, MIN_SQUAD - totalAfter);

  // Minimum category requirements
  const missingIndian = Math.max(0, 8 - next.Indian);
  const missingOverseas = Math.max(0, 8 - nextEff);
  const missingAssociate = Math.max(0, 1 - next.Associate);

  const missingCategorySlots =
    missingIndian + missingOverseas + missingAssociate;

  // Minimum category requirements may be completed any time before the
  // 20-player squad maximum; do not force them to be completed by player 17.
  const slotsAvailableBeforeMaximum = Math.max(0, MAX_SQUAD - totalAfter);
  if (missingCategorySlots > slotsAvailableBeforeMaximum) {
    throw new Error(
      'Minimum category requirements must be completed before the 20-player maximum'
    );
  }

  // Reserve ₹0.50 Cr for every missing minimum squad slot
  const reserve = money(slotsAfter * RESERVE_PER_SLOT);

  const purseAfterPurchase = money(remainingPurse - amt);

  if (purseAfterPurchase + 0.0001 < reserve) {
    throw new Error(
      `Keep at least Rs. ${reserve.toFixed(2)} Cr reserved for mandatory squad slots`
    );
  }

  return s;
}


// ==========================================
// ADD PLAYER TO TEAM
// ==========================================


async function addPlayerToTeam(teamId, player, amount, type, session) {
  await validateAddition(teamId, player, amount, session);
  const amt = money(amount);

  await (await col('team_squads')).insertOne({
    id: await nextId('team_squads'),
    team_id: Number(teamId),
    player_id: Number(player.id),
    amount: amt,
    acquisition_type: type,
    created_at: now()
  }, { session });
  
  await (await col('players')).updateOne(
    { id: Number(player.id) },
    {
      $set: {
        status: type === 'Retention' ? 'RETAINED' : 'SOLD',
        current_team_id: Number(teamId),
        sold_price: amt,
        acquisition_type: type
      }
    },
    { session }
  );

  // Deduct the winning/retention amount from the team's live remaining purse.
  const purseUpdate = await (await col('teams')).updateOne(
    { id: Number(teamId), remaining_purse: { $gte: amt } },
    { $inc: { remaining_purse: -amt } },
    { session }
  );
  if (!purseUpdate.modifiedCount) {
    throw new Error('Team does not have enough remaining purse');
  }
}

// AUCTION EVENT

async function addEvent(data, session) {
  await (await col('auction_events')).insertOne({
    id: await nextId('auction_events'),
    player_id: data.player_id ?? null,
    team_id: data.team_id ?? null,
    event_type: data.event_type,
    amount: data.amount ?? null,
    details: data.details || null,
    created_at: now()
  }, { session });
}


// SOCKET.IO

io.on('connection', socket => {
  socket.on('broadcast:state', payload => {
    if (!payload || typeof payload !== 'object') return;

    const safe = {
      status: String(payload.status || 'AUCTION LIVE').slice(0, 24),
      player: String(payload.player || 'Waiting for next player').slice(0, 150),
      details: String(payload.details || '').slice(0, 250),
      teamShort: String(payload.teamShort || '').slice(0, 20),
      amount: String(payload.amount || '').slice(0, 30),
      teamLogo: payload.teamShort === 'BR'
        ? '/assets/br-bulls-logo.png'
        : ''
    };

    socket.broadcast.emit('broadcast:state', safe);
  });
});


// MIDDLEWARE

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    clientPromise,
    dbName,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// BROADCAST STATE

app.get('/api/broadcast/state', async (_req, res) => {
  try {
    const state = await (await col('broadcast_state'))
      .findOne({ _id: 'current' });

    res.json(
      state?.state || {
        status: 'AUCTION LIVE',
        player: 'Waiting for next player',
        details: ''
      }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/broadcast/state', async (req, res) => {
  try {
    const p = req.body || {};

    const state = {
      status: String(p.status || 'AUCTION LIVE').slice(0, 24),
      player: String(p.player || 'Waiting for next player').slice(0, 150),
      details: String(p.details || '').slice(0, 250),
      teamShort: String(p.teamShort || '').slice(0, 20),
      amount: String(p.amount || '').slice(0, 30),
      teamLogo: p.teamShort === 'BR' ? '/assets/br-bulls-logo.png' : ''
    };

    await (await col('broadcast_state')).updateOne(
      { _id: 'current' },
      { $set: { state, updated_at: now() } },
      { upsert: true }
    );

    io.emit('broadcast:state', state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// HEALTH CHECK

app.get('/api/health', async (_req, res) => {
  try {
    await dbPromise;

    await (await col('app_meta')).updateOne(
      { _id: 'health' },
      { $set: { checked_at: now() } },
      { upsert: true }
    );

    res.json({
      ok: true,
      database: dbName,
      provider: 'mongodb'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// TEAMS

app.get('/api/teams', async (_req, res) => {
  try {
    const teams = await (await col('teams'))
      .find({})
      .sort({ name: 1 })
      .toArray();

    const out = [];

    for (const t of teams) {
      const s = await getTeamState(t.id);

      out.push({
        ...t,
        squad_size: s.total,
        indian_count: s.counts.Indian,
        overseas_count: s.counts.Overseas,
        associate_count: s.counts.Associate,
        effective_overseas: s.effOverseas,
        spent: money(
          Number(t.initial_purse || 0) -
          Number(t.remaining_purse || 0)
        )
      });
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/teams', async (req, res) => {
  try {
    const { name, short_name, logo_url } = req.body;

    if (!name) throw new Error('Team name required');

    const id = await nextId('teams');

    const doc = {
      id,
      name: String(name).trim(),
      short_name: short_name || '',
      logo_url: logo_url || '',
      initial_purse: 90,
      remaining_purse: 90,
      indian_rtm: 3,
      overseas_rtm: 3,
      created_at: now()
    };

    await (await col('teams')).insertOne(doc);

    res.json({ id, name: doc.name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// PLAYERS

app.get('/api/players', async (req, res) => {
  try {
    const q = {};
    const { status, search, category, role } = req.query;

    if (status) q.status = status;
    if (category) q.category = category;
    if (role) q.role = role;

    if (search) {
      q.name = {
        $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        $options: 'i'
      };
    }

    const rows = await (await col('players'))
      .find(q)
      .sort({ id: 1 })
      .toArray();

    const teams = await (await col('teams')).find({}).toArray();
    const tm = new Map(teams.map(t => [t.id, t.name]));

    res.json(rows.map(p => ({
      ...p,
      current_team: tm.get(p.current_team_id) || null
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players', async (req, res) => {
  try {
    const p = req.body;

    if (!p.name || !['Indian', 'Overseas', 'Associate'].includes(p.category)) {
      throw new Error('Player name and valid category required');
    }

    const normalized = String(p.name).trim().toLowerCase();

    const existing = await (await col('players'))
      .findOne({ name_normalized: normalized });

    if (existing) throw new Error('Player already exists');

    const id = await nextId('players');

    await (await col('players')).insertOne({
      id,
      name: String(p.name).trim(),
      name_normalized: normalized,
      country: p.country || '',
      category: p.category,
      role: p.role || 'Batter',
      previous_price: Number(p.previous_price || 0),
      previous_team: p.previous_team || '',
      base_price: Number(p.base_price || 0.5),
      photo_url: p.photo_url || null,
      status: 'AVAILABLE',
      current_team_id: null,
      sold_price: null,
      acquisition_type: null,
      created_at: now()
    });

    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// IMPORT TEAM CODES

async function importTeamCodes(wb) {
  const sh = wb.Sheets['Team Code Reference'];

  if (!sh) {
    return { teamsImported: 0, teamsSkipped: 0 };
  }

  const rows = XLSX.utils.sheet_to_json(sh, { defval: '' });

  const purses = {
    KCG: 90,
    ARC: 90,
    DCS: 90,
    VTK: 90,
    SS: 90,
    FCK: 90,
    TG: 90,
    BBC: 90,
    AKS: 90,
    KD2: 90,
    BR: 90,
    CC: 90,
    RH: 90,
    '7SV': 90
  };
  const teams = await col('teams');

  const existing = new Set(
    (await teams.find({}, { projection: { short_name: 1 } }).toArray())
      .map(t => String(t.short_name || '').toUpperCase())
  );

  const pending = [];
  let teamsSkipped = 0;

  for (const row of rows) {
    const rawCode = String(row['Previous Team Code'] || '').trim();

    if (!rawCode) continue;

    const code = rawCode.replace('²', '2').toUpperCase();

    if (existing.has(code)) {
      teamsSkipped++;
      continue;
    }

    existing.add(code);

    pending.push({
      name: rawCode,
      short_name: code,
      logo_url: `/assets/team-${code.toLowerCase()}.webp`,
      initial_purse: Number(purses[code] ?? 90),
      remaining_purse: Number(purses[code] ?? 90),
      indian_rtm: 3,
      overseas_rtm: 3,
      created_at: now()
    });
  }

  if (!pending.length) {
    return { teamsImported: 0, teamsSkipped };
  }

  const counters = await col('counters');

  const counter = await counters.findOneAndUpdate(
    { _id: 'teams' },
    { $inc: { seq: pending.length } },
    { upsert: true, returnDocument: 'after' }
  );

  const lastId = Number(counter.seq);
  const firstId = lastId - pending.length + 1;

  pending.forEach((team, i) => {
    team.id = firstId + i;
  });

  await teams.insertMany(pending, { ordered: true });

  return {
    teamsImported: pending.length,
    teamsSkipped
  };
}


// EXCEL IMPORT

app.post('/api/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Choose an Excel file');

    const ext = path.extname(req.file.originalname || '').toLowerCase();

    if (!['.xlsx', '.xls'].includes(ext)) {
      throw new Error('Only .xlsx and .xls files are supported');
    }

    const wb = XLSX.read(req.file.buffer, {
      type: 'buffer',
      cellDates: true
    });

    const sheet =
      wb.Sheets['Player Import'] ||
      wb.Sheets[wb.SheetNames[0]];

    if (!sheet) throw new Error('Player Import sheet was not found');

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      throw new Error('The selected Excel sheet has no player rows');
    }

    const players = await col('players');

    // Load existing names once.
    const existingNames = new Set(
      (await players.find(
        {},
        { projection: { name_normalized: 1, name: 1 } }
      ).toArray())
        .map(p =>
          String(p.name_normalized || p.name || '')
            .trim()
            .toLocaleLowerCase('en')
        )
        .filter(Boolean)
    );

    const seenInFile = new Set();
    const docs = [];

    let skippedExisting = 0;
    let skippedDuplicateInFile = 0;
    let skippedInvalid = 0;

    const validRoles = new Set([
      'Batter',
      'Batting All-Rounder',
      'Bowling All-Rounder',
      'Bowler',
      'Wicket Keeper'
    ]);

    const toNumber = value => {
      if (value === undefined || value === null || value === '') {
        return 0;
      }

      const parsed = Number(
        String(value)
          .replace(/[₹,]/g, '')
          .replace(/\s*Cr\s*/i, '')
          .replace(/C$/i, '')
          .trim()
      );

      return Number.isFinite(parsed) ? parsed : 0;
    };

    for (const row of rows) {
      const n = {};

      Object.keys(row).forEach(k => {
        n[k.toLowerCase().trim().replace(/[^a-z0-9]/g, '')] = row[k];
      });

      const name = String(
        n.playername || n.name || n.player || ''
      ).trim();

      const category = String(
        n.category || n.countrycategory || n.type || ''
      ).trim();

      if (
        !name ||
        !['Indian', 'Overseas', 'Associate'].includes(category)
      ) {
        skippedInvalid++;
        continue;
      }

      const normalized = name.toLocaleLowerCase('en');

      if (seenInFile.has(normalized)) {
        skippedDuplicateInFile++;
        continue;
      }

      seenInFile.add(normalized);

      if (existingNames.has(normalized)) {
        skippedExisting++;
        continue;
      }

      const roleRaw = String(
        n.role || n.playerrole || 'Batter'
      ).trim();

      const base = toNumber(n.baseprice);

      docs.push({
        name,
        name_normalized: normalized,
        country: String(n.country || '').trim(),
        category,
        role: validRoles.has(roleRaw) ? roleRaw : 'Batter',
        previous_price: toNumber(
          n.previousprice || n.previoussoldprice || n.soldprice
        ),
        previous_team: String(
          n.previousteam || n.team || ''
        ).trim(),
        base_price: base > 0 ? base : 0.5,
        photo_url: String(
          n.photourl || n.photo || n.imageurl || ''
        ).trim() || null,
        status: 'AVAILABLE',
        current_team_id: null,
        sold_price: null,
        acquisition_type: null,
        created_at: now()
      });
    }

    // Allocate IDs in one operation and insert in batches.
    if (docs.length) {
      const counters = await col('counters');

      const counter = await counters.findOneAndUpdate(
        { _id: 'players' },
        { $inc: { seq: docs.length } },
        { upsert: true, returnDocument: 'after' }
      );

      const lastId = Number(counter.seq);
      const firstId = lastId - docs.length + 1;

      docs.forEach((doc, i) => {
        doc.id = firstId + i;
      });

      for (let i = 0; i < docs.length; i += 250) {
        await players.insertMany(
          docs.slice(i, i + 250),
          { ordered: true }
        );
      }
    }

    const teamImport = await importTeamCodes(wb);

    const result = {
      ok: true,
      imported: docs.length,
      skipped: skippedExisting + skippedDuplicateInFile + skippedInvalid,
      skippedExisting,
      skippedDuplicateInFile,
      skippedInvalid,
      totalRows: rows.length,
      teamsImported: teamImport.teamsImported,
      teamsSkipped: teamImport.teamsSkipped,
      message: `Import completed: ${docs.length} new players added.`
    };

    io.emit('auction:update');
    res.json(result);

  } catch (e) {
    console.error('Excel import failed:', e);

    res.status(400).json({
      ok: false,
      error: e.message || 'Excel import failed'
    });
  }
});

// RETENTION

app.post('/api/retention', async (req, res) => {
  try {
    const result = await withTransaction(async s => {
      const { player_id, team_id, amount } = req.body;

      const p = await (await col('players')).findOne(
        { id: Number(player_id), status: 'AVAILABLE' },
        { session: s }
      );

      if (!p) throw new Error('Player is not available for retention');

      const t = await (await col('teams')).findOne(
        { id: Number(team_id) },
        { session: s }
      );

      if (!t) throw new Error('Team not found');

      if (
        !p.previous_team ||
        p.previous_team.trim().toLowerCase() !== t.name.trim().toLowerCase()
      ) {
        throw new Error(
          'A player can only be retained by their previous-season team'
        );
      }

      const key = p.category === 'Indian'
        ? 'indian_rtm'
        : 'overseas_rtm';

      if (Number(t[key] || 0) <= 0) {
        throw new Error('No matching RTM entitlement remains for this category');
      }

      await addPlayerToTeam(team_id, p, amount, 'Retention', s);

      await (await col('teams')).updateOne(
        { id: Number(team_id) },
        { $inc: { [key]: -1 } },
        { session: s }
      );

      await addEvent({
        player_id: p.id,
        team_id: Number(team_id),
        event_type: 'RETENTION',
        amount: money(amount)
      }, s);

      return true;
    });

    io.emit('auction:update');
    res.json({ ok: result });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// RELEASE

app.post('/api/release', async (req, res) => {
  try {
    const result = await withTransaction(async s => {
      const { player_id } = req.body;

      const p = await (await col('players')).findOne(
        { id: Number(player_id), status: 'RETAINED' },
        { session: s }
      );

      if (!p) throw new Error('Retained player not found');

      const teamId = p.current_team_id;
      const amount = money(p.sold_price || 0);

      const key = p.category === 'Indian'
        ? 'indian_rtm'
        : 'overseas_rtm';

      await (await col('teams')).updateOne(
        { id: teamId },
        { $inc: { remaining_purse: amount, [key]: 1 } },
        { session: s }
      );

      await (await col('team_squads')).deleteOne(
        { player_id: p.id },
        { session: s }
      );

      await (await col('players')).updateOne(
        { id: p.id },
        {
          $set: {
            status: 'AVAILABLE',
            current_team_id: null,
            sold_price: null,
            acquisition_type: null
          }
        },
        { session: s }
      );

      await addEvent({
        player_id: p.id,
        team_id: teamId,
        event_type: 'RELEASE',
        amount,
        details: {
          refunded_purse: true,
          returned_rtm: true
        }
      }, s);

      return amount;
    });

    io.emit('auction:update');
    res.json({ ok: true, refunded: result, rtmReturned: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// TRADE
// The buyer is debited and the seller is credited by the same amount.

app.post('/api/trade', async (req, res) => {
  try {
    const out = await withTransaction(async s => {
      const {
        player_id,
        from_team_id,
        to_team_id,
        amount
      } = req.body;

      const pid = Number(player_id);
      const sellerId = Number(from_team_id);
      const buyerId = Number(to_team_id);

      if (sellerId === buyerId) {
        throw new Error('Choose a different buying team');
      }

      const p = await (await col('players')).findOne(
        { id: pid, current_team_id: sellerId },
        { session: s }
      );

      if (!p) throw new Error('Player does not belong to selling team');

      const seller = await (await col('teams')).findOne(
        { id: sellerId },
        { session: s }
      );

      const buyer = await (await col('teams')).findOne(
        { id: buyerId },
        { session: s }
      );

      if (!seller || !buyer) {
        throw new Error('Seller or buyer team not found');
      }

      const amt = money(Number(amount));

      if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error('Enter a valid trade amount greater than zero');
      }

      if (Number(buyer.remaining_purse) < amt) {
        throw new Error('Buyer team does not have enough purse');
      }

      await validateAddition(buyerId, p, amt, s);

      await (await col('team_squads')).deleteOne(
        { player_id: pid },
        { session: s }
      );

      await (await col('teams')).updateOne(
        { id: buyerId },
        { $inc: { remaining_purse: -amt } },
        { session: s }
      );

      await (await col('teams')).updateOne(
        { id: sellerId },
        { $inc: { remaining_purse: amt } },
        { session: s }
      );

      await (await col('team_squads')).insertOne({
        id: await nextId('team_squads'),
        team_id: buyerId,
        player_id: pid,
        amount: amt,
        acquisition_type: 'Trade',
        created_at: now()
      }, { session: s });

      await (await col('players')).updateOne(
        { id: pid },
        {
          $set: {
            current_team_id: buyerId,
            sold_price: amt,
            acquisition_type: 'Trade'
          }
        },
        { session: s }
      );

      await (await col('trades')).insertOne({
        id: await nextId('trades'),
        player_id: pid,
        from_team_id: sellerId,
        to_team_id: buyerId,
        amount: amt,
        created_at: now()
      }, { session: s });

      await addEvent({
        player_id: pid,
        team_id: buyerId,
        event_type: 'TRADE',
        amount: amt,
        details: {
          from_team_id: sellerId,
          buyer_purse_deducted: amt,
          seller_purse_credited: amt
        }
      }, s);

      return {
        amount: amt,
        buyer_remaining_purse: Number(buyer.remaining_purse) - amt,
        seller_remaining_purse: Number(seller.remaining_purse) + amt
      };
    });

    io.emit('auction:update');

    res.json({
      ok: true,
      buyer_purse_deducted: out.amount,
      seller_purse_credited: out.amount,
      ...out
    });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// BID

app.post('/api/bid', async (req, res) => {
  try {
    const { player_id, team_id, amount } = req.body;

    const p = await (await col('players')).findOne({
      id: Number(player_id),
      status: 'AVAILABLE'
    });

    if (!p) throw new Error('Player is not available');

    await validateAddition(team_id, p, amount);

    const id = await nextId('auction_bids');

    await (await col('auction_bids')).insertOne({
      id,
      player_id: Number(player_id),
      team_id: Number(team_id),
      amount: money(amount),
      created_at: now()
    });

    const team = await (await col('teams')).findOne({
      id: Number(team_id)
    });

    io.emit('auction:bid', {
      player_id: Number(player_id),
      team_id: Number(team_id),
      team: team?.name,
      amount: money(amount)
    });

    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// SOLD

app.post('/api/sold', async (req, res) => {
  try {
    await withTransaction(async s => {
      const { player_id, team_id, amount } = req.body;

      const p = await (await col('players')).findOne(
        { id: Number(player_id), status: 'AVAILABLE' },
        { session: s }
      );

      if (!p) throw new Error('Player is not available');

      await addPlayerToTeam(team_id, p, amount, 'Auction', s);

      await addEvent({
        player_id: p.id,
        team_id: Number(team_id),
        event_type: 'SOLD',
        amount: money(amount)
      }, s);
    });

    io.emit('auction:update');
    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// UNSOLD

app.post('/api/unsold', async (req, res) => {
  try {
    const { player_id } = req.body;

    const r = await (await col('players')).updateOne(
      {
        id: Number(player_id),
        status: 'AVAILABLE'
      },
      {
        $set: {
          status: 'UNSOLD',
          current_team_id: null
        }
      }
    );

    if (!r.modifiedCount) {
      throw new Error('Player is not available');
    }

    await addEvent({
      player_id: Number(player_id),
      event_type: 'UNSOLD'
    });

    io.emit('auction:update');
    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// REAUCTION

app.post('/api/reauction', async (req, res) => {
  try {
    const r = await (await col('players')).updateOne(
      {
        id: Number(req.body.player_id),
        status: 'UNSOLD'
      },
      {
        $set: { status: 'AVAILABLE' }
      }
    );

    if (!r.modifiedCount) {
      throw new Error('Player is not unsold');
    }

    io.emit('auction:update');
    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// SOLD PLAYERS

app.get('/api/sold', async (_req, res) => {
  try {
    const rows = await (await col('players'))
      .find({ status: 'SOLD' })
      .sort({ name: 1 })
      .toArray();

    const teams = await (await col('teams')).find({}).toArray();
    const tm = new Map(teams.map(t => [t.id, t.name]));

    res.json(rows.map(p => ({
      ...p,
      current_team: tm.get(p.current_team_id) || null
    })));

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// BRING BACK SOLD PLAYER

app.post('/api/sold/bring-back', async (req, res) => {
  try {
    const refund = await withTransaction(async s => {
      const pid = Number(req.body.player_id);

      const p = await (await col('players')).findOne(
        { id: pid, status: 'SOLD' },
        { session: s }
      );

      if (!p) throw new Error('Sold player not found');

      const amount = money(p.sold_price || 0);
      const teamId = p.current_team_id;

      if (teamId) {
        const inc = { remaining_purse: amount };

        if (p.acquisition_type === 'RTM') {
          inc[p.category === 'Indian' ? 'indian_rtm' : 'overseas_rtm'] = 1;
        }

        await (await col('teams')).updateOne(
          { id: teamId },
          { $inc: inc },
          { session: s }
        );

        await (await col('team_squads')).deleteOne(
          { player_id: pid },
          { session: s }
        );
      }

      await (await col('players')).updateOne(
        { id: pid },
        {
          $set: {
            status: 'AVAILABLE',
            current_team_id: null,
            sold_price: null,
            acquisition_type: null
          }
        },
        { session: s }
      );

      await addEvent({
        player_id: pid,
        team_id: teamId,
        event_type: 'SALE_REVERSED',
        amount,
        details: { purse_refunded: true }
      }, s);

      return { amount, teamId };
    });

    io.emit('auction:update');

    res.json({
      ok: true,
      refunded: refund.amount,
      team_id: refund.teamId
    });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// RTM

app.post('/api/rtm', async (req, res) => {
  try {
    await withTransaction(async s => {
      const { player_id, team_id, amount } = req.body;

      const p = await (await col('players')).findOne(
        { id: Number(player_id), status: 'AVAILABLE' },
        { session: s }
      );

      if (!p) throw new Error('Player is not available');

      if (!p.previous_team) {
        throw new Error(
          'Previous team is not recorded; RTM eligibility cannot be verified'
        );
      }

      const team = await (await col('teams')).findOne(
        { id: Number(team_id), name: p.previous_team },
        { session: s }
      );

      if (!team) {
        throw new Error("Only the player's previous team can use RTM");
      }

      const key = p.category === 'Indian'
        ? 'indian_rtm'
        : 'overseas_rtm';

      if (Number(team[key] || 0) <= 0) {
        throw new Error('No eligible RTM card remains');
      }

      await addPlayerToTeam(team_id, p, amount, 'RTM', s);

      await (await col('teams')).updateOne(
        { id: Number(team_id) },
        { $inc: { [key]: -1 } },
        { session: s }
      );

      await addEvent({
        player_id: p.id,
        team_id: Number(team_id),
        event_type: 'RTM',
        amount: money(amount)
      }, s);
    });

    io.emit('auction:update');
    res.json({ ok: true });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PLAYER DETAILS

app.get('/api/player/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    const player = await (await col('players')).findOne({ id });

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const team = player.current_team_id
      ? await (await col('teams')).findOne({
          id: player.current_team_id
        })
      : null;

    const bids = await (await col('auction_bids'))
      .find({ player_id: id })
      .sort({ amount: -1, id: -1 })
      .limit(10)
      .toArray();

    const bidTeams = await (await col('teams')).find({
      id: { $in: bids.map(b => b.team_id) }
    }).toArray();

    const btm = new Map(bidTeams.map(t => [t.id, t]));

    const events = await (await col('auction_events'))
      .find({ player_id: id })
      .sort({ id: -1 })
      .limit(10)
      .toArray();

    res.json({
      player: {
        ...player,
        current_team: team?.name || null,
        current_team_short: team?.short_name || null
      },
      bids: bids.map(b => ({
        ...b,
        team_name: btm.get(b.team_id)?.name,
        short_name: btm.get(b.team_id)?.short_name
      })),
      events
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// NOMINATION QUEUE

app.get('/api/nomination-queue', async (_req, res) => {
  try {
    const rows = await (await col('players'))
      .find(
        { status: 'AVAILABLE' },
        {
          projection: {
            id: 1,
            name: 1,
            category: 1,
            role: 1,
            base_price: 1,
            photo_url: 1
          }
        }
      )
      .sort({ category: 1, role: 1, name: 1 })
      .toArray();

    res.json(rows);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// TEAM SQUAD

app.get('/api/squad/:teamId', async (req, res) => {
  try {
    const squad = await (await col('team_squads'))
      .find({ team_id: Number(req.params.teamId) })
      .sort({ id: 1 })
      .toArray();

    const ids = squad.map(x => x.player_id);

    const players = ids.length
      ? await (await col('players')).find({
          id: { $in: ids }
        }).toArray()
      : [];

    const sm = new Map(squad.map(x => [x.player_id, x]));

    res.json(
      players.map(p => ({
        ...p,
        amount: sm.get(p.id)?.amount,
        acquisition_type: sm.get(p.id)?.acquisition_type
      })).sort(
        (a, b) =>
          String(a.category).localeCompare(String(b.category)) ||
          a.name.localeCompare(b.name)
      )
    );

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// STATS

app.get('/api/stats', async (_req, res) => {
  try {
    const p = await (await col('players')).find({}).toArray();
    const squads = await (await col('team_squads')).find({}).toArray();

    res.json({
      total: p.length,
      available: p.filter(x => x.status === 'AVAILABLE').length,
      sold: p.filter(x => x.status === 'SOLD').length,
      unsold: p.filter(x => x.status === 'UNSOLD').length,
      retained: p.filter(x => x.status === 'RETAINED').length,
      total_spend: money(
        squads.reduce((a, x) => a + Number(x.amount || 0), 0)
      )
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Individual team workbook: squad, role counts, purse and complete team history.
app.get('/api/teams/:id/report.xlsx', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const [team, players, squad, events, trades] = await Promise.all([
      (await col('teams')).findOne({ id: teamId }),
      (await col('players')).find({}).toArray(),
      (await col('team_squads')).find({ team_id: teamId }).sort({ id: 1 }).toArray(),
      (await col('auction_events')).find({ $or: [{ team_id: teamId }, { 'details.from_team_id': teamId }] }).sort({ id: 1 }).toArray(),
      (await col('trades')).find({ $or: [{ from_team_id: teamId }, { to_team_id: teamId }] }).sort({ id: 1 }).toArray()
    ]);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const byId = new Map(players.map(p => [Number(p.id), p]));
    const rows = squad.map(x => { const p = byId.get(Number(x.player_id)) || {}; return {
      'Player ID': x.player_id, 'Player Name': p.name || '', Category: p.category || '', Role: p.role || '',
      Country: p.country || '', 'Purchase Amount (Cr)': Number(x.amount || 0),
      'Acquisition Type': x.acquisition_type || p.acquisition_type || '', 'Previous Team': p.previous_team || '',
      'Player Status': p.status || ''
    }; });
    const roles = {};
    for (const x of squad) { const role = byId.get(Number(x.player_id))?.role || 'Unspecified'; roles[role] = (roles[role] || 0) + 1; }
    const categories = { Indian: 0, Overseas: 0, Associate: 0 };
    for (const x of squad) { const c = byId.get(Number(x.player_id))?.category; if (c in categories) categories[c]++; }
    const missing = Math.max(0, 17 - squad.length);
    const wb = XLSX.utils.book_new();
    const add = (name, data) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Info: 'No records' }]), name);
    add('Team Summary', [{ Team: team.name, 'Team Code': team.short_name || '', 'Initial Purse (Cr)': team.initial_purse, 'Remaining Purse (Cr)': team.remaining_purse, 'Squad Size': squad.length, 'Minimum Squad': 17, 'Maximum Squad': 20, 'Missing Slots': missing, 'Minimum Reserve (Cr)': Number((missing * 0.5).toFixed(2)), 'Indian': categories.Indian, 'Overseas': categories.Overseas, 'Associate': categories.Associate, 'Effective Overseas': categories.Overseas + Math.max(0, categories.Associate - 2), 'Batter': roles.Batter || roles.Batsman || 0, 'Wicket Keeper': roles['Wicket Keeper'] || 0, 'Bowler': roles.Bowler || 0, 'All-Rounder': (roles['All-Rounder'] || 0) + (roles['Batting All-Rounder'] || 0) + (roles['Bowling All-Rounder'] || 0) }]);
    add('Full Squad', rows);
    add('Role Counts', Object.entries(roles).map(([Role, Count]) => ({ Role, Count })));
    add('Auction History', events.map(e => ({ Event: e.event_type, Player: byId.get(Number(e.player_id))?.name || '', Amount: e.amount ?? '', Details: JSON.stringify(e.details || {}), Date: e.created_at || '' })));
    add('Trade History', trades.map(t => ({ Player: byId.get(Number(t.player_id))?.name || '', Seller: t.from_team_id, Buyer: t.to_team_id, Amount: t.amount, Date: t.created_at || '' })));
    res.setHeader('Content-Disposition', `attachment; filename="${String(team.short_name || team.name).replace(/[^a-z0-9_-]/gi, '_')}_Squad_Report.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// EXCEL REPORT — 21 SHEETS (read-only; does not modify MongoDB)

app.get('/api/reports.xlsx', async (_req, res) => {
  try {
    const [teams, players, squads, trades, events, bids] = await Promise.all([
      (await col('teams')).find({}).sort({ name: 1 }).toArray(),
      (await col('players')).find({}).sort({ name: 1 }).toArray(),
      (await col('team_squads')).find({}).sort({ team_id: 1, id: 1 }).toArray(),
      (await col('trades')).find({}).sort({ id: 1 }).toArray(),
      (await col('auction_events')).find({}).sort({ id: 1 }).toArray(),
      (await col('auction_bids')).find({}).sort({ id: 1 }).toArray()
    ]);

    const wb = XLSX.utils.book_new();
    const teamById = new Map(teams.map(t => [Number(t.id), t]));
    const playerById = new Map(players.map(p => [Number(p.id), p]));
    const squadByPlayer = new Map(squads.map(x => [Number(x.player_id), x]));
    const squadByTeam = new Map();

    for (const item of squads) {
      const key = Number(item.team_id);
      if (!squadByTeam.has(key)) squadByTeam.set(key, []);
      squadByTeam.get(key).push(item);
    }

    const clean = value => value === undefined || value === null ? '' : value;
    const dateValue = value => value instanceof Date ? value : (value ? new Date(value) : '');
    const playerName = id => playerById.get(Number(id))?.name || '';
    const teamName = id => teamById.get(Number(id))?.name || '';
    const teamCode = team => team.short_name || team.name || `Team${team.id}`;
    const categoryCounts = list => {
      const counts = { Indian: 0, Overseas: 0, Associate: 0 };
      for (const row of list) {
        const player = playerById.get(Number(row.player_id));
        if (player && Object.prototype.hasOwnProperty.call(counts, player.category)) {
          counts[player.category]++;
        }
      }
      return counts;
    };
    const effectiveOverseasCount = counts =>
      Number(counts.Overseas || 0) + Math.max(0, Number(counts.Associate || 0) - 2);
    const sheetName = (raw, used) => {
      let base = String(raw || 'Team').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Team';
      let candidate = base;
      let n = 2;
      while (used.has(candidate.toLowerCase())) {
        const suffix = ` ${n++}`;
        candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
      }
      used.add(candidate.toLowerCase());
      return candidate;
    };
    const appendJson = (name, rows, headers) => {
      const data = rows.length ? rows : (headers ? [Object.fromEntries(headers.map(h => [h, '']))] : []);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name);
    };

    // 1. All Teams Summary
    const teamSummary = teams.map(team => {
      const teamSquad = squadByTeam.get(Number(team.id)) || [];
      const counts = categoryCounts(teamSquad);
      const total = teamSquad.length;
      const effectiveOverseas = effectiveOverseasCount(counts);
      const reserveSlots = Math.max(0, 17 - total);
      return {
        Team: team.name,
        'Team Code': team.short_name || '',
        'Squad Size': total,
        'Indian Players': counts.Indian,
        'Overseas Players': counts.Overseas,
        'Associate Players': counts.Associate,
        'Effective Overseas': effectiveOverseas,
        'Initial Purse (Cr)': Number(team.initial_purse || 0),
        'Spent (Cr)': Number(team.initial_purse || 0) - Number(team.remaining_purse || 0),
        'Remaining Purse (Cr)': Number(team.remaining_purse || 0),
        'Minimum Squad': 17,
        'Maximum Squad': 20,
        'Missing Minimum Slots': reserveSlots,
        'Mandatory Reserve (Cr)': Number((reserveSlots * 0.5).toFixed(2)),
        'Indian RTM Remaining': Number(team.indian_rtm || 0),
        'Overseas/Associate RTM Remaining': Number(team.overseas_rtm || 0)
      };
    });
    appendJson('All Teams Summary', teamSummary);

    // 2–15. One squad sheet for each team.
    const usedNames = new Set(['all teams summary'.toLowerCase()]);
    for (const team of teams) {
      const teamSquad = squadByTeam.get(Number(team.id)) || [];
      const counts = categoryCounts(teamSquad);
      const rows = teamSquad.map(item => {
        const player = playerById.get(Number(item.player_id)) || {};
        return {
          'Player ID': clean(player.id),
          'Player Name': clean(player.name),
          Category: clean(player.category),
          Role: clean(player.role),
          Country: clean(player.country),
          'Purchase Amount (Cr)': Number(item.amount || 0),
          'Acquisition Source': clean(item.acquisition_type),
          'Previous Team': clean(player.previous_team),
          'Previous Price (Cr)': Number(player.previous_price || 0),
          'Acquired At': dateValue(item.created_at)
        };
      });
      const summaryRows = [
        { Field: 'Team', Value: team.name },
        { Field: 'Team Code', Value: team.short_name || '' },
        { Field: 'Squad Size', Value: teamSquad.length },
        { Field: 'Indian / Overseas / Associate', Value: `${counts.Indian} / ${counts.Overseas} / ${counts.Associate}` },
        { Field: 'Effective Overseas', Value: effectiveOverseasCount(counts) },
        { Field: 'Initial Purse (Cr)', Value: Number(team.initial_purse || 0) },
        { Field: 'Remaining Purse (Cr)', Value: Number(team.remaining_purse || 0) },
        { Field: 'Mandatory Reserve (Cr)', Value: Number((Math.max(0, 17 - teamSquad.length) * 0.5).toFixed(2)) }
      ];
      const ws = XLSX.utils.json_to_sheet(summaryRows, { header: ['Field', 'Value'] });
      XLSX.utils.sheet_add_aoa(ws, [['', ''], ['SQUAD DETAILS'], Object.keys(rows[0] || {
        'Player ID': '', 'Player Name': '', Category: '', Role: '', Country: '',
        'Purchase Amount (Cr)': '', 'Acquisition Source': '', 'Previous Team': '',
        'Previous Price (Cr)': '', 'Acquired At': ''
      })], { origin: -1 });
      if (rows.length) XLSX.utils.sheet_add_json(ws, rows, { origin: -1, skipHeader: false });
      XLSX.utils.book_append_sheet(wb, ws, sheetName(teamCode(team), usedNames));
    }

    // 16. All Players & Squad Details (includes available and unsold players too).
    const allPlayerRows = players.map(player => {
      const squadItem = squadByPlayer.get(Number(player.id));
      return {
        'Player ID': player.id,
        'Player Name': player.name || '',
        Category: player.category || '',
        Role: player.role || '',
        Country: player.country || '',
        Status: player.status || '',
        'Current Team': teamName(player.current_team_id),
        'Current Team Code': teamById.get(Number(player.current_team_id))?.short_name || '',
        'Purchase Amount (Cr)': squadItem ? Number(squadItem.amount || 0) : Number(player.sold_price || 0),
        'Acquisition Source': squadItem?.acquisition_type || player.acquisition_type || '',
        'Previous Team': player.previous_team || '',
        'Previous Price (Cr)': Number(player.previous_price || 0),
        'Base Price (Cr)': Number(player.base_price || 0),
        'Photo URL': player.photo_url || ''
      };
    });
    appendJson('All Players & Squad Details', allPlayerRows);

    // 17. Role-wise Player Counts.
    const roleKeys = [...new Set(players.map(p => String(p.role || 'Unspecified')))].sort();
    const roleRows = [];
    for (const team of teams) {
      const teamSquad = squadByTeam.get(Number(team.id)) || [];
      const teamPlayers = teamSquad.map(x => playerById.get(Number(x.player_id))).filter(Boolean);
      for (const role of roleKeys) {
        const matching = teamPlayers.filter(p => String(p.role || 'Unspecified') === role);
        roleRows.push({
          Team: team.name,
          'Team Code': team.short_name || '',
          Role: role,
          'Player Count': matching.length,
          'Player Names': matching.map(p => p.name).join(', ')
        });
      }
    }
    appendJson('Role-wise Player Counts', roleRows, ['Team', 'Team Code', 'Role', 'Player Count', 'Player Names']);

    // 18. Purse Summary.
    const purseRows = teams.map(team => {
      const teamSquad = squadByTeam.get(Number(team.id)) || [];
      const counts = categoryCounts(teamSquad);
      const reserveSlots = Math.max(0, 17 - teamSquad.length);
      return {
        Team: team.name,
        'Team Code': team.short_name || '',
        'Initial Purse (Cr)': Number(team.initial_purse || 0),
        'Remaining Purse (Cr)': Number(team.remaining_purse || 0),
        'Total Spent (Cr)': Number((Number(team.initial_purse || 0) - Number(team.remaining_purse || 0)).toFixed(2)),
        'Squad Size': teamSquad.length,
        'Minimum Squad': 17,
        'Maximum Squad': 20,
        'Reserve Slots': reserveSlots,
        'Reserve Amount (Cr)': Number((reserveSlots * 0.5).toFixed(2)),
        'Spendable Purse After Reserve (Cr)': Number((Number(team.remaining_purse || 0) - reserveSlots * 0.5).toFixed(2)),
        Indian: counts.Indian,
        Overseas: counts.Overseas,
        Associate: counts.Associate,
        'Effective Overseas': effectiveOverseasCount(counts)
      };
    });
    appendJson('Purse Summary', purseRows);

    // 19. Auction History: bids plus non-trade/non-RTM/non-retention auction events.
    const auctionEventRows = events
      .filter(e => !['TRADE', 'RTM', 'RETENTION'].includes(String(e.event_type || '').toUpperCase()))
      .map(e => ({
        'History ID': e.id,
        'Record Type': 'EVENT',
        'Event Type': e.event_type || '',
        'Player ID': clean(e.player_id),
        'Player Name': playerName(e.player_id),
        Team: teamName(e.team_id),
        'Team ID': clean(e.team_id),
        'Amount (Cr)': clean(e.amount),
        Details: e.details ? JSON.stringify(e.details) : '',
        'Date & Time': dateValue(e.created_at)
      }));
    const bidRows = bids.map(b => ({
      'History ID': b.id,
      'Record Type': 'BID',
      'Event Type': 'BID',
      'Player ID': b.player_id,
      'Player Name': playerName(b.player_id),
      Team: teamName(b.team_id),
      'Team ID': b.team_id,
      'Amount (Cr)': Number(b.amount || 0),
      Details: '',
      'Date & Time': dateValue(b.created_at)
    }));
    appendJson('Auction History', [...auctionEventRows, ...bidRows].sort((a, b) => {
      const da = a['Date & Time'] instanceof Date ? a['Date & Time'].getTime() : 0;
      const db = b['Date & Time'] instanceof Date ? b['Date & Time'].getTime() : 0;
      return da - db;
    }));

    // 20. Trade History.
    const tradeRows = trades.map(t => ({
      'Trade ID': t.id,
      'Player ID': t.player_id,
      'Player Name': playerName(t.player_id),
      'Seller Team': teamName(t.from_team_id),
      'Buyer Team': teamName(t.to_team_id),
      'Trade Amount (Cr)': Number(t.amount || 0),
      'Buyer Purse Deducted (Cr)': Number(t.amount || 0),
      'Seller Purse Credited (Cr)': Number(t.amount || 0),
      'Date & Time': dateValue(t.created_at)
    }));
    appendJson('Trade History', tradeRows, [
      'Trade ID', 'Player ID', 'Player Name', 'Seller Team', 'Buyer Team',
      'Trade Amount (Cr)', 'Buyer Purse Deducted (Cr)', 'Seller Purse Credited (Cr)', 'Date & Time'
    ]);

    // 21. RTM & Retention History (release events included for audit traceability).
    const rtmRetentionRows = events
      .filter(e => ['RTM', 'RETENTION', 'RELEASE'].includes(String(e.event_type || '').toUpperCase()))
      .map(e => ({
        'History ID': e.id,
        'Event Type': e.event_type || '',
        'Player ID': clean(e.player_id),
        'Player Name': playerName(e.player_id),
        Team: teamName(e.team_id),
        'Team ID': clean(e.team_id),
        'Amount (Cr)': clean(e.amount),
        Details: e.details ? JSON.stringify(e.details) : '',
        'Date & Time': dateValue(e.created_at)
      }));
    appendJson('RTM & Retention History', rtmRetentionRows, [
      'History ID', 'Event Type', 'Player ID', 'Player Name', 'Team', 'Team ID',
      'Amount (Cr)', 'Details', 'Date & Time'
    ]);

    // Keep the workbook's promised layout explicit and easy to audit.
    if (wb.SheetNames.length !== 21) {
      throw new Error(`Excel report expected 21 sheets but created ${wb.SheetNames.length}. Check that all 14 teams exist.`);
    }

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="SNK_Friends_Auction_Report.xlsx"'
    );
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) {
    console.error('Excel report generation failed:', e);
    res.status(500).json({ error: e.message || 'Excel report generation failed' });
  }
});

// BACKUP

app.get('/api/backup', async (_req, res) => {
  try {
    const tables = {};

    for (const name of [
      'teams',
      'players',
      'team_squads',
      'auction_bids',
      'trades',
      'auction_events'
    ]) {
      tables[name] = (await (await col(name))
        .find({})
        .toArray())
        .map(({ _id, ...x }) => x);
    }

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="SNK_Friends_Auction_Backup.json"'
    );

    res.json({
      app: 'SNK Friends Cricket Mega Auction',
      version: 2,
      created_at: now().toISOString(),
      tables
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// ADMIN RESET
// Requires the explicit DELETE ALL DATA confirmation phrase.
// A full backup is returned before deletion.
// ==========================================

app.post('/api/reset-all-data', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE ALL DATA') {
      return res.status(400).json({ ok: false, error: 'Type DELETE ALL DATA to confirm.' });
    }

    const collectionNames = [
      'teams', 'players', 'team_squads', 'auction_bids',
      'trades', 'auction_events', 'broadcast_state'
    ];

    // Build the backup first. If backup creation fails, nothing is deleted.
    const backupTables = {};
    for (const name of collectionNames) {
      backupTables[name] = (await (await col(name)).find({}).toArray())
        .map(({ _id, ...document }) => document);
    }

    const backup = {
      app: 'SNK Friends Cricket Mega Auction',
      version: 2,
      type: 'automatic-pre-reset-backup',
      created_at: now().toISOString(),
      tables: backupTables
    };

    const db = await dbPromise;
    for (const name of collectionNames) {
      await db.collection(name).deleteMany({});
    }
    await db.collection('counters').deleteMany({});
    await seedTeamsIfEmpty();

    io.emit('auction:update');
    io.emit('broadcast:state', {
      status: 'AUCTION LIVE',
      player: 'Waiting for next player',
      details: ''
    });

    return res.json({
      ok: true,
      message: 'All auction data was cleared. Default 14 teams were recreated.',
      backup
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Restore remains disabled until a separately authenticated restore workflow is configured.
app.all('/api/restore', (req, res) => {
  return res.status(403).json({
    ok: false,
    error: 'Restore operation is disabled. Use the downloaded backup with an approved restore workflow.'
  });
});


// ==========================================
// LATEST TEAM
// ==========================================

app.get('/api/latest-team', async (_req, res) => {
  try {
    const e = await (await col('auction_events'))
      .find({
        team_id: { $ne: null },
        event_type: {
          $in: ['SOLD', 'RTM', 'RETENTION', 'TRADE']
        }
      })
      .sort({ id: -1 })
      .limit(1)
      .next();

    const t = e
      ? await (await col('teams')).findOne({ id: e.team_id })
      : null;

    res.json(t ? { id: t.id, name: t.name } : null);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// AUCTION HISTORY

app.get('/api/history', async (_req, res) => {
  try {
    const events = await (await col('auction_events'))
      .find({})
      .sort({ id: -1 })
      .limit(200)
      .toArray();

    const pids = [
      ...new Set(events.map(e => e.player_id).filter(Boolean))
    ];

    const tids = [
      ...new Set(
        events.flatMap(e => [
          e.team_id,
          e.details?.from_team_id
        ]).filter(Boolean)
      )
    ];

    const ps = await (await col('players'))
      .find({ id: { $in: pids } })
      .toArray();

    const ts = await (await col('teams'))
      .find({ id: { $in: tids } })
      .toArray();

    const pm = new Map(ps.map(x => [x.id, x.name]));
    const tm = new Map(ts.map(x => [x.id, x.name]));

    res.json(
      events.map(e => ({
        ...e,
        player_name: pm.get(e.player_id) || null,
        team_name: tm.get(e.team_id) || null,
        seller_team_name: tm.get(e.details?.from_team_id) || null
      }))
    );

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// FRONTEND FALLBACK

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// STARTUP

const ready = Promise.all([
  clientPromise,
  ensureIndexes()
]).then(seedTeamsIfEmpty);

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  ready
    .then(() => {
      server.listen(PORT, () => {
        console.log(
          `SNK Cricket Mega Auction running at http://localhost:${PORT} (MongoDB: ${dbName})`
        );
      });
    })
    .catch(err => {
      console.error('Startup failed:', err);
      process.exit(1);
    });
}

module.exports = {
  app,
  server,
  io,
  ready
};
