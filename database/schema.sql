CREATE DATABASE IF NOT EXISTS cricket_auction CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cricket_auction;

CREATE TABLE IF NOT EXISTS teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  short_name VARCHAR(20),
  logo_url TEXT,
  initial_purse DECIMAL(10,2) NOT NULL DEFAULT 90.00,
  remaining_purse DECIMAL(10,2) NOT NULL DEFAULT 90.00,
  indian_rtm INT NOT NULL DEFAULT 3,
  overseas_rtm INT NOT NULL DEFAULT 3,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS players (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  country VARCHAR(100),
  category ENUM('Indian','Overseas','Associate') NOT NULL,
  role ENUM('Batter','Batting All-Rounder','Bowling All-Rounder','Bowler','Wicket Keeper') NOT NULL,
  previous_price DECIMAL(10,2) DEFAULT 0,
  previous_team VARCHAR(100),
  base_price DECIMAL(10,2) DEFAULT 0.50,
  photo_url TEXT NULL,
  status ENUM('AVAILABLE','RETAINED','SOLD','UNSOLD') NOT NULL DEFAULT 'AVAILABLE',
  current_team_id INT NULL,
  sold_price DECIMAL(10,2) NULL,
  acquisition_type ENUM('Retention','Auction','RTM','Trade') NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_player_team FOREIGN KEY (current_team_id) REFERENCES teams(id) ON DELETE SET NULL,
  INDEX idx_player_status(status), INDEX idx_player_name(name)
);

CREATE TABLE IF NOT EXISTS team_squads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  player_id INT NOT NULL UNIQUE,
  amount DECIMAL(10,2) NOT NULL,
  acquisition_type ENUM('Retention','Auction','RTM','Trade') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS auction_bids (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT NOT NULL,
  team_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS trades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT NOT NULL,
  from_team_id INT NOT NULL,
  to_team_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (from_team_id) REFERENCES teams(id),
  FOREIGN KEY (to_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS auction_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT,
  team_id INT,
  event_type VARCHAR(30) NOT NULL,
  amount DECIMAL(10,2),
  details JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);
