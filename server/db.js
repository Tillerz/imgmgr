import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { config, ROOT } from './config.js';

const cacheDir = join(ROOT, config.cacheDir);
mkdirSync(join(cacheDir, 'thumbs'), { recursive: true });

const db = new Database(join(cacheDir, 'imgmgr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    parent_path TEXT
  );

  CREATE TABLE IF NOT EXISTS images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT UNIQUE NOT NULL,
    filename       TEXT NOT NULL,
    folder_path    TEXT NOT NULL,
    size           INTEGER DEFAULT 0,
    mtime          INTEGER DEFAULT 0,
    width          INTEGER DEFAULT 0,
    height         INTEGER DEFAULT 0,
    format         TEXT,
    file_hash      TEXT,
    phash          TEXT,
    favorite       INTEGER DEFAULT 0,
    thumbnail_path TEXT,
    positive_prompt TEXT,
    negative_prompt TEXT,
    indexed_at     INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS metadata (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tags (
    image_id INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    PRIMARY KEY (image_id, tag),
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_images_folder   ON images(folder_path);
  CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
  CREATE INDEX IF NOT EXISTS idx_images_mtime    ON images(mtime);
  CREATE INDEX IF NOT EXISTS idx_images_hash     ON images(file_hash);
  CREATE INDEX IF NOT EXISTS idx_meta_image      ON metadata(image_id);
  CREATE INDEX IF NOT EXISTS idx_meta_key        ON metadata(key);
  CREATE INDEX IF NOT EXISTS idx_tags_image      ON tags(image_id);
  CREATE INDEX IF NOT EXISTS idx_tags_tag        ON tags(tag);
`);

export default db;
