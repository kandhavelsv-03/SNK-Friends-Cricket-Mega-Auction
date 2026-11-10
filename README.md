# Cricket Mega Auction Management System

A Node.js + Express + MySQL starter application with a responsive auction dashboard.

## Features included
- MySQL-backed teams and players
- Excel import (.xlsx/.xls)
- ₹90 Cr team purse
- Retention restricted to previous-season team, with category RTM deduction
- Release retained players back to the auction pool
- Release of retained players
- Trade: buyer purse is deducted only; seller purse is not credited
- Live auction screen, manual bids, sold and unsold actions
- RTM restricted to the player's previous team
- Unsold re-auction
- Squad dashboard and transaction history
- Associate rule: first 2 Associate players occupy Associate slots; 3rd onward count against effective Overseas slots
- ₹0.50 Cr mandatory empty-slot reserve and category feasibility checks

## Requirements
- Node.js 18+
- MySQL 8+

## Setup
1. Create the database:
   ```bash
   mysql -u root -p < database/schema.sql
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and update your MySQL credentials.
4. Start:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000`.

## Excel columns
The first worksheet should contain columns equivalent to:
- Player Name
- Country Category (Indian / Overseas / Associate)
- Role
- Previous Price
- Previous Team
- Country

Column headings are normalized, so spaces and punctuation are ignored. The category values must be exactly Indian, Overseas, or Associate.

## Important implementation notes
- Money values are stored in Crores. ₹50 Lakhs = `0.50`.
- RTM balances begin at 3 Indian + 3 Overseas/Associate.
- Associate players 1 and 2 count in Associate slots; player 3 onward also consume effective Overseas slots.
- The final team must satisfy minimum 17 total, 8 Indian, 8 effective Overseas, and 1 Associate. Maximums: 20 total, 9 Indian, 9 effective Overseas, 2 Associate.
- This starter implements the core auction flows. Before a public or high-stakes live event, add admin authentication/authorization, explicit retention team eligibility, stronger concurrent-bid locking, production logging, backups, CSRF/rate limiting, and end-to-end tests.
- The RTM interface currently uses the selected team; backend verifies that it matches the player's `previous_team` text exactly. Make sure Excel previous-team names match franchise names, or add a team mapping during import.


## Updates in this build
- Trade history now displays buyer, seller, and trade amount. Only the buyer purse is reduced; seller purse is unchanged.
- Associate slot rule: first 2 Associates use dedicated slots; the 3rd and later Associates consume Overseas capacity. Maximum is 2 dedicated + 9 Overseas-equivalent.
- Importing the master workbook also imports every code in `Team Code Reference` as a team (existing teams and balances are not overwritten). Known SNKPL purse values are prefilled; other codes start at ₹90 Cr.
- Live auction snapshot follows the most recent team to acquire a player.
- SOLD / UNSOLD result animations added.
- Optional `photo_url` / `Photo URL` column supported for exact player portraits. If no verified image URL is supplied, the app uses initials rather than guessing a player's face.

For an existing database, the app attempts to add `players.photo_url` automatically on startup. If your MySQL user lacks ALTER permission, run `database/upgrade_existing_database.sql` once (after confirming the column does not already exist).


## Trade and fresh-start reset update
- Trade debits the buyer by the trade amount and credits the seller by the same amount.
- Trade confirmation previews both purse changes; zero/invalid trades are rejected and insufficient buyer purse is blocked.
- `Reset All Data` requires browser confirmation plus the exact phrase `DELETE ALL DATA`. It permanently deletes teams, players, squads, bids, trades and auction history from `cricket_auction`; it is not run automatically.
- UI polish added. The visual palette can be changed when the user supplies preferred team/theme choices.


## SNK Friends identity assets
- `public/assets/snk-friends-logo.jpg`: main organiser logo shown on dashboard.
- `public/assets/snk-admin-profile.jpg`: admin profile badge shown on dashboard.
- `public/assets/snk-auctioneer.jpg`: auctioneer portrait shown in the live auction stage and in the SOLD/UNSOLD result animation with a gavel strike effect.


## SNK Friends Feature Pack
This update adds:
- Team Squad Builder with role/category composition and remaining purse.
- Auction Statistics and team spending leaderboard.
- Full-screen Live Broadcast screen using SNK Friends organiser and auctioneer assets.
- Smart player filters by name, category, role and status; live auction pool filters by name/category/role.
- Excel export report (team purse, player register, trade history). PDF export uses browser Print → Save as PDF.
- RTM counters and existing RTM validation (3 Indian + 3 Overseas/Associate cards per team).
- Trade history via the existing audit history, including seller and buyer names.
- Auction countdown timer with start, pause and reset.
- JSON backup download and explicit JSON restore; restore replaces current records, so download a backup first.
- Theme selector: SNK Friends Official, Dark Gold Premium, IPL Stadium, Neon Sports.
- Existing auction next/previous controls and SOLD/UNSOLD actions remain available.
- Existing database tables and records are not reset or modified by installation. New endpoints are additive.


## Latest UI fixes
- Sidebar navigation now has its own vertical scrollbar and remains usable on shorter screens.
- The latest user-provided auctioneer action photo is used in the SOLD/UNSOLD result announcement, with an entrance animation and result stamp.


## Viewer broadcast and BR logo
- Open `http://localhost:3000/broadcast.html` in a separate viewer window or use it as an OBS Browser Source URL.
- Admin continues to use the normal dashboard and Live Auction page. Auction state is relayed over Socket.IO to viewer screens without exposing admin navigation or controls.
- BR team cards and SOLD result displays use `public/assets/br-bulls-logo.png`.
- SOLD/UNSOLD confirmations use a large custom in-page dialog with the auctioneer photo rather than the small browser confirm popup.


## Phase 2 expansion
- Player dossier modal with existing player data, recent bid history and auction events (does not fabricate external career statistics).
- Nomination Center with category/role filters, manual nomination and random nomination.
- Playing XI selector with role-balance guidance; this is a planning aid, not a performance prediction.
- Tournament Center with team purse, squad-size and category composition overview.
- Live bid countdown (30 seconds, reset on new bid), plus lightweight bid/end/SOLD/UNSOLD sound cues.
- Team owner authenticated login is not enabled in this build; it requires creating and distributing secure per-team credentials. The admin remains the only user with auction controls. Do not expose admin login credentials to viewers.

## Team logo pack (November 2026)
The uploaded team emblems are bundled in `public/assets/` as optimized WebP images and are mapped automatically by team short code throughout the admin UI, team cards, auction result, history, squad/analytics views, and viewer broadcast SOLD panel.

Logo mapping:
- SS → team-ss.webp
- DCS / BCS → team-dcs.webp (uploaded artwork reads DCS)
- BR → team-br.webp
- 7SV / 7SB → team-7sv.webp (uploaded artwork reads 7SV)
- KD² / KD2 / KD Square → team-kd2.webp
- ARC → team-arc.webp
- KCG → team-kcg.webp
- RH → team-rh.webp
- CC → team-cc.webp
- BBC → team-bbc.webp
- FCK → team-fck.webp
- VTK → team-vtk.webp
- AKS → team-aks.webp
- TG → team-tg.webp

If a team short code differs from these aliases, add its alias in `teamLogoMarkup()` in `public/app.js` and in the `logos` map in `public/broadcast.html`.
