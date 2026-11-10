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
