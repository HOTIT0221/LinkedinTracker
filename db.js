'use strict';

// SQLite storage, using the SQLite engine built into Electron's Node.js (no native modules to compile).
// Every change is written to the database file immediately.
//
// The tables and their versions (PRAGMA user_version 1–5) are the same as the LinkedIn part of
// HOTIT Manager's database, where this app's data lived until HOTIT Manager 3.8. That is what lets
// importDatabase() read a HOTIT Manager database or backup as well as this app's own backups.

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { countryFromLegacyValue } = require('./src/countries');

const SCHEMA_VERSION = 5;
const PURGE_DELETED_AFTER_DAYS = 30;

let db = null;
let dbFile = null;

const CONTACT_COLS = `id, account_id, name, linkedin_url, nationality, headline, notes, created_at, updated_at`;

// ---------- open / migrate ----------

/** onUpgrade(oldVersion) runs before an existing database is upgraded, e.g. to back it up. */
function open(file, { onUpgrade } = {}) {
  close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  // Rollback journal (not WAL) keeps everything in one file, which is safer
  // if the database lives in a synced folder such as OneDrive or Dropbox.
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
  dbFile = file;
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    close();
    throw new Error('This file is not a LinkedIn Tracker database (it may be a HOTIT Manager one: use File → Import from HOTIT Manager).');
  }
  if (onUpgrade && version > 0 && version < SCHEMA_VERSION) onUpgrade(version);
  migrate();
  ensureAccount();
  purgeDeleted();
}

function close() {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
  }
  db = null;
  dbFile = null;
}

function currentFile() {
  return dbFile;
}

