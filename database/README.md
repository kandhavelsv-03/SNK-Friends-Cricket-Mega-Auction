# MongoDB Atlas data model

The application creates these MongoDB collections and indexes automatically on startup:

- `teams` — 14 SNK franchises, purse balances and RTM counters
- `players` — player register, category, status, current team and acquisition data
- `team_squads` — current squad membership and purchase/trade values
- `auction_bids` — bid history
- `trades` — seller/buyer/player trade records
- `auction_events` — SOLD, UNSOLD, RTM, retention, release and trade audit events
- `counters` — atomic numeric ID sequences used to keep existing browser UI IDs compatible
- `broadcast_state` — persisted live broadcast state for viewer polling and Socket.IO
- `sessions` — Express session records (managed by connect-mongo)

MongoDB transactions are used for purse-changing auction operations and backup restore. Use a MongoDB Atlas replica-set cluster (the Atlas Free tier provides this).
