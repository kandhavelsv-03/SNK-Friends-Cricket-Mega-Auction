'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('runtime dependencies use MongoDB and no MySQL driver', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.mongodb);
  assert.ok(pkg.dependencies['connect-mongo']);
  assert.equal(pkg.dependencies.mysql2, undefined);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /MONGODB_URI/);
  assert.doesNotMatch(server, /mysql2|createPool|SELECT \* FROM|AUTO_INCREMENT/i);
});

test('Vercel entrypoint and persisted broadcast polling are included', () => {
  assert.ok(fs.existsSync(path.join(root, 'api', 'index.js')));
  assert.ok(fs.existsSync(path.join(root, 'vercel.json')));
  const viewer = fs.readFileSync(path.join(root, 'public', 'broadcast.html'), 'utf8');
  assert.match(viewer, /\/api\/broadcast\/state/);
  assert.match(viewer, /setInterval\(refreshBroadcast/);
});

test('team purse values and existing UI assets are retained', () => {
  const rules = require('../lib/auction-rules');
  assert.equal(rules.TEAM_CONFIG.length, 14);
  for (const file of ['team-kcg.webp', 'team-arc.webp', 'team-dcs.webp', 'team-vtk.webp', 'team-ss.webp', 'team-fck.webp', 'team-tg.webp', 'team-bbc.webp', 'team-aks.webp', 'team-kd2.webp', 'team-br.webp', 'team-cc.webp', 'team-rh.webp', 'team-7sv.webp', 'snk-friends-logo.jpg', 'snk-auctioneer.jpg']) {
    assert.ok(fs.existsSync(path.join(root, 'public', 'assets', file)), `missing asset ${file}`);
  }
});

test('full reset requires confirmation and creates a pre-reset backup', () => {
  const server = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
  );

  const resetRoute = server.slice(
    server.indexOf("app.post('/api/reset-all-data'"),
    server.indexOf("app.all('/api/restore'")
  );

  assert.match(resetRoute, /confirm !== 'DELETE ALL DATA'/);
  assert.match(resetRoute, /automatic-pre-reset-backup/);
  assert.match(resetRoute, /deleteMany/);
  assert.match(resetRoute, /seedTeamsIfEmpty/);
  assert.doesNotMatch(resetRoute, /RESET_ADMIN_TOKEN/);
});

test('SOLD, UNSOLD and RTM advance to the next player without waiting for full refresh', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /function advanceAuctionImmediately\(completedPlayerId\)/);
  assert.match(app, /setTimeout\(\(\)=>\{advanceAuctionImmediately\(completedId\);refreshAuctionAfterResult\(\);\},250\)/);
});