function isOpen() {
  return !!db;
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          linkedin_url  TEXT NOT NULL DEFAULT '',
          nationality   TEXT NOT NULL DEFAULT '',
          headline      TEXT NOT NULL DEFAULT '',
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          deleted_at    TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id          TEXT PRIMARY KEY,
          contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          text        TEXT NOT NULL,
          sent_at     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          deleted_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, sent_at);
        -- owner_id is a contact id or an account id (before v5: '__me__' for your own photo)
        CREATE TABLE IF NOT EXISTS avatars (
          owner_id    TEXT PRIMARY KEY,
          mime        TEXT NOT NULL,
          data        BLOB NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id          TEXT PRIMARY KEY,
          message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL DEFAULT 0,
          name        TEXT NOT NULL DEFAULT '',
          mime        TEXT NOT NULL,
          width       INTEGER NOT NULL DEFAULT 0,
          height      INTEGER NOT NULL DEFAULT 0,
          size        INTEGER NOT NULL DEFAULT 0,
          data        BLOB NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, position);
      `);
      db.exec('PRAGMA user_version = 2');
    });
  }
  if (version < 3) {
    // the "nationality" column now holds a country name: convert "German" -> "Germany" etc.
    tx(() => {
      const update = db.prepare('UPDATE contacts SET nationality = ? WHERE id = ?');
      for (const r of db.prepare(`SELECT id, nationality FROM contacts WHERE nationality <> ''`).all()) {
        const country = countryFromLegacyValue(r.nationality);
        if (country !== r.nationality) update.run(country, r.id);
      }
      db.exec('PRAGMA user_version = 3');
    });
  }
  if (version < 4) {
    // when the recipient saw a sent message (like LinkedIn's "seen" avatar); NULL = not seen yet
    tx(() => {
      db.exec('ALTER TABLE messages ADD COLUMN seen_at TEXT');
      db.exec('PRAGMA user_version = 4');
    });
  }
  if (version < 5) {
    // several LinkedIn accounts: each contact belongs to one of your accounts.
    // Your existing name and photo become the first account.
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          linkedin_url  TEXT NOT NULL DEFAULT '',
          position      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        ALTER TABLE contacts ADD COLUMN account_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
      `);
      const nameRow = db.prepare(`SELECT value FROM settings WHERE key = 'myName'`).get();
      let name = 'Me';
      try { name = (nameRow && JSON.parse(nameRow.value)) || 'Me'; } catch { /* keep default */ }
      const id = crypto.randomUUID();
      const t = now();
      db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(id, str(name, 200), '', t, t);
      db.prepare('UPDATE contacts SET account_id = ?').run(id);
      db.prepare(`UPDATE avatars SET owner_id = ? WHERE owner_id = '__me__'`).run(id);
      db.prepare(`DELETE FROM settings WHERE key = 'myName'`).run();
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('currentAccount', ?)`).run(JSON.stringify(id));
      db.exec('PRAGMA user_version = 5');
    });
  }
}

/** There is always at least one account (e.g. after importing an old backup into an empty database). */
function ensureAccount() {
  if (db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n) return;
  const id = crypto.randomUUID();
  const t = now();
  db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, 'Me', '', t, t);
  db.prepare('UPDATE contacts SET account_id = ? WHERE account_id IS NULL').run(id);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function now() {
  return new Date().toISOString();
}

function str(v, max = 100000) {
  return String(v ?? '').slice(0, max);
}

function purgeDeleted() {
  const cutoff = new Date(Date.now() - PURGE_DELETED_AFTER_DAYS * 86400000).toISOString();
  tx(() => {
    for (const table of ['messages', 'contacts']) {
      db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff);
    }
    db.prepare(`
      DELETE FROM avatars WHERE owner_id NOT IN (SELECT id FROM contacts) AND owner_id NOT IN (SELECT id FROM accounts)
    `).run();
  });
}

// ---------- reading ----------

function rowToAccount(r) {
  return {
    id: r.id,
    name: r.name,
    linkedinUrl: r.linkedin_url,
    position: r.position,
    createdAt: r.created_at,
    avatarVersion: r.avatar_updated_at || null,
  };
}

function rowToContact(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    linkedinUrl: r.linkedin_url,
    nationality: r.nationality,
    headline: r.headline,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    avatarVersion: r.avatar_updated_at || null,
  };
}

function rowToMessage(r) {
  return {
    id: r.id,
    contactId: r.contact_id,
    direction: r.direction,
    text: r.text,
    sentAt: r.sent_at,
    seenAt: r.seen_at || null,
    createdAt: r.created_at,
  };
}

/** Only sent messages can be "seen"; anything else is stored as NULL. */
function seenValue(m) {
  if (m.direction !== 'out' || !m.seenAt) return null;
  const d = new Date(m.seenAt);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid seen time');
  return d.toISOString();
}

function getSettings() {
  // currentAccount: id of the LinkedIn account being viewed, '' = all accounts
  const settings = { timeZone: '', currentAccount: '' };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { settings[r.key] = JSON.parse(r.value); } catch { /* skip bad value */ }
  }
  return settings;
}

function listAccounts() {
  return db.prepare(`
    SELECT ac.*, a.updated_at AS avatar_updated_at
    FROM accounts ac LEFT JOIN avatars a ON a.owner_id = ac.id
    ORDER BY ac.position, ac.created_at
  `).all().map(rowToAccount);
}

function loadAll() {
  const contacts = db.prepare(`
    SELECT c.${CONTACT_COLS.split(', ').join(', c.')}, a.updated_at AS avatar_updated_at
    FROM contacts c LEFT JOIN avatars a ON a.owner_id = c.id
    WHERE c.deleted_at IS NULL
  `).all().map(rowToContact);
  const messages = db.prepare(`
    SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL
    ORDER BY m.sent_at, m.created_at
  `).all().map(rowToMessage);

  // attachment metadata only; the image bytes are served through attachment://
  const byMessage = new Map();
  for (const a of db.prepare(`
    SELECT id, message_id, name, mime, width, height, size FROM attachments ORDER BY message_id, position
  `).all()) {
    if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
    byMessage.get(a.message_id).push(rowToAttachment(a));
  }
  for (const m of messages) m.attachments = byMessage.get(m.id) || [];

  return {
    settings: getSettings(),
    accounts: listAccounts(),
    contacts,
    messages,
    file: dbFile,
  };
}

function rowToAttachment(a) {
  return { id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height, size: a.size };
}

function getAttachment(id) {
  const r = db.prepare('SELECT name, mime, data FROM attachments WHERE id = ?').get(str(id, 200));
  return r ? { name: r.name, mime: r.mime, data: Buffer.from(r.data) } : null;
}

function getAvatar(ownerId) {
  const r = db.prepare('SELECT mime, data FROM avatars WHERE owner_id = ?').get(str(ownerId, 200));
  return r ? { mime: r.mime, data: Buffer.from(r.data) } : null;
}

function accountExists(id) {
  return !!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(str(id, 200));
}

function requireAccount(id) {
  if (!accountExists(id)) throw new Error('Unknown account');
  return str(id, 200);
}

// ---------- writing: accounts ----------

function createAccount(a) {
  const name = str(a.name, 200).trim();
  if (!name) throw new Error('Account name is required');
  const t = now();
  const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM accounts').get().p;
  db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(str(a.id, 200), name, str(a.linkedinUrl, 2000), pos, t, t);
  return true;
}

function updateAccount(a) {
  const name = str(a.name, 200).trim();
  if (!name) throw new Error('Account name is required');
  db.prepare('UPDATE accounts SET name = ?, linkedin_url = ?, updated_at = ? WHERE id = ?')
    .run(name, str(a.linkedinUrl, 2000), now(), requireAccount(a.id));
  return true;
}

/**
 * Remove an account. Its contacts (including recently deleted ones) move to `moveTo`;
 * with deleteContacts they are moved and then deleted (recoverable for 30 days / from backups).
 */
function deleteAccount(id, moveTo, deleteContacts = false) {
  return tx(() => {
    requireAccount(id);
    if (db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n < 2) throw new Error("The last account can't be deleted");
    if (moveTo === id) throw new Error('Choose a different account');
    requireAccount(moveTo);
    if (deleteContacts) {
      db.prepare('UPDATE contacts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL').run(now(), id);
    }
    db.prepare('UPDATE contacts SET account_id = ?, updated_at = ? WHERE account_id = ?').run(moveTo, now(), id);
    db.prepare('DELETE FROM avatars WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    const cur = getSettings().currentAccount;
    if (cur === id) setSetting('currentAccount', moveTo);
    return true;
  });
}

// ---------- writing: contacts ----------

function createContact(c) {
  const t = now();
  db.prepare(`
    INSERT INTO contacts (${CONTACT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(str(c.id, 200), requireAccount(c.accountId), str(c.name, 500), str(c.linkedinUrl, 2000),
    str(c.nationality, 200), str(c.headline, 1000), str(c.notes), str(c.createdAt) || t, t);
  return true;
}

function updateContact(c) {
  db.prepare(`
    UPDATE contacts SET account_id = ?, name = ?, linkedin_url = ?, nationality = ?, headline = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(requireAccount(c.accountId), str(c.name, 500), str(c.linkedinUrl, 2000), str(c.nationality, 200),
    str(c.headline, 1000), str(c.notes), now(), str(c.id, 200));
  return true;
}

function deleteContact(id) {
  db.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(now(), str(id, 200));
  return true;
}

function restoreContact(id) {
  db.prepare('UPDATE contacts SET deleted_at = NULL WHERE id = ?').run(str(id, 200));
  return true;
}

// ---------- writing: messages ----------

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function insertAttachment(messageId, a, position) {
  if (!IMAGE_MIMES.has(a.mime)) throw new Error('Unsupported image type');
  const buf = Buffer.from(a.bytes);
  if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) throw new Error('Image is too large (max 20 MB)');
  db.prepare(`
    INSERT INTO attachments (id, message_id, position, name, mime, width, height, size, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(str(a.id, 200), str(messageId, 200), position, str(a.name, 300), a.mime,
    Math.round(Number(a.width) || 0), Math.round(Number(a.height) || 0), buf.length, buf, now());
}

function attachmentList(messageId) {
  return db.prepare(`SELECT id, name, mime, width, height, size FROM attachments WHERE message_id = ? ORDER BY position`)
    .all(str(messageId, 200)).map(rowToAttachment);
}

/** attachments: [{ id, name, mime, width, height, bytes }]. Returns the stored attachment metadata. */
function createMessage(m, attachments = []) {
  if (m.direction !== 'in' && m.direction !== 'out') throw new Error('Invalid direction');
  return tx(() => {
    const t = now();
    db.prepare(`
      INSERT INTO messages (id, contact_id, direction, text, sent_at, seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(str(m.id, 200), str(m.contactId, 200), m.direction, str(m.text, 1000000), str(m.sentAt, 64),
      seenValue(m), str(m.createdAt, 64) || t, t);
    attachments.forEach((a, i) => insertAttachment(m.id, a, i));
    db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(t, str(m.contactId, 200));
    return attachmentList(m.id);
  });
}

/** changes: { add: [new attachments], remove: [attachment ids] }. Returns the stored attachment metadata. */
function updateMessage(m, changes = {}) {
  if (m.direction !== 'in' && m.direction !== 'out') throw new Error('Invalid direction');
  return tx(() => {
    db.prepare(`UPDATE messages SET direction = ?, text = ?, sent_at = ?, seen_at = ?, updated_at = ? WHERE id = ?`)
      .run(m.direction, str(m.text, 1000000), str(m.sentAt, 64), seenValue(m), now(), str(m.id, 200));
    for (const id of changes.remove || []) {
      db.prepare('DELETE FROM attachments WHERE id = ? AND message_id = ?').run(str(id, 200), str(m.id, 200));
    }
    let pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM attachments WHERE message_id = ?')
      .get(str(m.id, 200)).p;
    for (const a of changes.add || []) insertAttachment(m.id, a, pos++);
    return attachmentList(m.id);
  });
}

function deleteMessage(id) {
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(now(), str(id, 200));
  return true;
}

function restoreMessage(id) {
  db.prepare('UPDATE messages SET deleted_at = NULL WHERE id = ?').run(str(id, 200));
  return true;
}

/** Mark a sent message as seen at `seenAt` (ISO string), or not seen (null). */
function setMessageSeen(id, seenAt) {
  const value = seenValue({ direction: 'out', seenAt });
  db.prepare(`UPDATE messages SET seen_at = ?, updated_at = ? WHERE id = ? AND direction = 'out'`)
    .run(value, now(), str(id, 200));
  return value;
}

// ---------- writing: photos + settings ----------

const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Returns the new avatar version (a timestamp) used to bust the image cache. */
function setAvatar(ownerId, mime, bytes) {
  if (!AVATAR_MIMES.has(mime)) throw new Error('Unsupported image type');
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > MAX_AVATAR_BYTES) throw new Error('Image is too large');
  const t = now();
  db.prepare(`
    INSERT INTO avatars (owner_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at
  `).run(str(ownerId, 200), mime, buf, t);
  return t;
}

function removeAvatar(ownerId) {
  db.prepare('DELETE FROM avatars WHERE owner_id = ?').run(str(ownerId, 200));
  return true;
}

const SETTING_CHECKS = {
  timeZone: (v) => typeof v === 'string' && v.length <= 100,
  currentAccount: (v) => typeof v === 'string' && v.length <= 100,
};

function setSetting(key, value) {
  if (!Object.hasOwn(SETTING_CHECKS, key)) throw new Error('Unknown setting');
  if (!SETTING_CHECKS[key](value)) throw new Error('Invalid setting value');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
  return true;
}

// ---------- backups + import ----------

/** Consistent, compact copy of the whole database into a new file. */
function snapshotTo(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
}

const IMPORT_TABLES = ['accounts', 'contacts', 'messages', 'attachments', 'avatars'];

/**
 * The bytes of a database file (this app's, or HOTIT Manager's of any version) opened in memory and
 * brought to this app's table layout. Null when it has no LinkedIn tables. The file itself is
 * never touched.
 */
function openForImport(bytes) {
  const saved = { db, dbFile };
  const src = new DatabaseSync(':memory:');
  try {
    src.deserialize(bytes);
    if (src.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The file is damaged');
    const tables = new Set(src.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
    if (!tables.has('contacts') || !tables.has('messages')) {
      src.close();
      return null;
    }
    if (src.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) {
      // an older version: upgrade the in-memory copy with the same steps
      db = src;
      dbFile = null;
      db.exec('PRAGMA foreign_keys = ON');
      migrate();
      ensureAccount();
    }
    return src;
  } catch (err) {
    try { src.close(); } catch { /* ignore */ }
    throw err;
  } finally {
    ({ db, dbFile } = saved);
  }
}

const LIVE = {
  contacts: 'WHERE deleted_at IS NULL',
  messages: 'WHERE deleted_at IS NULL AND contact_id IN (SELECT id FROM contacts WHERE deleted_at IS NULL)',
  attachments: `WHERE message_id IN (SELECT m.id FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL)`,
  avatars: 'WHERE owner_id IN (SELECT id FROM accounts) OR owner_id IN (SELECT id FROM contacts WHERE deleted_at IS NULL)',
};

/** { contacts, messages, images } in a database file (deleted ones not counted); null if it has no LinkedIn tables. */
function describeDatabase(bytes) {
  const src = openForImport(bytes);
  if (!src) return null;
  try {
    const n = (table) => src.prepare(`SELECT COUNT(*) AS n FROM ${table} ${LIVE[table]}`).get().n;
    return { contacts: n('contacts'), messages: n('messages'), images: n('attachments') };
  } finally {
    src.close();
  }
}

/**
 * Copy accounts, contacts, messages, images and photos from a database file's bytes.
 * mode 'merge' adds what is not here yet (by id, so importing twice adds nothing);
 * 'replace' deletes the current data first. Deleted contacts and messages are left out.
 * Returns { contacts, messages, images } added.
 */
function importDatabase(bytes, mode = 'merge') {
  const src = openForImport(bytes);
  if (!src) throw new Error('This file has no LinkedIn contacts or messages.');
  try {
    return tx(() => {
      if (mode === 'replace') {
        db.exec('DELETE FROM attachments; DELETE FROM messages; DELETE FROM contacts; DELETE FROM avatars; DELETE FROM accounts;');
      } else if (!db.prepare('SELECT 1 FROM contacts LIMIT 1').get()) {
        // nothing here yet: the empty "Me" account made at the first start gives way to the imported ones
        db.exec(`DELETE FROM accounts WHERE name = 'Me' AND linkedin_url = '' AND id NOT IN (SELECT owner_id FROM avatars)`);
      }
      const added = {};
      let pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM accounts').get().p;
      for (const table of IMPORT_TABLES) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        const order = table === 'accounts' ? 'ORDER BY position, created_at' : '';
        added[table] = 0;
        for (const row of src.prepare(`SELECT ${cols.join(', ')} FROM ${table} ${LIVE[table] || ''} ${order}`).all()) {
          if (table === 'accounts') row.position = pos;
          if (insert.run(...cols.map((c) => row[c])).changes) {
            added[table]++;
            if (table === 'accounts') pos++;
          }
        }
      }
      // the app clock and the account being viewed: taken over only when not set here yet
      const here = getSettings();
      if (here.currentAccount && !accountExists(here.currentAccount)) here.currentAccount = ''; // (the "Me" just removed)
      for (const r of src.prepare(`SELECT key, value FROM settings WHERE key IN ('timeZone', 'currentAccount')`).all()) {
        if (here[r.key]) continue;
        try { setSetting(r.key, JSON.parse(r.value)); } catch { /* skip a bad value */ }
      }
      const current = getSettings().currentAccount;
      if (current && !accountExists(current)) setSetting('currentAccount', '');
      ensureAccount();
      return { contacts: added.contacts, messages: added.messages, images: added.attachments };
    });
  } finally {
    src.close();
  }
}

function counts() {
  return db.prepare(`
    SELECT (SELECT COUNT(*) FROM contacts WHERE deleted_at IS NULL) AS contacts,
           (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS messages
  `).get();
}

module.exports = {
  open, close, currentFile, isOpen,
  loadAll, counts, getAvatar, getAttachment,
  createAccount, updateAccount, deleteAccount,
  createContact, updateContact, deleteContact, restoreContact,
  createMessage, updateMessage, deleteMessage, restoreMessage, setMessageSeen,
  setAvatar, removeAvatar, setSetting,
  snapshotTo, describeDatabase, importDatabase,
};
