'use strict';

// LinkedIn Tracker: contacts, conversations, the composer, accounts, dialogs, toasts, the app clock
// and Settings. Start-up and the menu live in app.js.

// ============================================================
// State
// ============================================================

const state = {
  db: { settings: {}, accounts: [], contacts: [], messages: [] },
  selectedId: null,
  query: '',
  field: 'all',
  filter: 'all',
  direction: 'out',
  drafts: {}, // contactId -> { text, items } unsent composer content
};

let composerTray = null; // ImageTray for the message composer, created in bindEvents()

// Country list comes from countries.js (COUNTRIES). Lookup by name, for search and suggestions.
const COUNTRY_BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));

/** Text to search for a stored country: its name plus nationality and other names ("Germany|German|Deutschland"). */
function countrySearchText(value) {
  const c = COUNTRY_BY_NAME.get(String(value || '').toLowerCase());
  return c ? [c.name, c.demonym, ...c.aliases].join('|') : String(value || '');
}

const AVATAR_COLORS = ['#1d5bd6', '#15803d', '#b45309', '#9a5b4c', '#6d4fc2', '#c2410c', '#0e7490', '#475569', '#a16207', '#9333ea'];

// ============================================================
// Helpers
// ============================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function uid() {
  return crypto.randomUUID();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape text and wrap occurrences of the current query in <mark>. */
function hl(text, active = true) {
  const q = state.query.trim();
  if (!q || !active) return esc(text);
  // split on the raw text so we never cut through an HTML entity
  return String(text ?? '')
    .split(new RegExp(`(${escRegex(q)})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');
}

function normalizeUrl(u) {
  let s = String(u || '').trim().toLowerCase();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  return s
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^[a-z]{2,3}\.linkedin\.com/, 'linkedin.com')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function fullUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** "https://www.linkedin.com/in/john-smith-4a2b91/" -> "John Smith" */
function nameFromUrl(u) {
  const m = String(u || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return '';
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* ignore */ }
  const parts = slug.split('-').filter(Boolean);
  while (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
  if (parts.some((p) => /\d/.test(p))) return '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function initials(name) {
  // first letter of the first and last word, ignoring brackets/punctuation: "James (Recruiting)" -> "JR"
  const words = String(name || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
  if (!words.length) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
}

function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarHtml(name, seed, size = '', src = null) {
  const inner = src ? `<img src="${esc(src)}" alt="" draggable="false">` : esc(initials(name));
  return `<div class="avatar ${size}" style="background:${avatarColor(seed)}">${inner}</div>`;
}

function avatarSrc(ownerId, version) {
  return version ? `avatar://img/${encodeURIComponent(ownerId)}?v=${encodeURIComponent(version)}` : null;
}

function contactAvatar(c, size = '') {
  return avatarHtml(c.name, c.id, size, avatarSrc(c.id, c.avatarVersion));
}

// ---------- your LinkedIn accounts ----------

function accountById(id) {
  return state.db.accounts.find((a) => a.id === id) || null;
}

function accountAvatar(acct, size = '') {
  if (!acct) return avatarHtml('Me', '__me__', size);
  return avatarHtml(acct.name, acct.id, size, avatarSrc(acct.id, acct.avatarVersion));
}

function multiAccount() {
  return state.db.accounts.length > 1;
}

/** The account being viewed, or null for "All accounts". With one account there is nothing to switch. */
function viewAccount() {
  if (!multiAccount()) return state.db.accounts[0] || null;
  return accountById(state.db.settings.currentAccount);
}

function visibleContacts() {
  const a = viewAccount();
  return a ? state.db.contacts.filter((c) => c.accountId === a.id) : state.db.contacts;
}

/** Account a new contact goes to: the one being viewed, else the last one used, else the first. */
function defaultAccountId() {
  return viewAccount()?.id || accountById(state.lastAccountId)?.id || state.db.accounts[0]?.id;
}

/** Square-crop an image (biased toward the top, where faces usually are) and encode as JPEG. */
async function imageToAvatar(blob) {
  if (!blob || !/^image\//.test(blob.type)) throw new Error('Please choose an image file.');
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error('That image could not be read.');
  }
  const SIZE = 320;
  const s = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - s) / 2;
  const sy = (bmp.height - s) * 0.3;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, s, s, 0, 0, SIZE, SIZE);
  bmp.close();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return { bytes: new Uint8Array(await out.arrayBuffer()), url: URL.createObjectURL(out) };
}

/**
 * Wires up the photo picker inside a dialog. Returns getPending():
 * undefined = unchanged, 'remove' = delete photo, { bytes } = new photo.
 */
function setupAvatarEditor({ seed, getName, currentSrc }) {
  let pending;
  let previewUrl = currentSrc;
  const box = $('#av-preview');
  const removeBtn = $('#av-remove');
  const draw = () => {
    box.innerHTML = avatarHtml(getName() || '?', seed, 'xl', previewUrl);
    removeBtn.classList.toggle('hidden', !previewUrl);
  };
  const use = async (blob) => {
    try {
      const a = await imageToAvatar(blob);
      pending = { bytes: a.bytes };
      previewUrl = a.url;
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  const onPaste = (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      use(file);
    }
  };

  $('#av-pick').addEventListener('click', () => $('#av-file').click());
  box.addEventListener('click', () => $('#av-file').click());
  $('#av-file').addEventListener('change', (e) => {
    if (e.target.files[0]) use(e.target.files[0]);
    e.target.value = '';
  });
  removeBtn.addEventListener('click', () => {
    pending = 'remove';
    previewUrl = null;
    draw();
  });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) use(file);
  });
  document.addEventListener('paste', onPaste);
  modalCleanup.push(() => document.removeEventListener('paste', onPaste));
  draw();

  return { getPending: () => pending, redraw: draw };
}

function avatarEditorHtml(label = 'Profile photo') {
  return `
    <div class="field avatar-edit">
      <div class="avatar-drop" id="av-preview" title="Click, drop or paste a photo"></div>
      <div class="avatar-edit-side">
        <label>${esc(label)}</label>
        <div class="avatar-edit-actions">
          <button type="button" class="btn secondary small" id="av-pick">Upload photo</button>
          <button type="button" class="btn ghost small hidden" id="av-remove">Remove</button>
        </div>
        <div class="help">Or drag an image here, or right-click a profile photo on LinkedIn → <em>Copy image</em>, then press <kbd>Ctrl</kbd> + <kbd>V</kbd>.</div>
      </div>
      <input type="file" id="av-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
    </div>`;
}

// ============================================================
// Image attachments
// ============================================================

const KEEP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function attachmentSrc(id) {
  return `attachment://file/${encodeURIComponent(id)}`;
}

/**
 * Read an image file for attaching. Normal screenshots/photos are kept byte-for-byte;
 * very large ones (or formats like BMP) are scaled to max 2560px and stored as JPEG.
 */
async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'That file'} is not an image.`);
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || 'That image'} could not be read.`);
  }
  let { width, height } = bmp;
  let blob = file;
  let mime = file.type;
  if (!KEEP_IMAGE_TYPES.includes(file.type) || file.size > 8 * 1024 * 1024 || Math.max(width, height) > 3000) {
    const scale = Math.min(1, 2560 / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    mime = 'image/jpeg';
  }
  bmp.close();
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
  const stamp = toLocalInput(new Date()).replace(/[-:T]/g, '');
  const name = generic ? `image-${stamp}.${IMAGE_EXT[mime]}` : file.name;
  return {
    id: uid(),
    name,
    mime,
    width,
    height,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    url: URL.createObjectURL(blob),
  };
}

function imageFilesFrom(list) {
  return [...(list || [])].filter((f) => f.type && f.type.startsWith('image/'));
}

/** Row of image thumbnails with remove buttons, used by the composer and the edit dialog. */
class ImageTray {
  constructor(el, { existing = [], showAdd = false, onAdd = null, onChange = null } = {}) {
    this.el = el;
    this.showAdd = showAdd;
    this.onChange = onChange;
    this.items = existing.map((a) => ({ id: a.id, url: attachmentSrc(a.id), existing: true, removed: false }));
    el.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) this.remove(rm.dataset.remove);
      else if (e.target.closest('.tray-add') && onAdd) onAdd();
    });
    this.render();
  }

  async addFiles(files) {
    const imgs = imageFilesFrom(files);
    for (const f of imgs) {
      try {
        const p = await prepareImage(f);
        this.items.push({ id: p.id, url: p.url, existing: false, data: p });
      } catch (err) {
        toast(err.message);
      }
    }
    this.changed();
    return imgs.length;
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.existing) {
      item.removed = !item.removed; // toggle, so a mistaken click can be undone
    } else {
      URL.revokeObjectURL(item.url);
      this.items = this.items.filter((i) => i !== item);
    }
    this.changed();
  }

  /** New images, ready to send to the database. */
  newAttachments() {
    return this.items.filter((i) => !i.existing).map(({ data: { url, ...rest } }) => rest);
  }

  removedIds() {
    return this.items.filter((i) => i.existing && i.removed).map((i) => i.id);
  }

  count() {
    return this.items.filter((i) => !i.removed).length;
  }

  /** Swap in another set of items (used for per-conversation drafts). */
  setItems(items) {
    this.items = items;
    this.changed();
  }

  clear() {
    for (const i of this.items) if (!i.existing) URL.revokeObjectURL(i.url);
    this.items = [];
    this.changed();
  }

  changed() {
    this.render();
    if (this.onChange) this.onChange();
  }

  render() {
    this.el.classList.toggle('hidden', !this.items.length && !this.showAdd);
    this.el.innerHTML = this.items.map((i) => `
      <div class="tray-item ${i.removed ? 'removed' : ''}">
        <img src="${esc(i.url)}" alt="">
        <button type="button" class="tray-remove" data-remove="${esc(i.id)}"
          title="${i.removed ? 'Keep this image' : 'Remove image'}">${i.removed ? '↺' : '×'}</button>
      </div>`).join('') + (this.showAdd ? '<button type="button" class="tray-add">+ Add image</button>' : '');
  }
}

