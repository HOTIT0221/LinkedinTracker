'use strict';

// ============================================================
// Start-up, the menu, and redrawing after the data changed. The tracker itself is in renderer.js.
// ============================================================

/** Re-draw everything after data changed (keeps the scroll position of the open conversation). */
function refreshAll({ keep = true } = {}) {
  renderAll({ scroll: keep ? 'keep' : state.query.trim() ? 'hit' : 'bottom' });
  if (!contactById(state.selectedId)) {
    const first = $('#contactList .contact');
    if (first) selectContact(first.dataset.id);
  } else {
    requestAnimationFrame(fitComposer);
  }
}

/** The main process asks for the password of an encrypted HOTIT Manager file being imported. */
function bindPasswordRequests() {
  window.api.onAskPassword(({ fileName, error }, reply) => {
    let answered = false;
    const answer = (password) => {
      if (answered) return;
      answered = true;
      reply(password);
    };
    openModal({
      title: 'HOTIT Manager password',
      body: `
        <p class="modal-text"><strong>${esc(fileName)}</strong> is encrypted with your HOTIT Manager password.
          Enter it to read the LinkedIn messages in it (the file is only read, never changed).</p>
        <div class="field">
          <label for="pw-backup">Password</label>
          <input type="password" id="pw-backup" spellcheck="false">
          ${error ? `<div class="error">${esc(error)}</div>` : ''}
        </div>`,
      okText: 'Open',
      onOpen() {
        $('#pw-backup').focus();
        modalCleanup.push(() => answer(null)); // closed without OK
      },
      onOk() {
        if (!$('#pw-backup').value) {
          $('#pw-backup').focus();
          return false;
        }
        answer($('#pw-backup').value);
        return true;
      },
    });
  });
}

function bindAppEvents() {
  window.api.onMenu((cmd) => {
    if ($('#modal').open && cmd !== 'focus-search') closeModal();
    if (cmd === 'new') openContactModal();
    if (cmd === 'focus-search' && !$('#modal').open) focusSearch();
    if (cmd === 'settings') openSettings();
    if (cmd === 'accounts') openAccountsManager();
    if (cmd === 'shortcuts') showShortcuts();
  });

  window.api.onDataReplaced((data) => {
    const { message, ...db } = data;
    state.db = db;
    applyClock(db.settings.timeZone);
    state.selectedId = null;
    state.drafts = {};
    composerTray.clear();
    closeLightbox();
    refreshAll({ keep: false });
    if (message) toast(message);
  });
}

async function boot() {
  bindEvents();
  bindAppEvents();
  bindPasswordRequests();
  state.db = await window.api.load();
  applyClock(state.db.settings.timeZone);
  refreshAll({ keep: false });
  // the first start on a PC where HOTIT Manager kept the LinkedIn messages: offer to import them (once)
  if (!state.db.contacts.length) window.api.importFromHotit(true);
}

document.addEventListener('DOMContentLoaded', boot);
