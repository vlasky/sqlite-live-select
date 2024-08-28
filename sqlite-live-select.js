//NOTE: Draft JavaScript code, providing a vision of what the sqlite-live-select implementation could look like. 

const Database = require('better-sqlite3');
const chokidar = require('chokidar');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs').promises;

class LiveSQLiteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LiveSQLiteError';
    this.code = code;
  }
}

class LiveSQLite extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = {
      filename: '',
      pool: false,
      minInterval: 0,
      checkConditionWhenQueued: false,
      columnCache: {},
      ...settings
    };
    this.db = new Database(this.settings.filename, this.settings);
    this.watcher = null;
    this.liveQueries = new Map();
    this.paused = false;
    this.lastWalSize = 0;
    this.pageSize = this.getPageSize();
    this.lastProcessTime = 0;
    this.queuedUpdates = new Set();
    this.poolConnections = this.settings.pool ? this.createConnectionPool() : null;
    this.tableCache = new Map();
    this.tableInfo = new Map();
    this.usedTables = new Set();
    this.setupWatcher();
    this.emit('ready');
  }

  createConnectionPool() {
    const pool = [];
    for (let i = 0; i < 5; i++) {
      pool.push(new Database(this.settings.filename, this.settings));
    }
    return pool;
  }

  getPoolConnection() {
    if (!this.poolConnections) return this.db;
    return this.poolConnections[Math.floor(Math.random() * this.poolConnections.length)];
  }

  getPageSize() {
    return this.db.prepare('PRAGMA page_size').pluck().get();
  }

  setupWatcher() {
    const dbPath = path.resolve(this.settings.filename);
    const walPath = `${dbPath}-wal`;

    this.watcher = chokidar.watch(walPath, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', () => this.processWALChanges(walPath));
  }

  cacheTableInfo(tableName) {
    try {
      const columnInfo = this.db.prepare(`PRAGMA table_info(${this.escapeId(tableName)})`).all();
      this.tableInfo.set(tableName, columnInfo);
    } catch (error) {
      throw new LiveSQLiteError(`Failed to cache table info for ${tableName}: ${error.message}`, 'CACHE_TABLE_INFO_ERROR');
    }
  }

  cacheTable(tableName) {
    try {
      if (!this.tableInfo.has(tableName)) {
        this.cacheTableInfo(tableName);
      }

      const cacheSettings = this.settings.columnCache[tableName] || {};
      const tableInfo = this.tableInfo.get(tableName);
      let columns = tableInfo.map(col => col.name);
      
      if (cacheSettings.include) {
        columns = cacheSettings.include;
      } else if (cacheSettings.exclude) {
        columns = columns.filter(col => !cacheSettings.exclude.includes(col));
      }

      const columnString = columns.map(this.escapeId).join(', ');
      const rows = this.db.prepare(`SELECT rowid, ${columnString} FROM ${this.escapeId(tableName)}`).all();
      const cache = new Map();
      for (const row of rows) {
        cache.set(row.rowid, row);
      }
      this.tableCache.set(tableName, cache);
    } catch (error) {
      throw new LiveSQLiteError(`Failed to cache table ${tableName}: ${error.message}`, 'CACHE_TABLE_ERROR');
    }
  }

  ensureTableCached(tableName) {
    if (!this.tableCache.has(tableName)) {
      this.cacheTable(tableName);
    }
    this.usedTables.add(tableName);
  }

  async processWALChanges(walPath) {
    if (this.paused) return;

    const now = Date.now();
    if (now - this.lastProcessTime < this.settings.minInterval) {
      if (!this.updateTimeout) {
        this.updateTimeout = setTimeout(() => {
          this.updateTimeout = null;
          this.processWALChanges(walPath);
        }, this.settings.minInterval - (now - this.lastProcessTime));
      }
      return;
    }

    this.lastProcessTime = now;

    try {
      const stats = await fs.stat(walPath);
      const currentSize = stats.size;
      if (currentSize > this.lastWalSize) {
        await this.parseWAL(walPath, this.lastWalSize, currentSize);
      }
      this.lastWalSize = currentSize;
    } catch (err) {
      this.emit('error', new LiveSQLiteError(`Failed to process WAL changes: ${err.message}`, 'WAL_PROCESS_ERROR'));
    }
  }

  async parseWAL(walPath, start, end) {
    try {
      const buffer = Buffer.alloc(end - start);
      const file = await fs.open(walPath, 'r');
      await file.read(buffer, 0, buffer.length, start);
      await file.close();

      let offset = 0;
      const changes = new Map();

      while (offset < buffer.length) {
        const frameSize = buffer.readUInt32LE(offset);
        const pageNumber = buffer.readUInt32LE(offset + 4);
        const pageData = buffer.slice(offset + 8, offset + frameSize);
        
        this.processWALFrame(pageNumber, pageData, changes);
        
        offset += frameSize;
      }

      this.applyChanges(changes);
    } catch (error) {
      throw new LiveSQLiteError(`Failed to parse WAL: ${error.message}`, 'WAL_PARSE_ERROR');
    }
  }

  processWALFrame(pageNumber, pageData, changes) {
    const pageType = pageData.readUInt8(0);
    
    if (pageType === 13) { // Leaf table b-tree page
      const tableInfo = this.getTableInfo(pageNumber);
      if (tableInfo && this.usedTables.has(tableInfo.name)) {
        const cellCount = pageData.readUInt16BE(3);
        let cellPointerOffset = 8;

        for (let i = 0; i < cellCount; i++) {
          const cellOffset = pageData.readUInt16BE(cellPointerOffset);
          const rowId = this.readVarint(pageData, cellOffset);
          const payloadSize = this.readVarint(pageData, cellOffset + this.getVarintSize(pageData, cellOffset));
          const payloadOffset = cellOffset + this.getVarintSize(pageData, cellOffset) + this.getVarintSize(pageData, cellOffset + this.getVarintSize(pageData, cellOffset));

          if (!changes.has(tableInfo.name)) {
            changes.set(tableInfo.name, new Map());
          }
          const rowChanges = this.parseRowData(tableInfo.name, pageData.slice(payloadOffset, payloadOffset + payloadSize));
          changes.get(tableInfo.name).set(rowId, rowChanges);

          cellPointerOffset += 2;
        }
      }
    }
  }

  parseRowData(tableName, data) {
    const columns = this.tableInfo.get(tableName);
    const rowData = {};
    let offset = 0;

    for (const column of columns) {
      try {
        const value = this.parseValue(data, offset, column.type);
        rowData[column.name] = value;
        offset += this.getValueSize(data, offset, column.type);
      } catch (error) {
        throw new LiveSQLiteError(`Failed to parse column ${column.name} in table ${tableName}: ${error.message}`, 'PARSE_COLUMN_ERROR');
      }
    }

    return rowData;
  }

  parseValue(data, offset, type) {
    switch (type) {
      case 'INTEGER':
        return this.readVarint(data, offset);
      case 'REAL':
        return data.readDoubleLE(offset);
      case 'TEXT':
        const length = this.readVarint(data, offset);
        const textData = data.toString('utf8', offset + this.getVarintSize(data, offset), offset + this.getVarintSize(data, offset) + length);
        try {
          return JSON.parse(textData);
        } catch {
          return textData;
        }
      case 'BLOB':
        const blobLength = this.readVarint(data, offset);
        return data.slice(offset + this.getVarintSize(data, offset), offset + this.getVarintSize(data, offset) + blobLength);
      default:
        return null;
    }
  }

  getValueSize(data, offset, type) {
    switch (type) {
      case 'INTEGER':
        return this.getVarintSize(data, offset);
      case 'REAL':
        return 8;
      case 'TEXT':
      case 'BLOB':
        const length = this.readVarint(data, offset);
        return this.getVarintSize(data, offset) + length;
      default:
        return 0;
    }
  }

  getTableInfo(pageNumber) {
    const stmt = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE rootpage = ?
    `);
    return stmt.get(pageNumber);
  }

  getVarintSize(buffer, offset) {
    let size = 0;
    while (size < 8 && (buffer[offset + size] & 0x80) !== 0) {
      size++;
    }
    return size + 1;
  }

  readVarint(buffer, offset) {
    let value = 0;
    let size = 0;
    while (size < 8) {
      const byte = buffer[offset + size];
      value |= (byte & 0x7F) << (7 * size);
      if ((byte & 0x80) === 0) break;
      size++;
    }
    return value;
  }

  applyChanges(changes) {
    for (const [tableName, rowChanges] of changes) {
      const tableCache = this.tableCache.get(tableName);
      if (!tableCache) continue;

      for (const [rowId, newRow] of rowChanges) {
        const oldRow = tableCache.get(rowId);

        if (!oldRow && newRow) {
          // Insert
          tableCache.set(rowId, newRow);
          this.notifyQueries(tableName, null, newRow, false);
        } else if (oldRow && !newRow) {
          // Delete
          tableCache.delete(rowId);
          this.notifyQueries(tableName, oldRow, null, true);
        } else if (oldRow && newRow) {
          // Update
          tableCache.set(rowId, newRow);
          this.notifyQueries(tableName, oldRow, newRow, false);
        }
      }
    }
  }

  notifyQueries(tableName, oldRow, newRow, rowDeleted) {
    for (const [queryId, query] of this.liveQueries) {
      const needsUpdate = query.triggers.some(trigger => {
        if (trigger.table !== tableName) return false;

        if (trigger.condition) {
          return trigger.condition(newRow, oldRow, rowDeleted);
        }
        return true;
      });

      if (needsUpdate) {
        if (this.settings.checkConditionWhenQueued || !this.queuedUpdates.has(queryId)) {
          this.queuedUpdates.add(queryId);
          query.invalidate();
        }
      }
    }
  }

  select(query, values, keySelector, triggers) {
    const stmt = this.getPoolConnection().prepare(query);
    
    // Ensure all tables used in triggers are cached
    for (const trigger of triggers) {
      this.ensureTableCached(trigger.table);
    }

    const liveQuery = new LiveSQLiteSelect(this, stmt, values, keySelector, triggers);
    this.liveQueries.set(liveQuery.id, liveQuery);
    return liveQuery;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.processWALChanges(path.resolve(this.settings.filename) + '-wal');
  }

  end() {
    if (this.watcher) {
      this.watcher.close();
    }
    this.db.close();
    if (this.poolConnections) {
      this.poolConnections.forEach(conn => conn.close());
    }
    this.liveQueries.clear();
    this.tableCache.clear();
    this.tableInfo.clear();
    this.usedTables.clear();
  }

  escape(value) {
    return this.db.prepare('SELECT ? AS escaped').pluck().get(value);
  }

  escapeId(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  }  
}

class LiveSQLiteSelect extends EventEmitter {
  constructor(liveSQL, stmt, values, keySelector, triggers) {
    super();
    this.liveSQL = liveSQL;
    this.stmt = stmt;
    this.values = values;
    this.keySelector = keySelector;
    this.triggers = triggers;
    this.lastResult = null;
    this.id = Symbol('LiveSQLiteSelect');
    this.active = true;

    this.execute();
  }

  execute() {
    try {
      const newResult = this.stmt.all(this.values);
      const diff = this.diffResults(this.lastResult, newResult);
      
      if (diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0) {
        this.emit('update', diff, newResult);
      }
      
      this.lastResult = newResult;
    } catch (error) {
      this.emit('error', error);
    }
  }

  diffResults(oldResult, newResult) {
    const diff = { added: [], changed: [], removed: [] };
    const oldKeys = new Set(oldResult ? oldResult.map(this.keySelector) : []);
    const newKeys = new Set(newResult.map(this.keySelector));

    for (const row of newResult) {
      const key = this.keySelector(row);
      if (!oldKeys.has(key)) {
        diff.added.push(row);
      } else if (JSON.stringify(row) !== JSON.stringify(oldResult.find(r => this.keySelector(r) === key))) {
        diff.changed.push(row);
      }
    }

    for (const row of oldResult || []) {
      const key = this.keySelector(row);
      if (!newKeys.has(key)) {
        diff.removed.push(row);
      }
    }

    return diff;
  }

  invalidate() {
    if (this.active) {
      this.execute();
    }
  }

  stop() {
    this.active = false;
    this.liveSQL.liveQueries.delete(this.id);
  }
}

const LiveSQLiteKeySelector = {
  Index: () => (row, index) => index,
  Columns: (columns) => (row) => columns.map(col => row[col]).join('|'),
  Func: (keyFunc) => keyFunc,
};


module.exports = { LiveSQLite, LiveSQLiteKeySelector, LiveSQLiteError };
