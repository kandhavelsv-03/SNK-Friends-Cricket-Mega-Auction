# MongoDB Atlas migration

This project runtime now uses MongoDB Atlas (`mongodb` + `connect-mongo`) and no longer uses the MySQL driver.

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI`, `MONGODB_DB_NAME=cricket_auction`, and a newly generated `SESSION_SECRET`.
3. Run `npm install` (the old MySQL-era lockfile was removed so npm can generate a lockfile for the MongoDB dependencies).
4. Run `npm start`.
5. Open `http://localhost:3000/api/health`; expected JSON includes `"ok":true` and `"provider":"mongodb"`.

On first startup, if the `teams` collection is empty, the app seeds the 14 configured SNKPL teams and their purse values. Existing player documents are preserved; numeric player IDs are retained. Existing players are not re-imported or deleted.

Excel import skips players whose normalized names already exist and imports missing players. The team-code reference sheet is used to add missing team codes.

## Vercel

Set the same environment variables in Vercel (Production, Preview as needed), then redeploy. The API entrypoint waits for MongoDB connection/index initialization. Broadcast viewer state is persisted in the `broadcast_state` collection and polled by the viewer page, because Vercel serverless functions do not provide a persistent Socket.IO server.

## Important

- Do not commit `.env` or real credentials.
- Rotate any MongoDB password or session secret previously pasted into chat or source control.
- MongoDB transactions require Atlas (replica set), which is supported by Atlas clusters.
- This migration has passed local syntax checks and the repository's 7 automated tests. A live Atlas connection and real Vercel deployment still need to be tested with your private environment variables.
