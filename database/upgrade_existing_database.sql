USE cricket_auction;
-- Run once if your existing players table does not yet have photo_url.
ALTER TABLE players ADD COLUMN photo_url TEXT NULL;
