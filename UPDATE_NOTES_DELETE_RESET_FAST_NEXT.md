# SNK Auction update notes

## Full reset
- `Reset All Data` is enabled through `POST /api/reset-all-data` only when `RESET_ADMIN_TOKEN` is configured.
- The admin must type `DELETE ALL DATA` and enter the reset token.
- The API builds a full JSON backup before deleting any data and returns it to the browser for automatic download.
- It clears teams, players, squads, bids, trades, auction events, broadcast state and counters, then recreates the 14 default teams.
- It does not delete MongoDB sessions.

Set a long, unique `RESET_ADMIN_TOKEN` in local `.env` and in Vercel Project Settings → Environment Variables. Never commit the real value. Redeploy after changing Vercel environment variables.

## Faster auction progression
- After SOLD, UNSOLD or RTM succeeds on the server, the next available player is selected after a 250 ms result beat.
- Supporting panels refresh in the background so the next player does not wait for the full dashboard refresh.

## Validation
- `node --check server.js`
- `node --check public/app.js`
- `npm test` (9/9 passing)
