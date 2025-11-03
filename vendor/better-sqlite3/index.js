'use strict';

const fs = require('fs');
const path = require('path');

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(params) {
    this.db._run(this.sql, params ?? {});
  }
}

class Database {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = { trades: [], positions: [], health: [] };
    this._load();
  }

  pragma() {
    // stub ignores pragma settings
  }

  exec() {
    // schema creation is a no-op in stub implementation
    this._persist();
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  _load() {
    if (fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = { trades: [], positions: [], health: [], ...data };
      } catch (err) {
        // ignore corrupted files and reset state
        this.state = { trades: [], positions: [], health: [] };
      }
    }
  }

  _persist() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  _run(sql, params) {
    const text = sql.toUpperCase();
    if (text.includes('INSERT INTO TRADES')) {
      this.state.trades.push({ ...params });
      this._persist();
      return;
    }
    if (text.includes('INSERT INTO POSITIONS')) {
      this.state.positions.push({ ...params });
      this._persist();
      return;
    }
    if (text.includes('INSERT INTO HEALTH')) {
      this.state.health.push({ ...params });
      this._persist();
      return;
    }
  }
}

module.exports = Database;
module.exports.default = Database;
