const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'exhibit.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 素材：策展人登记的数字素材
CREATE TABLE IF NOT EXISTS materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 来源关系：derived_id 由 source_id 派生而来
-- （source_id 是被依赖的上游来源，授权沿 source -> ... -> selected 向上游链核验）
CREATE TABLE IF NOT EXISTS source_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  derived_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (derived_id, source_id),
  CHECK (derived_id <> source_id)
);

-- 授权：某素材在某媒介/地区/时间段内的使用授权
CREATE TABLE IF NOT EXISTS authorizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  medium      TEXT NOT NULL,
  territory   TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  licensor    TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date <= end_date)
);

-- 展览包
-- status: draft 待发布 / published 已发布 / needs_review 需复核
CREATE TABLE IF NOT EXISTS packages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published','needs_review')),
  medium       TEXT,
  territory    TEXT,
  start_date   TEXT,
  end_date     TEXT,
  snapshot_id  INTEGER,
  current_eligible INTEGER,          -- 按当前数据实时重算的资格（draft 为 NULL）
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS package_materials (
  package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, material_id)
);

-- 不可变核验快照（发布时原子写入，追加，永不修改/删除）
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id   INTEGER NOT NULL,
  package_name TEXT NOT NULL,
  basis_version INTEGER NOT NULL,
  medium       TEXT NOT NULL,
  territory    TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  eligible     INTEGER NOT NULL,
  results_json TEXT NOT NULL,       -- 逐节点核验结论
  payload_json TEXT NOT NULL,       -- 素材清单与完整来源图
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_edges_derived  ON source_edges(derived_id);
CREATE INDEX IF NOT EXISTS idx_edges_source   ON source_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_auths_material ON authorizations(material_id);
CREATE INDEX IF NOT EXISTS idx_pkgmats_pkg    ON package_materials(package_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_pkg  ON snapshots(package_id);
`);

// 依据版本号：素材 / 来源关系 / 授权的任何变更都使其 +1
// （展览包本身的编辑不影响授权依据，不触发）
for (const table of ['materials', 'source_edges', 'authorizations']) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_ins AFTER INSERT ON ${table}
    BEGIN
      INSERT INTO meta(key,value) VALUES('basis_version','0')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER)+1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_del AFTER DELETE ON ${table}
    BEGIN
      INSERT INTO meta(key,value) VALUES('basis_version','0')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER)+1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_${table}_upd AFTER UPDATE ON ${table}
    BEGIN
      INSERT INTO meta(key,value) VALUES('basis_version','0')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER)+1;
    END;
  `);
}

function getBasisVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key='basis_version'`).get();
  return row ? parseInt(row.value, 10) : 0;
}

module.exports = { db, DB_PATH, getBasisVersion };
