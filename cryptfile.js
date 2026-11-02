'use strict';

// Encrypted database files.
//
// The whole SQLite database is encrypted with AES-256-GCM using a random 256-bit data key. The data
// key itself is stored in the file's header, encrypted with a key derived from your password
// (scrypt), so changing the password only re-encrypts that small header. Without the password (or
// the copy of the data key this PC remembers, see main.js) the file is unreadable, and any change
// to it is detected when it is opened.
//
// File layout:  "ITBM-ENC" | header length (uint32 LE) | header JSON | IV (12) | tag (16) | ciphertext
// The header is authenticated together with the data, so it can't be swapped or altered either.

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('ITBM-ENC');
const KDF = { N: 2 ** 17, r: 8, p: 1 }; // ~0.6 s and 128 MB per password check: slow to guess
const MAX_HEADER = 64 * 1024;

class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.code = 'WRONG_PASSWORD';
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

function deriveKey(password, kdf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), unb64(kdf.salt), 32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), data };
}

function open(key, { iv, tag, data }, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

/** The data key, wrapped with a key derived from the password. */
async function wrapKey(id, dataKey, password) {
  const kdf = { alg: 'scrypt', ...KDF, salt: b64(crypto.randomBytes(16)) };
  const w = seal(await deriveKey(password, kdf), dataKey, Buffer.from(id));
  return { v: 1, id, kdf, key: { iv: b64(w.iv), tag: b64(w.tag), data: b64(w.data) } };
}

/** A new data key and the header that stores it under this password. */
async function create(password) {
  const id = crypto.randomBytes(16).toString('hex');
  const key = crypto.randomBytes(32);
  return { key, header: await wrapKey(id, key, password) };
}

/** Same data key, new password (old copies of the file still open with the old password). */
function rewrap(header, key, newPassword) {
  return wrapKey(header.id, key, newPassword);
}

/** The data key from the header, or WrongPasswordError. */
async function unlock(header, password) {
  const k = header.key;
  try {
    return open(await deriveKey(password, header.kdf), { iv: unb64(k.iv), tag: unb64(k.tag), data: unb64(k.data) }, Buffer.from(header.id));
  } catch {
    throw new WrongPasswordError();
  }
}

function isEncryptedBuffer(buf) {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function startsWith(file, magic) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(magic.length);
    return fs.readSync(fd, buf, 0, magic.length, 0) === magic.length && buf.equals(magic);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const isEncrypted = (file) => startsWith(file, MAGIC);
const isPlainSqlite = (file) => startsWith(file, Buffer.from('SQLite format 3\0'));

function parse(buf) {
  if (!isEncryptedBuffer(buf)) throw new Error('Not an encrypted database file');
  const len = buf.readUInt32LE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (len > MAX_HEADER || start + len + 28 > buf.length) throw new Error('The encrypted database file is damaged');
  const headerBytes = buf.subarray(start, start + len);
  const body = buf.subarray(start + len);
  return {
    header: JSON.parse(headerBytes.toString('utf8')),
    aad: buf.subarray(0, start + len),
    sealed: { iv: body.subarray(0, 12), tag: body.subarray(12, 28), data: body.subarray(28) },
  };
}

/** Just the header (to find the file's id / ask for its password) without decrypting anything. */
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 4);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!isEncryptedBuffer(head)) throw new Error('Not an encrypted database file');
    const len = head.readUInt32LE(MAGIC.length);
    if (len > MAX_HEADER) throw new Error('The encrypted database file is damaged');
    const bytes = Buffer.alloc(len);
    fs.readSync(fd, bytes, 0, len, head.length);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** The decrypted database bytes. Throws if the key is wrong or the file was changed or damaged. */
function decryptFile(file, key) {
  const { header, aad, sealed } = parse(fs.readFileSync(file));
  try {
    return { header, plain: open(key, sealed, aad) };
  } catch {
    throw new Error('This database file could not be decrypted: the key does not match, or the file is damaged.');
  }
}

function encryptBuffer(header, key, plain) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(headerBytes.length);
  const aad = Buffer.concat([MAGIC, len, headerBytes]);
  const s = seal(key, plain, aad);
  return Buffer.concat([aad, s.iv, s.tag, s.data]);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file so that it is either the old or the new version, never half written: the new
 * content goes to a temporary file that is flushed to disk and then renamed over the old one.
 * Sync tools and virus scanners can briefly hold the file, so the rename is retried for a moment.
 */
function writeFileAtomic(file, data) {
  const tmp = `${file}.saving`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      sleepSync(50);
    }
  }
}

function encryptTo(file, header, key, plain) {
  writeFileAtomic(file, encryptBuffer(header, key, plain));
}

// ---------- secrets inside an encrypted database ----------
//
// Passwords, 2-step keys etc. saved on assets are encrypted once more on their own, with a key
// derived from the database's data key. So they open wherever the database opens (any PC, with
// the password), and stay encrypted even in the decrypted copy of the database the app keeps in memory.
// Layout: "ITBM-SK1" | IV (12) | tag (16) | ciphertext. `aad` ties a value to its asset and name.

const SECRET_MAGIC = Buffer.from('ITBM-SK1');

function secretKey(dataKey) {
  return Buffer.from(crypto.hkdfSync('sha256', dataKey, Buffer.alloc(0), 'ITBM asset secrets v1', 32));
}

function isSealedSecret(blob) {
  const b = Buffer.from(blob);
  return b.length >= SECRET_MAGIC.length + 28 && b.subarray(0, SECRET_MAGIC.length).equals(SECRET_MAGIC);
}

/** Encrypt a secret with the database's data key. */
function sealSecret(dataKey, text, aad) {
  const s = seal(secretKey(dataKey), Buffer.from(String(text), 'utf8'), aad);
  return Buffer.concat([SECRET_MAGIC, s.iv, s.tag, s.data]);
}

/** Decrypt a value made by sealSecret(); throws if it was made with another database's key. */
function openSecret(dataKey, blob, aad) {
  const b = Buffer.from(blob);
  const at = SECRET_MAGIC.length;
  return open(secretKey(dataKey), { iv: b.subarray(at, at + 12), tag: b.subarray(at + 12, at + 28), data: b.subarray(at + 28) }, aad)
    .toString('utf8');
}

module.exports = {
  WrongPasswordError, create, rewrap, unlock, isEncrypted, isPlainSqlite, readHeader,
  decryptFile, encryptTo, writeFileAtomic, isSealedSecret, sealSecret, openSecret,
};