function messageImagesHtml(m) {
  const atts = m.attachments || [];
  if (!atts.length) return '';
  const single = atts.length === 1;
  return `<div class="msg-images ${single ? 'single' : 'multi'}">${atts.map((a) => {
    // reserve the exact size up front so scrolling to the newest message stays accurate
    let size = '';
    if (single && a.width && a.height) {
      const scale = Math.min(1, 380 / a.width, 300 / a.height);
      size = `style="width:${Math.round(a.width * scale)}px;aspect-ratio:${a.width}/${a.height}"`;
    }
    return `<button type="button" class="msg-image" data-action="view-image" data-att="${esc(a.id)}" title="${esc(a.name)}">
        <img src="${attachmentSrc(a.id)}" alt="${esc(a.name)}" ${size} draggable="false">
      </button>`;
  }).join('')}</div>`;
}

/** One-line description of a message for the conversation list. */
function messagePreview(m) {
  const n = (m.attachments || []).length;
  const text = m.text.replace(/\s+/g, ' ').trim();
  if (!text) return n > 1 ? `📷 ${n} photos` : '📷 Photo';
  return (n ? '📷 ' : '') + text;
}

// ---------- full-size viewer ----------

const lightbox = { list: [], index: 0 };

function openLightbox(msg, attId) {
  lightbox.list = msg.attachments || [];
  lightbox.index = Math.max(0, lightbox.list.findIndex((a) => a.id === attId));
  $('#lightbox').classList.remove('hidden');
  showLightboxImage();
}

function showLightboxImage() {
  const a = lightbox.list[lightbox.index];
  if (!a) return closeLightbox();
  $('#lightboxImg').src = attachmentSrc(a.id);
  const n = lightbox.list.length;
  const kb = a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
  $('#lightboxInfo').textContent =
    `${a.name}${a.width ? ` · ${a.width}×${a.height}` : ''} · ${kb}${n > 1 ? ` · ${lightbox.index + 1} of ${n}` : ''}`;
  $('#lightboxPrev').classList.toggle('hidden', n < 2);
  $('#lightboxNext').classList.toggle('hidden', n < 2);
}

function moveLightbox(step) {
  const n = lightbox.list.length;
  if (n < 2) return;
  lightbox.index = (lightbox.index + step + n) % n;
  showLightboxImage();
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightboxImg').removeAttribute('src');
}

function lightboxOpen() {
  return !$('#lightbox').classList.contains('hidden');
}

