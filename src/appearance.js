'use strict';

// ============================================================
// Appearance: light / dark theme and the background of the main area.
// Kept per PC (localStorage). Loaded in <head>, so the theme is set before anything is drawn.
// ============================================================

const APPEARANCE_KEY = 'appearance';
const THEMES = { light: 'Light', dark: 'Dark', system: 'Same as Windows' };
const DEFAULT_APPEARANCE = { theme: 'light', bg: 'none', color: '#dbe6fb', image: '', fade: 40 };

function loadAppearance() {
  try {
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Throws if the browser storage is full (a very large background picture). */
function saveAppearance(prefs) {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(prefs));
  window.api?.setTheme(prefs.theme);
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let shownAppearance = null; // what is on screen (the saved look, or the preview in Settings)

function applyAppearance(prefs = loadAppearance()) {
  shownAppearance = prefs;
  const root = document.documentElement;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark.matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  const image = prefs.bg === 'image' && prefs.image;
  const color = prefs.bg === 'color' && /^#[0-9a-f]{6}$/i.test(prefs.color) ? prefs.color : '';
  root.classList.toggle('has-bg', !!(image || color));
  root.style.setProperty('--app-bg-color', color || 'var(--bg)');
  root.style.setProperty('--app-bg-image', image ? `url("${image}")` : 'none');
  root.style.setProperty('--app-bg-fade', String(Math.min(90, Math.max(0, Number(prefs.fade) || 0)) / 100));
}

applyAppearance();
systemDark.addEventListener('change', () => applyAppearance(shownAppearance));

/** A picked picture, scaled down to at most 2400 px wide and stored as a JPEG data URL. */
function pictureToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2400 / img.naturalWidth, 1600 / img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not a picture this app can read.'));
    };
    img.src = url;
  });
}

// ---------- Settings → Appearance ----------

function appearanceFieldHtml() {
  const p = loadAppearance();
  return `
    <div class="field appearance-field">
      <label>Appearance</label>
      <div class="appearance-row">
        <span>Theme</span>
        <div class="segmented" id="s-theme" role="radiogroup" aria-label="Theme">
          ${Object.entries(THEMES).map(([k, v]) => `<button type="button" data-theme="${k}" class="${p.theme === k ? 'active' : ''}">${v}</button>`).join('')}
        </div>
      </div>
      <div class="appearance-row">
        <span>Background</span>
        <div class="segmented" id="s-bg" role="radiogroup" aria-label="Background">
          <button type="button" data-bg="none" class="${p.bg === 'none' ? 'active' : ''}">None</button>
          <button type="button" data-bg="color" class="${p.bg === 'color' ? 'active' : ''}">Color</button>
          <button type="button" data-bg="image" class="${p.bg === 'image' ? 'active' : ''}">Picture</button>
        </div>
        <input type="color" id="s-bg-color" value="${p.color}" title="Background color">
        <button type="button" class="btn ghost small" id="s-bg-pick">Choose picture…</button>
        <input type="file" id="s-bg-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
      </div>
      <div class="appearance-row" id="s-fade-row">
        <span>Fade</span>
        <input type="range" id="s-bg-fade" min="0" max="90" step="5" value="${p.fade}">
        <span class="help" id="s-bg-fade-value"></span>
      </div>
      <div class="help">Shown behind the pages. Fade blends it with the page color so text stays easy to read.
        Saved on this PC only.</div>
    </div>`;
}

/** Live preview while the dialog is open; returns read() for Save. Closing without saving puts the saved look back. */
function setupAppearanceField() {
  const p = loadAppearance();
  const sync = () => {
    $$('#s-theme button').forEach((b) => b.classList.toggle('active', b.dataset.theme === p.theme));
    $$('#s-bg button').forEach((b) => b.classList.toggle('active', b.dataset.bg === p.bg));
    $('#s-bg-color').classList.toggle('hidden', p.bg !== 'color');
    $('#s-bg-pick').classList.toggle('hidden', p.bg !== 'image');
    $('#s-bg-pick').textContent = p.image ? 'Change picture…' : 'Choose picture…';
    $('#s-fade-row').classList.toggle('hidden', p.bg === 'none');
    $('#s-bg-fade-value').textContent = `${p.fade}%`;
    applyAppearance(p);
  };
  $('#s-theme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (b) { p.theme = b.dataset.theme; window.api.setTheme(p.theme); sync(); }
  });
  $('#s-bg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bg]');
    if (!b) return;
    p.bg = b.dataset.bg;
    sync();
    if (p.bg === 'image' && !p.image) $('#s-bg-file').click();
  });
  $('#s-bg-color').addEventListener('input', (e) => { p.color = e.target.value; sync(); });
  $('#s-bg-fade').addEventListener('input', (e) => { p.fade = Number(e.target.value); sync(); });
  $('#s-bg-pick').addEventListener('click', () => $('#s-bg-file').click());
  $('#s-bg-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      p.image = await pictureToDataUrl(file);
    } catch (err) {
      toast(err.message);
      return;
    }
    p.bg = 'image';
    sync();
  });
  modalCleanup.push(() => {
    const saved = loadAppearance();
    applyAppearance(saved);
    window.api.setTheme(saved.theme);
  });
  sync();
  return () => p;
}
