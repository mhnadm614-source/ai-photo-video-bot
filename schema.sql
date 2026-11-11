CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_user_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (referrer_id) REFERENCES users(telegram_id),
  FOREIGN KEY (referred_user_id) REFERENCES users(telegram_id)
);

CREATE TABLE IF NOT EXISTS daily_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  points INTEGER NOT NULL,
  UNIQUE (telegram_id, claim_date),
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE TABLE IF NOT EXISTS media_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);