/** Save a pending photo change. Returns the new version, null if removed, undefined if unchanged. */
async function applyAvatar(ownerId, pending) {
  if (pending === 'remove') {
    await dbCall('removeAvatar', ownerId);
    return null;
  }
  if (pending && pending.bytes) return dbCall('setAvatar', ownerId, 'image/jpeg', pending.bytes);
  return undefined;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ---------- app clock ----------
// Messages are stored as exact moments (UTC). How they are shown, and what "Now" means, follows the
// app's clock setting: the computer's time zone (''), an offset from the computer ('rel:-180' =
// 3 hours behind), or a named time zone such as 'America/New_York'.

const clock = { setting: '', zone: undefined, shiftMs: 0 };
let formatters = {};

function applyClock(setting) {
  setting = setting || '';
  clock.setting = '';
  clock.zone = undefined;
  clock.shiftMs = 0;
  if (setting.startsWith('rel:')) {
    const minutes = Number(setting.slice(4));
    if (Number.isFinite(minutes)) {
      clock.setting = setting;
      clock.shiftMs = minutes * 60000;
    }
  } else if (setting) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: setting });
      clock.setting = setting;
      clock.zone = setting;
    } catch {
      // unknown zone: fall back to computer time
    }
  }
  const make = (opts) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: clock.zone });
  formatters = {
    time: make({ hour: 'numeric', minute: '2-digit' }),
    weekday: make({ weekday: 'short' }),
    weekdayLong: make({ weekday: 'long' }),
    monthDay: make({ month: 'short', day: 'numeric' }),
    fullDate: make({ month: 'short', day: 'numeric', year: 'numeric' }),
    longDate: make({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    parts: make({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}
applyClock('');

/** The moment to hand to a formatter (moved by the offset when the clock is "N hours from computer"). */
function shifted(date) {
  return new Date(new Date(date).getTime() + clock.shiftMs);
}

const fmtTime = (d) => formatters.time.format(shifted(d));
const fmtWeekday = (d) => formatters.weekday.format(shifted(d));
const fmtWeekdayLong = (d) => formatters.weekdayLong.format(shifted(d));
const fmtMonthDay = (d) => formatters.monthDay.format(shifted(d));
const fmtFullDate = (d) => formatters.fullDate.format(shifted(d));
const fmtLongDate = (d) => formatters.longDate.format(shifted(d));

/** Year/month/day/hour/minute of a moment, as shown on the app clock. */
function wallParts(date) {
  const p = {};
  for (const { type, value } of formatters.parts.formatToParts(shifted(date))) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** Value for a datetime-local input, in app-clock time. */
function toLocalInput(date) {
  const w = wallParts(date);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** Inverse of toLocalInput: app-clock wall time -> Date. Returns an invalid Date for bad input. */
function fromLocalInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return new Date(NaN);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!clock.zone) return new Date(new Date(y, mo - 1, d, h, mi).getTime() - clock.shiftMs);
  // named zone: guess, measure how far the zone's wall clock is off, correct (twice for DST edges)
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = wallParts(t);
    t += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  }
  return new Date(t);
}

/** Whole calendar days from b to a, on the app clock. */
function dayDiff(a, b) {
  const wa = wallParts(a);
  const wb = wallParts(b);
  return Math.round((Date.UTC(wa.y, wa.m - 1, wa.d) - Date.UTC(wb.y, wb.m - 1, wb.d)) / 86400000);
}

function sameYear(a, b) {
  return wallParts(a).y === wallParts(b).y;
}

/** Minutes the app clock is ahead (+) or behind (-) the computer clock right now. */
function clockDifferenceMinutes(at = new Date()) {
  const w = wallParts(at);
  const appWall = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const pcWall = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
  return Math.round((appWall - pcWall) / 60000);
}

function describeMinutes(min) {
  if (!min) return 'same as computer';
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  const amount = `${h ? `${h} hour${h === 1 ? '' : 's'}` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`;
  return `${amount} ${min < 0 ? 'behind' : 'ahead of'} computer`;
}

/** Short tag shown next to "Date & time" when the app clock differs from the computer. */
function clockTag() {
  if (!clock.setting) return '';
  const diff = clockDifferenceMinutes();
  if (clock.zone) return `${clock.zone.split('/').pop().replace(/_/g, ' ')}${diff ? ` · ${describeMinutes(diff)}` : ''}`;
  return describeMinutes(diff);
}

/** Short date for the conversation list, like LinkedIn. */
function listDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = dayDiff(now, d);
  if (diff === 0) return fmtTime(d);
  if (diff > 0 && diff < 7) return fmtWeekday(d);
  if (sameYear(d, now)) return fmtMonthDay(d);
  return fmtFullDate(d);
}

/** Day separator label inside a conversation. */
function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = dayDiff(now, d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fmtWeekdayLong(d);
  if (sameYear(d, now)) return fmtMonthDay(d);
  return fmtFullDate(d);
}

/** "3:08 AM" today, "Mon 3:08 AM" this week, otherwise "Oct 12 3:08 AM". */
function seenLabel(iso) {
  const d = new Date(iso);
  const days = dayDiff(new Date(), d);
  if (days === 0) return fmtTime(d);
  return `${days > 0 && days < 7 ? fmtWeekday(d) : fmtMonthDay(d)} ${fmtTime(d)}`;
}

function ago(iso) {
  const days = dayDiff(new Date(), new Date(iso));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.floor(days / 7)} weeks`;
  return `${Math.floor(days / 30)} months`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ============================================================
// Data access
// ============================================================

function contactById(id) {
  return state.db.contacts.find((c) => c.id === id) || null;
}

function messagesFor(contactId) {
  return state.db.messages
    .filter((m) => m.contactId === contactId)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.createdAt.localeCompare(b.createdAt));
}

function buildIndex() {
  const byContact = new Map();
  for (const c of state.db.contacts) byContact.set(c.id, []);
  for (const m of state.db.messages) {
    if (byContact.has(m.contactId)) byContact.get(m.contactId).push(m);
  }
  for (const list of byContact.values()) {
    list.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.createdAt.localeCompare(b.createdAt));
  }
  return byContact;
}

function contactStatus(msgs) {
  if (!msgs.length) return 'empty';
  return msgs[msgs.length - 1].direction === 'out' ? 'awaiting' : 'replied';
}

function lastActivity(contact, msgs) {
  return msgs.length ? msgs[msgs.length - 1].sentAt : contact.createdAt;
}

/** Write to the database. On failure, reload from disk so the screen never shows unsaved data. */
async function dbCall(op, ...args) {
  try {
    return await window.api.db(op, ...args);
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(`Could not save: ${msg}`);
    state.db = await window.api.load();
    refreshAll();
    throw err;
  }
}

// ============================================================
// Search
// ============================================================

function searchContact(contact, msgs) {
  const q = state.query.trim().toLowerCase();
  if (!q) return { match: true, hits: [] };
  const f = state.field;
  let match = false;
  const hits = [];

  if ((f === 'all' || f === 'name') && contact.name.toLowerCase().includes(q)) match = true;
  if ((f === 'all' || f === 'nationality') && countrySearchText(contact.nationality).toLowerCase().includes(q)) match = true;
  if (f === 'url' || f === 'all') {
    const url = (contact.linkedinUrl || '').toLowerCase();
    const nq = normalizeUrl(q);
    if (url && (url.includes(q) || (nq && normalizeUrl(url).includes(nq)))) match = true;
  }
  if (f === 'all') {
    if ((contact.headline || '').toLowerCase().includes(q)) match = true;
    if ((contact.notes || '').toLowerCase().includes(q)) match = true;
  }
  if (f === 'all' || f === 'content') {
    for (const m of msgs) if (m.text.toLowerCase().includes(q)) hits.push(m);
    if (hits.length) match = true;
  }
  return { match, hits };
}

/** Snippet of a message centred on the first match. */
function snippet(text, q) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat;
  const start = Math.max(0, i - 30);
  return (start > 0 ? '…' : '') + flat.slice(start);
}

// ============================================================
// Rendering: contact list
// ============================================================

function renderList() {
  const index = buildIndex();
  const q = state.query.trim();

  const rows = visibleContacts()
    .map((c) => {
      const msgs = index.get(c.id) || [];
      return { c, msgs, status: contactStatus(msgs), last: lastActivity(c, msgs), ...searchContact(c, msgs) };
    })
    .filter((r) => r.match && matchesFilter(r))
    .sort((a, b) => b.last.localeCompare(a.last));

  const list = $('#contactList');
  if (!visibleContacts().length) {
    const where = viewAccount() && multiAccount() ? ` for ${esc(viewAccount().name)}` : '';
    list.innerHTML = `<li class="list-empty">No contacts${where} yet.<br>Press <kbd>Ctrl</kbd> + <kbd>N</kbd> to add your first one.</li>`;
  } else if (!rows.length) {
    list.innerHTML = `<li class="list-empty">No conversations match${q ? ` “${esc(q)}”` : ' this filter'}.</li>`;
  } else {
    list.innerHTML = rows.map((r) => contactRowHtml(r, q)).join('');
  }

  // stats
  const shown = visibleContacts();
  const shownMsgs = shown.map((c) => index.get(c.id) || []);
  const awaiting = shownMsgs.filter((m) => contactStatus(m) === 'awaiting').length;
  const msgCount = shownMsgs.reduce((n, m) => n + m.length, 0);
  $('#stats').textContent =
    `${plural(shown.length, 'contact')} · ${plural(msgCount, 'message')} · ${awaiting} awaiting reply`;
  renderAccountSwitch(index);

  return rows;
}

function matchesFilter(r) {
  if (state.filter === 'all') return true;
  // "Seen, no reply": your last message was marked as seen and they have not answered
  if (state.filter === 'seen') return r.status === 'awaiting' && !!r.msgs[r.msgs.length - 1].seenAt;
  return r.status === state.filter;
}

function contactRowHtml({ c, msgs, status, last, hits }, q) {
  const lastMsg = msgs[msgs.length - 1];
  let preview;
  if (q && hits.length) {
    const h = hits[hits.length - 1];
    preview = `${h.direction === 'out' ? 'You' : esc(firstName(c.name))}: ${hl(snippet(h.text, q))}`;
  } else if (lastMsg) {
    preview = `${lastMsg.direction === 'out' ? 'You' : esc(firstName(c.name))}: ${esc(messagePreview(lastMsg))}`;
  } else {
    preview = '<em>No messages yet</em>';
  }

  const sub = [c.headline, c.nationality].filter(Boolean);
  const badges = [];
  if (multiAccount() && !viewAccount()) {
    const acct = accountById(c.accountId);
    if (acct) badges.push(`<span class="acct-chip" title="Your account: ${esc(acct.name)}">${accountAvatar(acct, 'xs')}<span class="acct-chip-name">${esc(acct.name)}</span></span>`);
  }
  if (status === 'awaiting') {
    badges.push(lastMsg.seenAt
      ? `<span class="badge seen" title="Seen ${esc(seenLabel(lastMsg.seenAt))}">Seen, no reply · ${ago(lastMsg.sentAt)}</span>`
      : `<span class="badge awaiting">Awaiting reply · ${ago(lastMsg.sentAt)}</span>`);
  }
  if (status === 'replied') badges.push(`<span class="badge replied">Replied</span>`);
  if (q && hits.length) badges.push(`<span class="badge hits">${plural(hits.length, 'matching message')}</span>`);

  return `
    <li class="contact ${c.id === state.selectedId ? 'active' : ''}" data-id="${esc(c.id)}" tabindex="0">
      ${contactAvatar(c)}
      <div class="contact-body">
        <div class="contact-top">
          <span class="contact-name">${hl(c.name)}</span>
          <span class="contact-date">${esc(listDate(last))}</span>
        </div>
        ${sub.length ? `<div class="contact-sub">${sub.map((s) => hl(s)).join(' · ')}</div>` : ''}
        <div class="contact-preview">${preview}</div>
        ${badges.length ? `<div class="contact-meta">${badges.join('')}</div>` : ''}
      </div>
    </li>`;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || name;
}

// ============================================================
// Rendering: conversation
// ============================================================

function renderThread({ scroll = 'bottom' } = {}) {
  const contact = contactById(state.selectedId);
  $('#threadEmpty').classList.toggle('hidden', !!contact);
  $('#threadMain').classList.toggle('hidden', !contact);

  if (!contact) {
    const has = visibleContacts().length > 0;
    $('#emptyTitle').textContent = has ? 'Select a conversation' : 'Keep track of your LinkedIn conversations';
    $('#emptyText').textContent = has
      ? 'Pick someone from the list on the left, or add a new contact.'
      : "Add a contact, then paste in each message you send and each reply you receive. Next time they write back, you'll know exactly what was said.";
    return;
  }

  const msgs = messagesFor(contact.id);
  const acct = accountById(contact.accountId);
  const myName = acct?.name || 'Me';
  const url = contact.linkedinUrl ? fullUrl(contact.linkedinUrl) : '';

  // header
  $('#threadHeader').innerHTML = `
    ${contactAvatar(contact, 'sm')}
    <div class="thread-title">
      <div class="name">${esc(contact.name)}</div>
      <div class="sub">${esc([contact.headline, contact.nationality].filter(Boolean).join(' · ') || 'LinkedIn contact')}${
        multiAccount() && acct ? ` · <span class="via">via ${accountAvatar(acct, 'xs')} ${esc(acct.name)}</span>` : ''}</div>
    </div>
    <div class="thread-actions">
      ${url ? `<button class="btn ghost small" data-action="open-profile" title="Open LinkedIn profile in your browser">View profile</button>` : ''}
      <button class="icon-btn" data-action="edit-contact" title="Edit contact">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M21.13 2.86a3 3 0 0 0-4.17 0l-13 13L2 22l6.19-2L21.13 7a2.93 2.93 0 0 0 0-4.16ZM6.77 18.57l-1.35-1.34L16.64 6 18 7.35Z"/></svg>
      </button>
      <button class="icon-btn" data-action="delete-contact" title="Delete contact and all messages">
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 4v1H4V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1h4a1 1 0 0 1 1 1ZM5 6h14v13a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Zm9 13h1V9h-1Zm-5 0h1V9H9Z"/></svg>
      </button>
    </div>`;

  // profile card + messages
  const parts = [];
  parts.push(`
    <div class="profile-card">
      <button type="button" class="avatar-btn" data-action="change-photo" title="${contact.avatarVersion ? 'Change photo' : 'Add a photo'}">
        ${contactAvatar(contact, 'lg')}
        <span class="avatar-btn-overlay">${contact.avatarVersion ? 'Change' : 'Add photo'}</span>
      </button>
      <div class="info">
        <div class="name">${hl(contact.name)}</div>
        ${contact.headline ? `<div class="headline">${hl(contact.headline)}</div>` : ''}
        <div class="row">
          ${contact.nationality ? `<span class="pill">${hl(contact.nationality)}</span>` : ''}
          ${url ? `<a class="url-link" data-action="open-profile" title="Open in browser">${hl(contact.linkedinUrl)}</a>` : '<span>No LinkedIn URL saved</span>'}
        </div>
        <div class="row">Added ${esc(fmtFullDate(new Date(contact.createdAt)))} · ${plural(msgs.length, 'message')}</div>
        ${contact.notes ? `<div class="notes">${hl(contact.notes)}</div>` : ''}
      </div>
    </div>`);

  if (!msgs.length) {
    parts.push(`<div class="thread-note">No messages yet.<br>Use the box below to log the first message you sent to ${esc(firstName(contact.name))}.</div>`);
  } else {
    const last = msgs[msgs.length - 1];
    if (last.direction === 'out') {
      const seen = last.seenAt
        ? ` ${esc(firstName(contact.name))} saw it ${esc(seenLabel(last.seenAt))}.`
        : ' Not seen yet.';
      parts.push(`<div class="waiting-banner">⏳ Waiting for a reply — your last message was sent ${esc(ago(last.sentAt) === 'today' ? 'today' : `${ago(last.sentAt)} ago`)} (${esc(fmtLongDate(new Date(last.sentAt)))}).${seen}</div>`);
    }
  }

  const q = state.query.trim().toLowerCase();
  const highlightContent = state.field === 'all' || state.field === 'content';
  // LinkedIn-style "seen": their small photo under the latest sent message they have seen
  const outs = msgs.filter((m) => m.direction === 'out');
  const lastOut = outs[outs.length - 1];
  const seenMarker = [...outs].reverse().find((m) => m.seenAt);
  let prev = null;
  for (const m of msgs) {
    const d = new Date(m.sentAt);
    const newDay = !prev || dayDiff(d, new Date(prev.sentAt)) !== 0;
    if (newDay) parts.push(`<div class="day-sep">${esc(dayLabel(m.sentAt))}</div>`);
    const cont = !newDay && prev.direction === m.direction && d - new Date(prev.sentAt) < 10 * 60 * 1000;
    const who = m.direction === 'out' ? myName : contact.name;
    const isHit = q && highlightContent && m.text.toLowerCase().includes(q);
    parts.push(`
      <div class="msg ${m.direction} ${cont ? 'cont' : ''} ${isHit ? 'hit' : ''}" data-id="${esc(m.id)}">
        <div class="avatar-slot">${cont ? '' : m.direction === 'out' ? accountAvatar(acct, 'sm') : contactAvatar(contact, 'sm')}</div>
        <div class="msg-body">
          ${cont ? '' : `
          <div class="msg-head">
            <span class="who">${esc(who)}</span>
            <span class="time">${esc(fmtTime(d))}</span>
            <span class="tag ${m.direction}">${m.direction === 'out' ? 'Sent' : 'Received'}</span>
          </div>`}
          ${m.text ? `<div class="msg-text" title="${esc(fmtLongDate(d) + ' ' + fmtTime(d))}">${hl(m.text, highlightContent)}</div>` : ''}
          ${messageImagesHtml(m)}
        </div>
        <div class="msg-actions">
          ${m.text ? '<button type="button" data-action="copy-msg">Copy</button>' : ''}
          ${m.direction === 'out' ? `<button type="button" data-action="toggle-seen">${m.seenAt ? 'Unmark seen' : 'Mark seen'}</button>` : ''}
          <button type="button" data-action="edit-msg">Edit</button>
          <button type="button" class="danger" data-action="delete-msg">Delete</button>
        </div>
      </div>`);
    if (m === seenMarker) {
      parts.push(`
        <div class="seen-row" title="Seen by ${esc(contact.name)} · ${esc(fmtLongDate(m.seenAt) + ' ' + fmtTime(m.seenAt))}">
          Seen ${esc(seenLabel(m.seenAt))} ${contactAvatar(contact, 'xs')}
        </div>`);
    }
    if (m === lastOut && !m.seenAt && m === msgs[msgs.length - 1]) {
      parts.push(`
        <div class="seen-row unseen">
          Not seen yet ·
          <button type="button" class="link-btn" data-action="toggle-seen" data-msg="${esc(m.id)}">Mark as seen</button>
        </div>`);
    }
    prev = m;
  }

  const box = $('#messages');
  const keptScroll = box.scrollTop;
  box.innerHTML = parts.join('');
  if (scroll === 'keep') box.scrollTop = keptScroll;

  const firstHit = $('.msg.hit', box);
  if (scroll === 'hit' && firstHit) {
    firstHit.scrollIntoView({ block: 'center' });
    firstHit.classList.add('flash');
  } else if (scroll === 'bottom') {
    box.scrollTop = box.scrollHeight;
  }
}

function renderComposer() {
  const contact = contactById(state.selectedId);
  if (!contact) return;
  const out = state.direction === 'out';
  $$('#directionToggle button').forEach((b) => b.classList.toggle('active', b.dataset.dir === state.direction));
  $('#composer').classList.toggle('dir-in', !out);
  $('#composerText').placeholder = out
    ? `Paste or write the message you sent to ${firstName(contact.name)}…`
    : `Paste ${firstName(contact.name)}'s reply…`;
  $('#btnAdd').textContent = out ? 'Add sent message' : 'Add reply';
  updateAddButton();
  renderClockTag();
  // with several accounts, show which one this conversation belongs to
  const acct = accountById(contact.accountId);
  $('#asAccount').classList.toggle('hidden', !(multiAccount() && acct));
  if (acct) $('#asAccount').innerHTML = `as ${accountAvatar(acct, 'xs')} <strong>${esc(acct.name)}</strong>`;
}

function renderClockTag() {
  const tag = clockTag();
  $('#clockTag').textContent = tag;
  $('#clockTag').classList.toggle('hidden', !tag);
}

// ---------- message box height ----------

const COMPOSER_DEFAULT_HEIGHT = 84;
const COMPOSER_MIN_HEIGHT = 64;
let composerHeight = COMPOSER_DEFAULT_HEIGHT; // the size you chose with the drag handle
try {
  const saved = Number(localStorage.getItem('composerHeight'));
  if (saved >= COMPOSER_MIN_HEIGHT) composerHeight = saved;
} catch { /* storage unavailable: use the default */ }

/** Largest the box may get: 60% of the conversation pane, so messages stay visible. */
function composerMaxHeight() {
  const pane = $('#threadMain').clientHeight || window.innerHeight;
  return Math.max(COMPOSER_MIN_HEIGHT, Math.round(pane * 0.6));
}

function setComposerHeight(px) {
  const h = Math.round(Math.min(composerMaxHeight(), Math.max(COMPOSER_MIN_HEIGHT, px)));
  $('#composerText').style.height = `${h}px`;
  return h;
}

/** Your chosen size, grown to fit a long message (e.g. a pasted one) up to the maximum. */
function fitComposer() {
  const t = $('#composerText');
  setComposerHeight(composerHeight);
  if (t.scrollHeight > t.clientHeight) setComposerHeight(t.scrollHeight + 2); // + borders
}

function updateAddButton() {
  $('#btnAdd').disabled = !$('#composerText').value.trim() && !composerTray.count();
}

function renderAll(opts) {
  renderList();
  renderThread(opts);
  renderComposer();
  refreshNationalities();
}

function refreshNationalities() {
  // every country, plus any custom values already used; the label lets "German" or "USA" find the country
  const used = state.db.contacts.map((c) => c.nationality).filter(Boolean);
  const all = [...new Set([...COUNTRIES.map((c) => c.name), ...used])].sort((a, b) => a.localeCompare(b));
  $('#nationalityList').innerHTML = all.map((name) => {
    const c = COUNTRY_BY_NAME.get(name.toLowerCase());
    const label = c ? [c.demonym, ...c.aliases].filter((x) => x && x !== name).join(', ') : '';
    return label ? `<option value="${esc(name)}" label="${esc(label)}">` : `<option value="${esc(name)}">`;
  }).join('');
}

// ============================================================
// Actions
// ============================================================

function selectContact(id, { scroll } = {}) {
  // save draft (text + images) of the conversation we are leaving
  if (state.selectedId) {
    state.drafts[state.selectedId] = { text: $('#composerText').value, items: composerTray.items };
  }
  state.selectedId = id;
  const draft = state.drafts[id] || { text: '', items: [] };
  $('#composerText').value = draft.text;
  composerTray.setItems(draft.items);
  $('#composerDate').value = toLocalInput(new Date());
  requestAnimationFrame(fitComposer); // after the conversation pane is visible

  // sensible default: if they're awaiting a reply, the next thing to log is probably their reply
  const msgs = messagesFor(id);
  state.direction = msgs.length && msgs[msgs.length - 1].direction === 'out' ? 'in' : 'out';

  renderList();
  renderThread({ scroll: scroll || (state.query.trim() ? 'hit' : 'bottom') });
  renderComposer();
  $(`.contact[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function addMessage() {
  const contact = contactById(state.selectedId);
  const text = $('#composerText').value.replace(/\s+$/, '');
  if (!contact || (!text.trim() && !composerTray.count())) return;
  const when = $('#composerDate').value ? fromLocalInput($('#composerDate').value) : new Date();
  if (Number.isNaN(when.getTime())) {
    toast('Please enter a valid date and time.');
    return;
  }
  const now = new Date().toISOString();
  const msg = {
    id: uid(),
    contactId: contact.id,
    direction: state.direction,
    text: text.trim() ? text : '',
    sentAt: when.toISOString(),
    createdAt: now,
  };
  $('#btnAdd').disabled = true;
  try {
    msg.attachments = await dbCall('createMessage', msg, composerTray.newAttachments());
  } catch {
    updateAddButton();
    return; // text and images stay in the composer so nothing is lost
  }
  state.db.messages.push(msg);
  contact.updatedAt = now;

  $('#composerText').value = '';
  composerTray.clear();
  delete state.drafts[contact.id];
  fitComposer();
  $('#composerDate').value = toLocalInput(new Date());
  renderList();
  renderThread({ scroll: 'bottom' });
  renderComposer();
  toast(state.direction === 'out' ? 'Sent message saved' : 'Reply saved');
  $('#composerText').focus();
}

function contactForm(c = {}, accountId = '') {
  const accounts = state.db.accounts;
  const accountField = accounts.length > 1 ? `
    <div class="field">
      <label for="f-account">Your account (which of your LinkedIn profiles talks to them)</label>
      <select id="f-account">${accounts.map((a) =>
        `<option value="${esc(a.id)}" ${a.id === accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
    </div>` : `<input type="hidden" id="f-account" value="${esc(accountId)}">`;
  return `
    ${avatarEditorHtml()}
    ${accountField}
    <div class="field">
      <label for="f-url">LinkedIn profile URL</label>
      <input id="f-url" name="linkedinUrl" value="${esc(c.linkedinUrl)}" placeholder="https://www.linkedin.com/in/…" spellcheck="false">
      <div class="help">Paste the profile link — the name is filled in automatically when possible.</div>
      <div class="error hidden" id="f-url-err"></div>
    </div>
    <div class="field">
      <label for="f-name">Full name <span class="req">*</span></label>
      <input id="f-name" name="name" value="${esc(c.name)}" required>
      <div class="error hidden" id="f-name-err">Please enter a name.</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="f-nat">Country</label>
        <input id="f-nat" name="nationality" value="${esc(c.nationality)}" list="nationalityList"
          placeholder="Start typing a country" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-head">Headline / company</label>
        <input id="f-head" name="headline" value="${esc(c.headline)}" placeholder="e.g. CTO at Acme">
      </div>
    </div>
    <div class="field">
      <label for="f-notes">Notes</label>
      <textarea id="f-notes" name="notes" rows="3" placeholder="Anything to remember about this person…">${esc(c.notes)}</textarea>
    </div>`;
}

function openContactModal(existing = null) {
  let avatarEditor = null;
  const newId = existing ? existing.id : uid();
  openModal({
    title: existing ? 'Edit contact' : 'New contact',
    body: contactForm(existing || {}, existing ? existing.accountId : defaultAccountId()),
    okText: existing ? 'Save' : 'Add contact',
    onOpen() {
      const urlInput = $('#f-url');
      const nameInput = $('#f-name');
      avatarEditor = setupAvatarEditor({
        seed: newId,
        getName: () => nameInput.value.trim(),
        currentSrc: existing ? avatarSrc(existing.id, existing.avatarVersion) : null,
      });
      let autoName = !existing || !existing.name;
      nameInput.addEventListener('input', () => {
        autoName = !nameInput.value.trim();
        avatarEditor.redraw();
      });
      urlInput.addEventListener('input', () => {
        $('#f-url-err').classList.add('hidden');
        if (autoName) nameInput.value = nameFromUrl(urlInput.value);
        avatarEditor.redraw();
      });
      (existing ? nameInput : urlInput).focus();
    },
    async onOk() {
      const data = {
        accountId: $('#f-account').value,
        name: $('#f-name').value.trim(),
        linkedinUrl: $('#f-url').value.trim(),
        // typing "German", "USA" or "holland" without picking a suggestion still saves the country name
        nationality: countryFromLegacyValue($('#f-nat').value.trim()),
        headline: $('#f-head').value.trim(),
        notes: $('#f-notes').value.trim(),
      };
      $('#f-name-err').classList.toggle('hidden', !!data.name);
      if (!data.name) { $('#f-name').focus(); return false; }

      if (data.linkedinUrl) {
        const n = normalizeUrl(data.linkedinUrl);
        const dup = state.db.contacts.find((c) => c.id !== existing?.id && c.accountId === data.accountId &&
          c.linkedinUrl && normalizeUrl(c.linkedinUrl) === n);
        if (dup) {
          const err = $('#f-url-err');
          const inAcct = multiAccount() ? ` in ${esc(accountById(dup.accountId)?.name || 'this account')}` : '';
          err.innerHTML = `This profile is already saved${inAcct} as <a href="#" class="url-link" id="goDup">${esc(dup.name)}</a>.`;
          err.classList.remove('hidden');
          $('#goDup').addEventListener('click', (e) => {
            e.preventDefault();
            closeModal();
            showContact(dup.id);
          });
          return false;
        }
      }

      const now = new Date().toISOString();
      const pendingAvatar = avatarEditor.getPending();
      if (existing) {
        try {
          await dbCall('updateContact', { ...existing, ...data });
          const v = await applyAvatar(existing.id, pendingAvatar);
          Object.assign(existing, data, { updatedAt: now });
          if (v !== undefined) existing.avatarVersion = v;
        } catch {
          return false;
        }
        state.lastAccountId = existing.accountId;
        if (viewAccount() && viewAccount().id !== existing.accountId) {
          showContact(existing.id); // moved to another account: follow it
        } else {
          renderAll({ scroll: 'keep' });
        }
        toast('Contact updated');
      } else {
        const c = { id: newId, ...data, createdAt: now, updatedAt: now, avatarVersion: null };
        try {
          await dbCall('createContact', c);
          state.db.contacts.push(c);
          const v = await applyAvatar(c.id, pendingAvatar);
          if (v !== undefined) c.avatarVersion = v;
        } catch {
          return false;
        }
        state.lastAccountId = c.accountId;
        state.query = '';
        $('#search').value = '';
        state.filter = 'all';
        syncFilterChips();
        showContact(c.id);
        refreshNationalities();
        state.direction = 'out';
        renderComposer();
        $('#composerText').focus();
        toast('Contact added — now log your first message');
      }
      return true;
    },
  });
}

function deleteContact(contact) {
  const count = state.db.messages.filter((m) => m.contactId === contact.id).length;
  openModal({
    title: 'Delete contact?',
    body: `<p>This removes <strong>${esc(contact.name)}</strong> and ${plural(count, 'logged message')}.</p>`,
    okText: 'Delete',
    danger: true,
    async onOk() {
      try {
        await dbCall('deleteContact', contact.id);
      } catch {
        return true;
      }
      const removedMsgs = state.db.messages.filter((m) => m.contactId === contact.id);
      state.db.contacts = state.db.contacts.filter((c) => c.id !== contact.id);
      state.db.messages = state.db.messages.filter((m) => m.contactId !== contact.id);
      state.selectedId = null;
      renderAll();
      toast(`Deleted ${contact.name}`, {
        label: 'Undo',
        async fn() {
          await dbCall('restoreContact', contact.id);
          state.db.contacts.push(contact);
          state.db.messages.push(...removedMsgs);
          selectContact(contact.id);
        },
      });
      return true;
    },
  });
}

function editMessage(msg, { focusSeen = false } = {}) {
  const contact = contactById(msg.contactId);
  let tray = null;
  openModal({
    title: 'Edit message',
    body: `
      <div class="field-row">
        <div class="field">
          <label for="m-dir">From</label>
          <select id="m-dir">
            <option value="out" ${msg.direction === 'out' ? 'selected' : ''}>Me (sent)</option>
            <option value="in" ${msg.direction === 'in' ? 'selected' : ''}>${esc(contact?.name || 'Them')} (received)</option>
          </select>
        </div>
        <div class="field">
          <label for="m-date">Date &amp; time</label>
          <input id="m-date" type="datetime-local" value="${toLocalInput(msg.sentAt)}">
        </div>
      </div>
      <div class="field seen-field ${msg.direction === 'out' ? '' : 'hidden'}" id="m-seen-field">
        <label class="check"><input type="checkbox" id="m-seen" ${msg.seenAt ? 'checked' : ''}>
          Seen by ${esc(contact ? firstName(contact.name) : 'them')}</label>
        <input id="m-seen-date" type="datetime-local" value="${toLocalInput(msg.seenAt || new Date())}" ${msg.seenAt ? '' : 'disabled'}>
        <div class="error hidden" id="m-seen-err">The seen time can’t be before the message was sent.</div>
      </div>
      <div class="field">
        <label for="m-text">Message</label>
        <textarea id="m-text" rows="8">${esc(msg.text)}</textarea>
      </div>
      <div class="field">
        <label>Images</label>
        <div class="tray" id="m-tray"></div>
        <input type="file" id="m-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden>
        <div class="help">You can also paste (<kbd>Ctrl</kbd> + <kbd>V</kbd>) or drop images into this window.</div>
        <div class="error hidden" id="m-err">A message needs text or at least one image.</div>
      </div>`,
    okText: 'Save',
    onOpen() {
      tray = new ImageTray($('#m-tray'), {
        existing: msg.attachments || [],
        showAdd: true,
        onAdd: () => $('#m-file').click(),
      });
      $('#m-file').addEventListener('change', (e) => {
        tray.addFiles(e.target.files);
        e.target.value = '';
      });
      const onPaste = (e) => {
        const files = imageFilesFrom(e.clipboardData?.files);
        if (!files.length) return;
        if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
        tray.addFiles(files);
      };
      const onDrop = (e) => {
        e.preventDefault();
        tray.addFiles(e.dataTransfer.files);
      };
      const dialogEl = $('#modal');
      document.addEventListener('paste', onPaste);
      dialogEl.addEventListener('drop', onDrop);
      modalCleanup.push(() => {
        document.removeEventListener('paste', onPaste);
        dialogEl.removeEventListener('drop', onDrop);
      });
      $('#m-seen').addEventListener('change', (e) => { $('#m-seen-date').disabled = !e.target.checked; });
      $('#m-dir').addEventListener('change', (e) => {
        $('#m-seen-field').classList.toggle('hidden', e.target.value !== 'out');
      });
      if (focusSeen) $('#m-seen-date').focus();
      else $('#m-text').focus();
    },
    async onOk() {
      const text = $('#m-text').value.replace(/\s+$/, '');
      const when = fromLocalInput($('#m-date').value);
      const hasContent = text.trim() || tray.count();
      $('#m-err').classList.toggle('hidden', !!hasContent);
      if (!hasContent) { $('#m-text').focus(); return false; }
      if (Number.isNaN(when.getTime())) { $('#m-date').focus(); return false; }
      const direction = $('#m-dir').value;
      let seenAt = null;
      if (direction === 'out' && $('#m-seen').checked) {
        const seen = fromLocalInput($('#m-seen-date').value);
        const tooEarly = seen.getTime() < when.getTime();
        $('#m-seen-err').classList.toggle('hidden', !tooEarly);
        if (Number.isNaN(seen.getTime()) || tooEarly) { $('#m-seen-date').focus(); return false; }
        seenAt = seen.toISOString();
      }
      const changes = { text: text.trim() ? text : '', direction, sentAt: when.toISOString(), seenAt };
      try {
        changes.attachments = await dbCall('updateMessage', { ...msg, ...changes },
          { add: tray.newAttachments(), remove: tray.removedIds() });
      } catch {
        return false;
      }
      tray.clear();
      Object.assign(msg, changes);
      renderList();
      renderThread({ scroll: 'keep' });
      toast('Message updated');
      return true;
    },
  });
}

async function toggleSeen(msg) {
  // marking now, but never earlier than the message itself
  const seenAt = msg.seenAt ? null : new Date(Math.max(Date.now(), new Date(msg.sentAt).getTime())).toISOString();
  try {
    msg.seenAt = await dbCall('setMessageSeen', msg.id, seenAt);
  } catch {
    return;
  }
  renderList();
  renderThread({ scroll: 'keep' });
  if (msg.seenAt) {
    toast(`Marked as seen ${seenLabel(msg.seenAt)}`, { label: 'Change time', fn: () => editMessage(msg, { focusSeen: true }) });
  } else {
    toast('Marked as not seen');
  }
}

async function deleteMessage(msg) {
  try {
    await dbCall('deleteMessage', msg.id);
  } catch {
    return;
  }
  state.db.messages = state.db.messages.filter((m) => m.id !== msg.id);
  renderList();
  renderThread({ scroll: 'keep' });
  toast('Message deleted', {
    label: 'Undo',
    async fn() {
      await dbCall('restoreMessage', msg.id);
      state.db.messages.push(msg);
      renderList();
      renderThread({ scroll: 'keep' });
    },
  });
}

function openSettings({ focusClock = false } = {}) {
  let startup = null; // { supported, enabled, minimized } from the main process
  let readAppearance = null;
  const s = state.db.settings;
  openModal({
    title: 'Settings',
    body: `
      ${appearanceFieldHtml()}
      <div class="field">
        <label>Your LinkedIn accounts</label>
        <div class="settings-accounts">
          ${state.db.accounts.map((a) => `<span class="acct-chip big">${accountAvatar(a, 'xs')}${esc(a.name)}</span>`).join('')}
        </div>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-accounts">Manage accounts…</button>
        </div>
        <div class="help">Each account has its own name and photo, shown on the messages it sent.</div>
      </div>
      <div class="field">
        <label for="s-clock">App clock (used by “Now”, “today” and message times)</label>
        <select id="s-clock">${clockOptionsHtml(clock.setting)}</select>
        <div class="clock-preview" id="s-clock-preview"></div>
      </div>
      <div class="field startup-field">
        <label>Windows startup</label>
        <label class="check"><input type="checkbox" id="s-startup" disabled> Run automatically when Windows starts</label>
        <label class="check sub"><input type="checkbox" id="s-startup-min" disabled> Start minimized to the taskbar</label>
        <div class="help" id="s-startup-help"></div>
      </div>
      <div class="field">
        <label>Database</label>
        <div class="db-path" title="${esc(state.db.file || '')}">${esc(state.db.file || '')}</div>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-move">Change location…</button>
          <button type="button" class="btn ghost small" id="s-folder">Show in folder</button>
        </div>
        <div class="help">Every change is saved to this database file immediately. To keep it safe even if this PC breaks,
          move it into a folder that syncs to the cloud (OneDrive, Dropbox, Google Drive).</div>
      </div>
      <div class="field">
        <label>Backups</label>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-export">Export backup…</button>
          <button type="button" class="btn secondary small" id="s-import">Import backup…</button>
          <button type="button" class="btn ghost small" id="s-backups">Open backups folder</button>
        </div>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-hotit">Import from HOTIT Manager…</button>
        </div>
        <div class="help">A copy is made automatically every day (last 30 kept) and every month (kept forever).
          Deleted contacts and messages can be recovered from these copies.
          Import backup also takes a HOTIT Manager database or backup.</div>
      </div>`,
    okText: 'Save',
    onOpen() {
      $('#s-accounts').addEventListener('click', () => { closeModal(); openAccountsManager(); });
      readAppearance = setupAppearanceField();
      const preview = () => { $('#s-clock-preview').innerHTML = clockPreviewHtml($('#s-clock').value); };
      $('#s-clock').addEventListener('change', preview);
      preview();
      const timer = setInterval(preview, 15000);
      modalCleanup.push(() => clearInterval(timer));
      window.api.getStartup().then((st) => {
        startup = st;
        const on = $('#s-startup');
        const min = $('#s-startup-min');
        if (!on) return; // dialog already closed
        on.checked = st.enabled;
        min.checked = st.minimized;
        on.disabled = !st.supported;
        min.disabled = !st.supported || !st.enabled;
        on.addEventListener('change', () => { min.disabled = !on.checked; });
        $('#s-startup-help').textContent = st.supported
          ? 'The app opens when you sign in to Windows. You can also turn this off in Windows Settings → Apps → Startup.'
          : 'Available in the installed or portable app (not when running from source).';
      });
      $('#s-move').addEventListener('click', () => { closeModal(); window.api.moveDatabase(); });
      $('#s-folder').addEventListener('click', () => window.api.openDataFolder());
      $('#s-export').addEventListener('click', () => window.api.exportBackup());
      $('#s-import').addEventListener('click', () => { closeModal(); window.api.importBackup(); });
      $('#s-backups').addEventListener('click', () => window.api.openBackupsFolder());
      $('#s-hotit').addEventListener('click', () => { closeModal(); window.api.importFromHotit(); });
      if (focusClock) $('#s-clock').focus();
    },
    async onOk() {
      const timeZone = $('#s-clock').value;
      if (startup && startup.supported) {
        const enabled = $('#s-startup').checked;
        const minimized = enabled && $('#s-startup-min').checked;
        if (enabled !== startup.enabled || minimized !== startup.minimized) {
          const now = await window.api.setStartup({ enabled, minimized });
          if (now.enabled !== enabled) toast('Windows did not accept the startup setting.');
        }
      }
      try {
        await dbCall('setSetting', 'timeZone', timeZone);
      } catch {
        return false;
      }
      try {
        saveAppearance(readAppearance());
      } catch {
        toast('That background picture is too large to keep. Choose a smaller one.');
        return false;
      }
      const clockChanged = timeZone !== clock.setting;
      Object.assign(s, { timeZone });
      applyClock(timeZone);
      if (clockChanged) $('#composerDate').value = toLocalInput(new Date());
      refreshAll();
      if (clockChanged) toast(timeZone ? `App clock: ${clockTag()}` : 'App clock now follows your computer');
      return true;
    },
  });
}

function utcOffsetLabel(zone, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName').value; // "GMT-05:00" or "GMT"
    return name === 'GMT' ? 'UTC±00:00' : name.replace('GMT', 'UTC').replace('-', '−');
  } catch {
    return '';
  }
}

function offsetMinutesOf(zone, at = new Date()) {
  const m = /([+−])(\d{2}):(\d{2})/.exec(utcOffsetLabel(zone, at));
  return m ? (m[1] === '−' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

function clockOptionsHtml(current) {
  const opt = (value, label) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
  const pcZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const relative = [];
  for (let min = -12 * 60; min <= 12 * 60; min += 30) {
    if (min) relative.push(opt(`rel:${min}`, describeMinutes(min).replace('computer', 'my computer')));
  }

  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [pcZone, 'UTC'];
  }
  if (current && !current.startsWith('rel:') && !zones.includes(current)) zones.push(current);
  const named = zones
    .map((z) => ({ z, off: offsetMinutesOf(z), label: utcOffsetLabel(z) }))
    .sort((a, b) => a.off - b.off || a.z.localeCompare(b.z))
    .map(({ z, label }) => opt(z, `(${label}) ${z.replace(/_/g, ' ')}`));

  return `
    ${opt('', `My computer's time (${pcZone.replace(/_/g, ' ')})`)}
    <optgroup label="Hours from my computer's time">${relative.join('')}</optgroup>
    <optgroup label="A time zone (follows daylight saving)">${named.join('')}</optgroup>`;
}

/** "App time now: … · Computer: …" for a setting that has not been saved yet. */
function clockPreviewHtml(setting) {
  const saved = clock.setting;
  applyClock(setting);
  const now = new Date();
  const app = `${fmtLongDate(now)} ${fmtTime(now)}`;
  const diff = clockDifferenceMinutes(now);
  applyClock(saved);
  const pc = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  return `App time now: <strong>${esc(app)}</strong><br>Computer time: ${esc(pc)}` +
    (diff ? ` <span class="clock-tag">${esc(describeMinutes(diff))}</span>` : '');
}

// ============================================================
// Accounts: switcher, manage, add/edit/delete
// ============================================================

/** Switch the view to one account ('' = all accounts). */
function setViewAccount(id, { keepSelection = false } = {}) {
  state.db.settings.currentAccount = id;
  dbCall('setSetting', 'currentAccount', id).catch(() => {});
  const selected = contactById(state.selectedId);
  if (!keepSelection && selected && id && selected.accountId !== id) state.selectedId = null;
  renderAll();
  if (!state.selectedId) {
    const first = $('#contactList .contact');
    if (first) selectContact(first.dataset.id);
  }
}

/** Open a contact, switching to its account first if the current view doesn't include it. */
function showContact(id) {
  const c = contactById(id);
  if (!c) return;
  const view = viewAccount();
  if (view && view.id !== c.accountId) {
    state.db.settings.currentAccount = c.accountId;
    dbCall('setSetting', 'currentAccount', c.accountId).catch(() => {});
  }
  renderAll();
  selectContact(id);
}

function renderAccountSwitch(index = buildIndex()) {
  const btn = $('#accountSwitch');
  const multi = multiAccount();
  const view = viewAccount();
  const awaitingFor = (acctId) => state.db.contacts
    .filter((c) => !acctId || c.accountId === acctId)
    .filter((c) => contactStatus(index.get(c.id) || []) === 'awaiting').length;

  if (view) {
    btn.innerHTML = `${accountAvatar(view, 'sw')}<span class="sw-name">${esc(view.name)}</span>${multi ? '<span class="caret">▾</span>' : ''}`;
  } else {
    const stack = state.db.accounts.slice(0, 3).map((a) => accountAvatar(a, 'sw')).join('');
    btn.innerHTML = `<span class="sw-stack">${stack}</span><span class="sw-name">All accounts</span><span class="caret">▾</span>`;
  }
  btn.title = multi ? 'Switch account (Ctrl+1…9, Ctrl+0 for all)' : 'Your account — click to add another';

  const item = (id, avatar, name, sub, i) => `
    <button type="button" class="acct-item ${(view?.id || '') === id ? 'current' : ''}" data-account="${esc(id)}">
      ${avatar}
      <span class="acct-text"><span class="acct-name">${esc(name)}</span><span class="acct-sub">${esc(sub)}</span></span>
      <span class="acct-key">${i !== undefined ? `Ctrl+${i}` : ''}</span>
    </button>`;
  const rows = state.db.accounts.map((a, i) => {
    const n = state.db.contacts.filter((c) => c.accountId === a.id).length;
    return item(a.id, accountAvatar(a, 'sm'), a.name, `${plural(n, 'contact')} · ${awaitingFor(a.id)} awaiting reply`, i < 9 ? i + 1 : undefined);
  });
  if (multi) {
    rows.push(item('', `<span class="sw-stack big">${state.db.accounts.slice(0, 3).map((a) => accountAvatar(a, 'sw')).join('')}</span>`,
      'All accounts', `${plural(state.db.contacts.length, 'contact')} · ${awaitingFor('')} awaiting reply`, 0));
  }
  $('#accountMenu').innerHTML = `
    <div class="acct-menu-title">Your LinkedIn accounts</div>
    ${rows.join('')}
    <div class="acct-menu-sep"></div>
    <button type="button" class="acct-action" data-menu="add">+ Add account</button>
    <button type="button" class="acct-action" data-menu="manage">Manage accounts…</button>`;
}

function toggleAccountMenu(open) {
  const menu = $('#accountMenu');
  const show = open ?? menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !show);
  $('#accountSwitch').setAttribute('aria-expanded', String(show));
}

function openAccountsManager() {
  const index = buildIndex();
  const rows = state.db.accounts.map((a) => {
    const contacts = state.db.contacts.filter((c) => c.accountId === a.id);
    const msgs = contacts.reduce((n, c) => n + (index.get(c.id) || []).length, 0);
    return `
      <div class="acct-row" data-account="${esc(a.id)}">
        ${accountAvatar(a, 'sm')}
        <div class="acct-text">
          <span class="acct-name">${esc(a.name)}</span>
          <span class="acct-sub">${esc(a.linkedinUrl || 'No profile URL')} · ${plural(contacts.length, 'contact')} · ${plural(msgs, 'message')}</span>
        </div>
        <button type="button" class="btn ghost small" data-acct-action="edit">Edit</button>
        <button type="button" class="btn ghost small" data-acct-action="delete" ${multiAccount() ? '' : 'disabled title="You need at least one account"'}>Delete</button>
      </div>`;
  }).join('');
  openModal({
    title: 'Your LinkedIn accounts',
    body: `
      <p class="help">Add one account for each LinkedIn profile you message from. Every contact belongs to one account,
        and messages you sent show that account's name and photo.</p>
      <div class="acct-list">${rows}</div>
      <button type="button" class="btn secondary small" id="acct-add">+ Add account</button>`,
    okText: 'Done',
    hideCancel: true,
    onOpen() {
      $('#acct-add').addEventListener('click', () => openAccountModal(null));
      $('.acct-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-acct-action]');
        if (!btn || btn.disabled) return;
        const acct = accountById(btn.closest('[data-account]').dataset.account);
        if (btn.dataset.acctAction === 'edit') openAccountModal(acct);
        else deleteAccountDialog(acct);
      });
      $('#modalOk').focus();
    },
    onOk: () => true,
  });
}

function openAccountModal(existing, { thenManage = true } = {}) {
  let avatarEditor = null;
  const id = existing ? existing.id : uid();
  const back = () => { if (thenManage) setTimeout(openAccountsManager, 0); };
  openModal({
    title: existing ? 'Edit account' : 'Add account',
    body: `
      ${avatarEditorHtml('Profile photo (shown on messages this account sent)')}
      <div class="field">
        <label for="a-url">Your LinkedIn profile URL</label>
        <input id="a-url" value="${esc(existing?.linkedinUrl || '')}" placeholder="https://www.linkedin.com/in/…" spellcheck="false">
      </div>
      <div class="field">
        <label for="a-name">Name <span class="req">*</span></label>
        <input id="a-name" value="${esc(existing?.name || '')}" placeholder="e.g. James Clarke (Recruiting)">
        <div class="error hidden" id="a-name-err">Please enter a name.</div>
      </div>`,
    okText: existing ? 'Save' : 'Add account',
    onOpen() {
      const nameInput = $('#a-name');
      const urlInput = $('#a-url');
      avatarEditor = setupAvatarEditor({
        seed: id,
        getName: () => nameInput.value.trim(),
        currentSrc: existing ? avatarSrc(existing.id, existing.avatarVersion) : null,
      });
      let autoName = !existing;
      nameInput.addEventListener('input', () => { autoName = !nameInput.value.trim(); avatarEditor.redraw(); });
      urlInput.addEventListener('input', () => {
        if (autoName) nameInput.value = nameFromUrl(urlInput.value);
        avatarEditor.redraw();
      });
      onCancelOnly(back);
      (existing ? nameInput : urlInput).focus();
    },
    async onOk() {
      const data = { id, name: $('#a-name').value.trim(), linkedinUrl: $('#a-url').value.trim() };
      $('#a-name-err').classList.toggle('hidden', !!data.name);
      if (!data.name) { $('#a-name').focus(); return false; }
      try {
        await dbCall(existing ? 'updateAccount' : 'createAccount', data);
        const v = await applyAvatar(id, avatarEditor.getPending());
        if (existing) {
          Object.assign(existing, data);
          if (v !== undefined) existing.avatarVersion = v;
        } else {
          state.db.accounts.push({ ...data, position: state.db.accounts.length, createdAt: new Date().toISOString(), avatarVersion: v ?? null });
        }
      } catch {
        return false;
      }
      renderAll({ scroll: 'keep' });
      toast(existing ? 'Account updated' : `Account “${data.name}” added`);
      back();
      return true;
    },
  });
}

function deleteAccountDialog(acct) {
  const others = state.db.accounts.filter((a) => a.id !== acct.id);
  const n = state.db.contacts.filter((c) => c.accountId === acct.id).length;
  const options = others.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  openModal({
    title: `Delete “${acct.name}”?`,
    body: n ? `
      <p>This account has ${plural(n, 'contact')}. What should happen to them?</p>
      <div class="field">
        <label class="check radio"><input type="radio" name="d-mode" value="move" checked> Move them to
          <select id="d-move">${options}</select></label>
        <label class="check radio"><input type="radio" name="d-mode" value="delete"> Delete them and their messages too</label>
        <div class="help">Deleted contacts can still be recovered from the automatic backups.</div>
      </div>` : `<p>This account has no contacts.</p><input type="hidden" id="d-move" value="${esc(others[0].id)}">`,
    okText: 'Delete account',
    danger: true,
    onOpen() {
      onCancelOnly(() => setTimeout(openAccountsManager, 0));
    },
    async onOk() {
      const moveTo = $('#d-move').value;
      const deleteContacts = !!n && $('input[name="d-mode"]:checked').value === 'delete';
      try {
        await dbCall('deleteAccount', acct.id, moveTo, deleteContacts);
      } catch {
        return false;
      }
      state.db = await window.api.load();
      applyClock(state.db.settings.timeZone);
      if (!contactById(state.selectedId)) state.selectedId = null;
      renderAll();
      toast(`Deleted account “${acct.name}”`);
      setTimeout(openAccountsManager, 0);
      return true;
    },
  });
}

/** Quick photo change from the profile card, without opening the edit dialog. */
function pickContactPhoto(contact) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const a = await imageToAvatar(file);
      contact.avatarVersion = await dbCall('setAvatar', contact.id, 'image/jpeg', a.bytes);
      renderList();
      renderThread({ scroll: 'keep' });
      toast('Photo updated');
    } catch (err) {
      if (err.message && !/remote method/.test(err.message)) toast(err.message);
    }
  });
  input.click();
}

function showShortcuts() {
  const rows = [
    ['Ctrl + N', 'New contact'],
    ['Ctrl + F / Ctrl + K', 'Search'],
    ['Esc', 'Clear search / close dialog'],
    ['Ctrl + Enter', 'Add message / save dialog'],
    ['Alt + 1 / Alt + 2', 'Switch between “I sent” and “They replied”'],
    ['Alt + ↑ / Alt + ↓', 'Previous / next conversation'],
    ['Ctrl + 1 … 9 / Ctrl + 0', 'Switch to account 1…9 / all accounts'],
    ['Ctrl + = / Ctrl + −', 'Zoom in / out'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    body: `<table class="kbd-table">${rows.map(([k, v]) =>
      `<tr><td>${k.split(' / ').map((p) => p.split(' + ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' + ')).join(' / ')}</td><td>${esc(v)}</td></tr>`).join('')}</table>`,
    okText: 'Close',
    hideCancel: true,
    onOk: () => true,
  });
}

// ============================================================
// Modal + toast
// ============================================================

let modalOk = null;
let modalCleanup = [];

function openModal({ title, body, okText = 'Save', danger = false, hideCancel = false, onOpen, onOk }) {
  runModalCleanup();
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const ok = $('#modalOk');
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  $('#modalCancel').classList.toggle('hidden', hideCancel);
  modalOk = onOk;
  $('#modal').showModal();
  if (onOpen) onOpen();
  else ok.focus();
}

function closeModal() {
  modalOk = null;
  if ($('#modal').open) $('#modal').close();
  runModalCleanup();
}

/** Run fn when the current dialog's Cancel button is clicked (removed again when the dialog closes). */
function onCancelOnly(fn) {
  const btn = $('#modalCancel');
  // capture phase: runs before the button's closeModal handler, which clears this listener
  btn.addEventListener('click', fn, true);
  modalCleanup.push(() => btn.removeEventListener('click', fn, true));
}

function runModalCleanup() {
  for (const fn of modalCleanup.splice(0)) fn();
}

let toastTimer = null;
function toast(text, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    $('button', el).addEventListener('click', () => {
      el.classList.remove('show');
      action.fn();
    });
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 2500);
}

function syncFilterChips() {
  $$('#filters .chip').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
}

// ============================================================
// Events
// ============================================================

function bindEvents() {
  composerTray = new ImageTray($('#composerTray'), { onChange: updateAddButton });

  // account switcher
  $('#accountSwitch').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });
  $('#accountMenu').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-account]');
    const action = e.target.closest('[data-menu]');
    toggleAccountMenu(false);
    if (pick) setViewAccount(pick.dataset.account);
    else if (action?.dataset.menu === 'add') openAccountModal(null, { thenManage: false });
    else if (action?.dataset.menu === 'manage') openAccountsManager();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.account-switch-wrap')) toggleAccountMenu(false);
  });
  $('#btnNewContact').addEventListener('click', () => openContactModal());
  $('#btnEmptyNew').addEventListener('click', () => openContactModal());
  $('#btnSettings').addEventListener('click', () => openSettings());

  // search
  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      const rows = renderList();
      // keep the open conversation if it still matches; otherwise open the top result
      if (state.query.trim() && rows.length && !rows.some((r) => r.c.id === state.selectedId)) {
        selectContact(rows[0].c.id, { scroll: 'hit' });
      } else {
        renderThread({ scroll: state.query.trim() ? 'hit' : 'bottom' });
      }
    }, 120);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      const first = $('#contactList .contact');
      if (first) selectContact(first.dataset.id, { scroll: 'hit' });
    }
  });
  $('#searchField').addEventListener('change', (e) => {
    state.field = e.target.value;
    const ph = {
      all: 'Search messages',
      name: 'Search by name',
      url: 'Search by LinkedIn URL',
      nationality: 'Search by country',
      content: 'Search chat content',
    };
    $('#search').placeholder = ph[state.field];
    renderList();
    renderThread({ scroll: state.query.trim() ? 'hit' : 'keep' });
    $('#search').focus();
  });

  // filters
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    syncFilterChips();
    renderList();
  });

  // contact list
  $('#contactList').addEventListener('click', (e) => {
    const li = e.target.closest('.contact');
    if (li) selectContact(li.dataset.id);
  });
  $('#contactList').addEventListener('keydown', (e) => {
    const li = e.target.closest('.contact');
    if (li && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      selectContact(li.dataset.id);
    }
  });

  // thread actions
  $('#threadMain').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const contact = contactById(state.selectedId);
    const msgId = btn.dataset.msg || btn.closest('.msg')?.dataset.id;
    const msg = msgId ? state.db.messages.find((m) => m.id === msgId) : null;
    switch (btn.dataset.action) {
      case 'open-profile':
        if (contact?.linkedinUrl) window.api.openExternal(fullUrl(contact.linkedinUrl));
        break;
      case 'edit-contact':
        openContactModal(contact);
        break;
      case 'change-photo':
        pickContactPhoto(contact);
        break;
      case 'delete-contact':
        deleteContact(contact);
        break;
      case 'copy-msg':
        navigator.clipboard.writeText(msg.text).then(() => toast('Copied to clipboard'));
        break;
      case 'view-image':
        openLightbox(msg, btn.dataset.att);
        break;
      case 'edit-msg':
        editMessage(msg);
        break;
      case 'toggle-seen':
        toggleSeen(msg);
        break;
      case 'delete-msg':
        openModal({
          title: 'Delete message?',
          body: `<p>This removes the message: <strong>${esc(messagePreview(msg))}</strong></p>`,
          okText: 'Delete',
          danger: true,
          async onOk() {
            await deleteMessage(msg);
            return true;
          },
        });
        break;
    }
  });

  // composer
  $('#directionToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    state.direction = b.dataset.dir;
    renderComposer();
    $('#composerText').focus();
  });
  $('#btnNow').addEventListener('click', () => { $('#composerDate').value = toLocalInput(new Date()); });
  $('#composerText').addEventListener('input', () => {
    updateAddButton();
    fitComposer();
  });

  // message box size: drag the handle on its top edge, double-click to reset
  const handle = $('#composerResize');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = $('#composerText').getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing-composer');
    const move = (ev) => setComposerHeight(startH - (ev.clientY - startY)); // dragging up = taller
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-composer');
      composerHeight = Math.round($('#composerText').getBoundingClientRect().height);
      try { localStorage.setItem('composerHeight', String(composerHeight)); } catch { /* not critical */ }
      fitComposer();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    composerHeight = COMPOSER_DEFAULT_HEIGHT;
    try { localStorage.removeItem('composerHeight'); } catch { /* not critical */ }
    fitComposer();
  });
  window.addEventListener('resize', () => fitComposer());

  // attaching images: button, paste, drag & drop
  $('#btnAttach').addEventListener('click', () => $('#attachFile').click());
  $('#attachFile').addEventListener('change', async (e) => {
    await composerTray.addFiles(e.target.files);
    e.target.value = '';
    $('#composerText').focus();
  });
  document.addEventListener('paste', (e) => {
    if ($('#modal').open || lightboxOpen() || !state.selectedId) return;
    const files = imageFilesFrom(e.clipboardData?.files);
    if (!files.length) return;
    const t = e.target;
    const inOtherField = t !== $('#composerText') && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (inOtherField) return;
    // when copying from a web page the clipboard may hold text too; keep the text paste in that case
    if (t !== $('#composerText') || !e.clipboardData.types.includes('text/plain')) e.preventDefault();
    composerTray.addFiles(files).then(() => toast(files.length > 1 ? `${files.length} images attached` : 'Image attached'));
  });
  const threadMain = $('#threadMain');
  let dragDepth = 0;
  threadMain.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('#composer').classList.add('drag');
  });
  threadMain.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#composer').classList.remove('drag');
  });
  threadMain.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#composer').classList.remove('drag');
    const files = imageFilesFrom(e.dataTransfer.files);
    if (files.length) composerTray.addFiles(files);
    else if (e.dataTransfer.files.length) toast('Only images can be attached.');
  });

  // full-size image viewer
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightboxPrev').addEventListener('click', () => moveLightbox(-1));
  $('#lightboxNext').addEventListener('click', () => moveLightbox(1));
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  $('#lightboxSave').addEventListener('click', () => {
    const a = lightbox.list[lightbox.index];
    if (a) window.api.saveAttachment(a.id).then((ok) => ok && toast('Image saved'));
  });
  $('#lightboxCopy').addEventListener('click', async () => {
    const a = lightbox.list[lightbox.index];
    if (!a) return;
    const ok = await window.api.copyAttachment(a.id);
    toast(ok ? 'Image copied — you can paste it into LinkedIn' : 'This image type cannot be copied; use “Save as…” instead');
  });
  $('#composerText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addMessage();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    addMessage();
  });

  // modal
  let modalBusy = false;
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (modalBusy) return;
    modalBusy = true;
    $('#modalOk').disabled = true;
    try {
      if (modalOk && (await modalOk()) === false) return;
      closeModal();
    } finally {
      modalBusy = false;
      $('#modalOk').disabled = false;
    }
  });
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('close', () => {
    // (this event arrives a moment after closing: if another dialog was opened since, leave it alone)
    if ($('#modal').open) return;
    modalOk = null;
    runModalCleanup();
  });

  // stop a dropped file from replacing the whole window
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  // Ctrl+Enter saves even from a textarea in a dialog
  $('#modal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('#modalForm').requestSubmit();
    }
  });

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    if (lightboxOpen()) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') moveLightbox(-1);
      else if (e.key === 'ArrowRight') moveLightbox(1);
      else return;
      e.preventDefault();
      return;
    }
    if ($('#modal').open) return;
    if (e.key === 'Escape' && !$('#accountMenu').classList.contains('hidden')) {
      toggleAccountMenu(false);
      return;
    }
    // Ctrl+1…9: switch to that account, Ctrl+0: all accounts
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key) && multiAccount()) {
      const n = Number(e.key);
      const acct = n ? state.db.accounts[n - 1] : null;
      if (n === 0 || acct) {
        e.preventDefault();
        setViewAccount(acct ? acct.id : '');
      }
      return;
    }
    if (e.altKey && (e.key === '1' || e.key === '2') && state.selectedId) {
      e.preventDefault();
      state.direction = e.key === '1' ? 'out' : 'in';
      renderComposer();
      $('#composerText').focus();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const ids = $$('#contactList .contact').map((li) => li.dataset.id);
      if (!ids.length) return;
      const i = ids.indexOf(state.selectedId);
      const next = e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(ids.length - 1, i + 1);
      selectContact(ids[i < 0 ? 0 : next]);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusSearch();
    }
  });

  $('#clockTag').addEventListener('click', (e) => {
    e.preventDefault();
    openSettings({ focusClock: true });
  });

  // refresh relative dates ("Today", "3 days") once a minute
  setInterval(() => {
    if (!$('#modal').open) {
      renderList();
      renderClockTag(); // the difference can change at daylight-saving switches
    }
  }, 60 * 1000);
}

function focusSearch() {
  $('#search').focus();
  $('#search').select();
}
