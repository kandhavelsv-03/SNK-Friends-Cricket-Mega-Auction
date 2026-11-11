# SNK Friends Cricket Mega Auction — MongoDB Atlas Edition

A Node.js + Express cricket auction management system migrated from MySQL to MongoDB Atlas. The project keeps the existing SNK Friends dashboard, 14 team logos, Excel import, auction workflows, squad builder, reports, backup/restore, and live broadcast viewer.

## Technology

- Node.js 18.18+
- Express 4
- MongoDB Atlas (`mongodb` Node.js driver)
- `connect-mongo` for persistent Express sessions
- Socket.IO for connected Node.js deployments; MongoDB-backed broadcast polling is also enabled for serverless hosting
- XLSX for player import and Excel reports

## MongoDB Atlas setup

1. Create or use an Atlas cluster. The Atlas Free tier is sufficient; it runs as a replica set and supports the multi-document transactions used for purse-changing operations.
2. In Atlas **Database Access**, create a database user and password.
3. In **Network Access**, allow the deployment's outbound IPs. For a temporary test, `0.0.0.0/0` can be used, but restrict it when possible.
4. Copy the Atlas **Drivers** connection string. Replace the username and password placeholders and URL-encode special characters in the password.
5. Set these environment variables locally and in Vercel:

   ```env
   MONGODB_URI=mongodb+srv://<db_user>:<db_password>@<cluster-host>/?retryWrites=true&w=majority&appName=Cluster0
   MONGODB_DB_NAME=cricket_auction
   SESSION_SECRET=<long-random-secret>
   PORT=3000
   ```

6. Install and run:

   ```bash
   npm install
   npm start
   ```

7. Open `http://localhost:3000`. `/api/health` reports whether the MongoDB connection is ready.

The app creates its MongoDB collections and indexes automatically. No MySQL server, schema import, `DB_HOST`, or port 3306 is used.

## Initial SNK team setup

On the first connection to an empty database, the app seeds exactly these 14 teams and their initial purses. Each team starts with 3 Indian RTM cards and 3 Overseas/Associate RTM cards.

| Team | Initial purse |
|---|---:|
| KCG | ₹90 Cr |
| ARC | ₹90 Cr |
| DCS | ₹90 Cr |
| VTK | ₹90 Cr |
| SS | ₹90 Cr |
| FCK | ₹90 Cr |
| TG | ₹87 Cr |
| BBC | ₹87 Cr |
| AKS | ₹67 Cr |
| KD2 | ₹67 Cr |
| BR | ₹67 Cr |
| CC | ₹53 Cr |
| RH | ₹47 Cr |
| 7SV | ₹12 Cr |

The seed marker prevents a deliberate **Reset All Data** operation from silently recreating teams after a restart. A reset remains destructive and requires the exact confirmation phrase in the UI.

## Excel import

Use the bundled `SNKPL_Auction_Import_Ready.xlsx` file from the Excel Import page. It contains 671 player records on `Player Import`. The importer:

- Reads player name, category, role, previous price/team, country and base price.
- Supports `Indian`, `Overseas`, and `Associate` categories.
- Skips names that already exist in MongoDB, while preserving all distinct rows inside the uploaded workbook (including repeated names supplied as separate source rows).
- Reads `Team Code Reference` for previous-team codes but does not create extra historical franchises; the auction remains the 14 configured SNK teams.
- Supports optional `Photo URL` columns.

## Auction rules retained

- Player states: `AVAILABLE`, `SOLD`, `UNSOLD`, and `RETAINED`.
- RTM: 3 Indian + 3 Overseas/Associate cards per team. Indian players use Indian RTM; Overseas and Associate players use Overseas/Associate RTM. RTM eligibility is checked against the player's previous team.
- Squad size: 17–20 players; category and mandatory reserve validation is applied during acquisition.
- Associate slots: the first 2 Associate players use dedicated Associate places; the 3rd and later count against effective Overseas capacity.
- Minimum squad composition: 8 Indian, 8 effective Overseas and 1 Associate. Maximums: 9 Indian, 9 effective Overseas and 20 total.
- Mandatory purse reserve: ₹0.50 Cr for each still-needed squad slot while building the minimum 17-player squad.
- Trade: the buyer purse is deducted and the seller purse is credited by the same trade amount. Trade history records seller, buyer, player and amount.
- SOLD, UNSOLD, RTM, retention, release and trade events are retained in auction history.

## MongoDB collections

See `database/README.md` for the collection/index list. Numeric IDs are maintained with atomic counter documents so the existing browser UI and backup format continue to work without an ObjectId migration in the frontend.

Purse-changing actions (SOLD, RTM, retention, trade and restore) use MongoDB transactions. Use Atlas or another replica-set deployment; a standalone local MongoDB server does not support these transactions.

## Existing features

- Excel import and player database search/filter
- 14 team purse cards, team logos and squad breakdown
- SOLD / UNSOLD / re-auction / RTM / retention and release
- Buyer-only trade purse deduction and trade history
- Squad Builder and Playing XI Analyzer
- Auction History, player dossier and auction statistics
- Excel reports and JSON backup/restore
- Live Auction screen, nomination center, timer and result animations
- Separate `broadcast.html` viewer with team logos and auctioneer branding
- Existing SNK Friends logos, auctioneer artwork, theme styles and dashboard UI

## Vercel deployment

This project includes `api/index.js` and `vercel.json` for Vercel's Node.js function runtime. Add `MONGODB_URI`, `MONGODB_DB_NAME`, and `SESSION_SECRET` under **Project → Settings → Environment Variables**, then redeploy. Remove old `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` variables if present; they are no longer read by this build.

Vercel Functions are serverless and do not provide a persistent Socket.IO WebSocket server. The broadcast viewer therefore also polls the MongoDB-backed `/api/broadcast/state` endpoint, so the live viewer continues to update on Vercel. For full Socket.IO multi-client push behavior, run the same app on a persistent Node.js host.

## Tests

Run the rule tests with:

```bash
npm test
```

They cover the 14-team seed configuration, Associate slot accounting, squad category/reserve validation, and the buyer-only trade purse rule. A live Atlas smoke test additionally requires a valid `MONGODB_URI` and installed npm dependencies.
