let pendingFiles = [];
let currentType = 'note';

const SECONDARY_LABEL = { note: 'Folder', reminder: 'List', event: 'Calendar' };
const SECONDARY_DEFAULT_KEY = { note: 'defaultFolder', reminder: 'defaultList', event: 'defaultCalendar' };
const BODY_LABEL = { note: 'Body', reminder: 'Notes', event: 'Notes' };
const HEADER_TITLE = { note: '🍎 Apple Notes', reminder: '✅ Reminders', event: '📅 Calendar' };
const ENDPOINT = { note: '/api/apple-notes', reminder: '/api/reminders', event: '/api/calendar' };

// Firefox/Chrome extension popups render the native datetime-local calendar
// widget behind the popup itself (a known WebExtension popup limitation), so
// date and time are split into separate inputs and combined here instead.
function combineDateTime(prefix) {
  const date = document.getElementById(`${prefix}-date`).value;
  const time = document.getElementById(`${prefix}-time`).value;
  if (!date) return '';
  return `${date}T${time || '00:00'}`;
}

function clearDateTime(prefix) {
  document.getElementById(`${prefix}-date`).value = '';
  document.getElementById(`${prefix}-time`).value = '';
}

// Parses an HTML fragment in a detached document and imports its nodes,
// rather than assigning to .innerHTML directly (avoids the unsafe-innerHTML
// lint warning while still supporting rich, formatted draft content).
function setEditorHtml(editor, html) {
  editor.textContent = '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  Array.from(doc.body.childNodes).forEach((node) => {
    editor.appendChild(document.importNode(node, true));
  });
}

// ── Draft persistence — lets the popup pick up where you left off ──────────
const DRAFT_KEY = 'draft';
const DRAFT_FIELDS = [
  'title', 'secondary', 'priority', 'location',
  'dueDate-date', 'dueDate-time',
  'startDate-date', 'startDate-time',
  'endDate-date', 'endDate-time',
];

function getDraftState() {
  const state = { type: currentType, bodyHtml: document.getElementById('editor').innerHTML };
  for (const id of DRAFT_FIELDS) {
    const el = document.getElementById(id);
    if (el) state[id] = el.value;
  }
  state.allDay = document.getElementById('allDay').checked;
  return state;
}

let draftSaveTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ [DRAFT_KEY]: getDraftState() });
  }, 400);
}

function clearDraft() {
  clearTimeout(draftSaveTimer);
  chrome.storage.local.remove(DRAFT_KEY);
}

async function restoreDraft(settings) {
  const stored = await new Promise((resolve) => chrome.storage.local.get(DRAFT_KEY, resolve));
  const draft = stored[DRAFT_KEY];
  if (!draft) return false;

  await setType(draft.type || 'note', settings);
  for (const id of DRAFT_FIELDS) {
    const el = document.getElementById(id);
    if (el && draft[id] !== undefined) el.value = draft[id];
  }
  document.getElementById('allDay').checked = !!draft.allDay;
  if (draft.bodyHtml) setEditorHtml(document.getElementById('editor'), draft.bodyHtml);
  return true;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl: 'https://dashboard.erinskidds.com',
        apiKey: '',
        defaultFolder: 'Notes',
        defaultList: 'Reminders',
        defaultCalendar: 'Calendar',
        aiEnabled: false,
      },
      resolve
    );
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (isError ? 'err' : 'ok');
}

function renderChips() {
  const container = document.getElementById('file-chips');
  container.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = `${f.type.startsWith('image/') ? '🖼️' : '📄'} ${f.name}`;
    chip.appendChild(label);
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.onclick = () => { pendingFiles.splice(i, 1); renderChips(); };
    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

function addFiles(files) {
  if (!files) return;
  Array.from(files).forEach((f) => pendingFiles.push(f));
  renderChips();
}

async function uploadFile(serverUrl, apiKey, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${serverUrl}/api/apple-notes/upload`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: fd,
  });
  if (!res.ok) throw new Error(`Upload failed: ${file.name}`);
  return res.json();
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>\s*<input[^>]*>/gi, '☐ ')
    .replace(/<li[^>]*class="[^"]*checked[^"]*"[^>]*>\s*<input[^>]*>/gi, '☑ ')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Natural-language capture ───────────────────────────────────────────────

/**
 * Whether the user has clicked a type tab themselves this session.
 *
 * Set only from the tab click handler, never from the programmatic setType()
 * calls that draft restore and applyCapture make. When it is true the parse is
 * pinned to that type, so deliberately choosing Reminder and then describing a
 * 3pm call keeps it a reminder with a due date, instead of being reclassified
 * as an event and switching the tab out from under you.
 */
let userPickedType = false;

// The server runs UTC, so it can't resolve "friday at 3pm" against the right
// day on its own — send this machine's wall clock with the request.
function localNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Split 'YYYY-MM-DDTHH:mm' across the paired date and time inputs. */
function setDateTime(prefix, value) {
  const dateEl = document.getElementById(`${prefix}-date`);
  const timeEl = document.getElementById(`${prefix}-time`);
  if (!value) {
    dateEl.value = '';
    timeEl.value = '';
    return;
  }
  const [date, time] = value.split('T');
  dateEl.value = date || '';
  timeEl.value = time || '';
}

function setAiStatus(msg, kind = '') {
  const el = document.getElementById('ai-status');
  el.textContent = msg;
  el.className = kind;
}

/** Drop a parsed capture into the form for review. Never submits. */
async function applyCapture(capture, settings) {
  // setType resets the secondary field to the type's default, so it has to run
  // before the parsed container is written in.
  await setType(capture.type, settings);

  document.getElementById('title').value = capture.title || '';
  if (capture.container) document.getElementById('secondary').value = capture.container;

  const editor = document.getElementById('editor');
  editor.textContent = '';
  if (capture.body) {
    for (const line of capture.body.split('\n')) {
      const p = document.createElement('p');
      if (line.trim()) p.textContent = line;
      else p.appendChild(document.createElement('br'));
      editor.appendChild(p);
    }
  }

  setDateTime('dueDate', capture.dueDate);
  setDateTime('startDate', capture.startDate);
  setDateTime('endDate', capture.endDate);
  document.getElementById('priority').value = capture.priority || 'none';
  document.getElementById('allDay').checked = !!capture.allDay;
  document.getElementById('location').value = capture.location || '';

  scheduleDraftSave();
}

function setupAi(settings) {
  const section = document.getElementById('ai-section');
  section.classList.toggle('hidden', !settings.aiEnabled);
  if (!settings.aiEnabled) return;

  const input = document.getElementById('ai-input');
  const btn = document.getElementById('ai-parse-btn');

  async function parse() {
    const text = input.value.trim();
    if (!text) { setAiStatus('Type something to parse first.', 'err'); return; }
    if (!settings.apiKey) { setAiStatus('API key not configured.', 'err'); return; }

    btn.disabled = true;
    setAiStatus('Thinking…', 'busy');
    try {
      const res = await fetch(`${settings.serverUrl}/api/ai/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey },
        body: JSON.stringify({
          text,
          now: localNow(),
          // Only pin when the choice was deliberate. The popup opens on the
          // Note tab, so pinning unconditionally would turn every capture into
          // a note.
          ...(userPickedType ? { type: currentType } : {}),
          folders: [settings.defaultFolder].filter(Boolean),
          lists: [settings.defaultList].filter(Boolean),
          calendars: [settings.defaultCalendar].filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      await applyCapture(data.capture, settings);
      const secs = data.ms ? ` in ${(data.ms / 1000).toFixed(1)}s` : '';
      setAiStatus(`✓ Filled in below — check it over${secs}.`, 'ok');
      input.value = '';
    } catch (err) {
      setAiStatus(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', parse);
  // Enter submits, Shift+Enter makes a new line — the textarea is for one-liners.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      parse();
    }
  });
}

// ── WYSIWYG toolbar ────────────────────────────────────────────────────────
function setupToolbar() {
  const editor = document.getElementById('editor');
  const styleSelect = document.getElementById('fmt-style');

  // execCommand buttons
  document.querySelectorAll('.toolbar button[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep editor focus
      document.execCommand(btn.dataset.cmd, false, null);
      updateToolbarState();
    });
  });

  // Format block (headings / pre)
  styleSelect.addEventListener('change', () => {
    editor.focus();
    const tag = styleSelect.value;
    if (tag === 'pre') {
      document.execCommand('formatBlock', false, 'pre');
    } else {
      document.execCommand('formatBlock', false, tag);
    }
  });

  // Checklist
  document.getElementById('btn-checklist').addEventListener('mousedown', (e) => {
    e.preventDefault();
    editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const block = range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;
    const li = block.closest('li');
    if (li && li.closest('ul.task-list')) {
      // Already a task item — convert back to paragraph
      const p = document.createElement('p');
      p.textContent = li.querySelector('span') ? li.querySelector('span').textContent : li.textContent.replace(/^.\s*/, '');
      li.closest('ul').replaceWith(p);
    } else {
      const html = `<ul class="task-list"><li><input type="checkbox"><span contenteditable="true"> </span></li></ul>`;
      document.execCommand('insertHTML', false, html);
    }
    updateToolbarState();
  });

  // Sync style select on cursor move
  editor.addEventListener('keyup', updateToolbarState);
  editor.addEventListener('mouseup', updateToolbarState);
  document.addEventListener('selectionchange', updateToolbarState);

  // Keyboard shortcuts: Ctrl/Cmd+B/I/U, Ctrl/Cmd+Shift+X for strikethrough
  editor.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    const cmdMap = { b: 'bold', i: 'italic', u: 'underline' };
    if (cmdMap[key] && !e.shiftKey) {
      e.preventDefault();
      document.execCommand(cmdMap[key], false, null);
      updateToolbarState();
    } else if (key === 'x' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('strikeThrough', false, null);
      updateToolbarState();
    }
  });
}

function updateToolbarState() {
  const cmds = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'];
  cmds.forEach((cmd) => {
    const btn = document.querySelector(`.toolbar button[data-cmd="${cmd}"]`);
    if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
  });

  // Sync format select
  const block = document.queryCommandValue('formatBlock').toLowerCase();
  const styleSelect = document.getElementById('fmt-style');
  if (block && styleSelect) {
    const match = ['h1', 'h2', 'h3', 'pre'].find((t) => block.includes(t));
    styleSelect.value = match || 'p';
  }

  // Checklist active state
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const el = sel.getRangeAt(0).startContainer;
    const node = el.nodeType === 1 ? el : el.parentElement;
    const inTaskList = !!node.closest('ul.task-list');
    document.getElementById('btn-checklist')?.classList.toggle('active', inTaskList);
  }
}
// ──────────────────────────────────────────────────────────────────────────

async function setType(type, settings) {
  currentType = type;
  document.querySelectorAll('.type-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.type === type);
  });
  document.getElementById('header-title').textContent = HEADER_TITLE[type];
  document.getElementById('secondary-label').textContent = SECONDARY_LABEL[type];
  document.getElementById('secondary').value = settings[SECONDARY_DEFAULT_KEY[type]] || '';
  document.getElementById('body-label').textContent = BODY_LABEL[type];
  document.getElementById('reminder-fields').classList.toggle('hidden', type !== 'reminder');
  document.getElementById('event-fields').classList.toggle('hidden', type !== 'event');
  document.getElementById('attachments-section').classList.toggle('hidden', type !== 'note');
  // Toolbar only makes sense for Apple Notes
  document.getElementById('toolbar').classList.toggle('hidden', type !== 'note');
  setStatus('');
}

// True when this document is running expanded into a sidebar or a full tab
// rather than as the small toolbar dropdown — used to skip the auto-close
// that normally happens after a successful submit.
const surface = new URLSearchParams(location.search).get('surface');
const isExpandedSurface = surface === 'sidebar' || surface === 'tab';

async function openExpanded() {
  // Firefox: native sidebar.
  try {
    if (typeof browser !== 'undefined' && browser.sidebarAction) {
      await browser.sidebarAction.open();
      window.close();
      return;
    }
  } catch { /* sidebar not available in this context */ }

  // Chrome 114+: native side panel (only if the user's Chrome build exposes it).
  try {
    if (chrome.sidePanel) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.setOptions({ path: 'popup.html?surface=sidebar', enabled: true });
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    }
  } catch { /* side panel not available */ }

  // Fallback: a plain tab works everywhere.
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?surface=tab') });
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  const { apiKey } = settings;

  // Show no-key banner if not configured
  if (!apiKey) {
    document.getElementById('no-key').style.display = 'block';
    document.getElementById('main-form').style.display = 'none';
  }

  const expandLink = document.getElementById('expand-link');
  if (isExpandedSurface) {
    expandLink.style.display = 'none';
    document.body.classList.add('expanded');
  } else {
    expandLink.addEventListener('click', (e) => { e.preventDefault(); openExpanded(); });
  }

  setupToolbar();
  setupAi(settings);

  // Type tabs
  document.querySelectorAll('.type-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      userPickedType = true;
      setType(tab.dataset.type, settings);
    });
  });
  await setType('note', settings);

  // Restore an in-progress draft if one exists; otherwise pre-fill title,
  // selected text, and the page URL from the active tab.
  const editor = document.getElementById('editor');
  const draftRestored = await restoreDraft(settings);

  if (!draftRestored) {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch { /* no active tab */ }

    if (tab?.title) document.getElementById('title').value = tab.title;

    // Isolated in its own try/catch: on pages where content-script injection
    // isn't allowed (e.g. browser internal pages), this call rejects — that
    // must not prevent the URL below from still being added to the note.
    let selectedText = '';
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || '',
      });
      selectedText = result?.result || '';
    } catch { /* selection not available on this page */ }

    if (selectedText) {
      const p = document.createElement('p');
      p.textContent = selectedText;
      editor.appendChild(p);
      const spacer = document.createElement('p');
      spacer.appendChild(document.createElement('br'));
      editor.appendChild(spacer);
    }
    if (tab?.url) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = tab.url;
      a.textContent = tab.url;
      p.appendChild(a);
      editor.appendChild(p);
    }
  }

  // Auto-save a draft on any edit so closing the popup doesn't lose it.
  document.getElementById('title').addEventListener('input', scheduleDraftSave);
  document.getElementById('secondary').addEventListener('input', scheduleDraftSave);
  document.getElementById('location').addEventListener('input', scheduleDraftSave);
  document.getElementById('priority').addEventListener('change', scheduleDraftSave);
  document.getElementById('allDay').addEventListener('change', scheduleDraftSave);
  editor.addEventListener('input', scheduleDraftSave);
  ['dueDate-date', 'dueDate-time', 'startDate-date', 'startDate-time', 'endDate-date', 'endDate-time']
    .forEach((id) => document.getElementById(id).addEventListener('change', scheduleDraftSave));
  document.querySelectorAll('.type-tab').forEach((tab) => {
    tab.addEventListener('click', scheduleDraftSave);
  });

  // Settings link
  document.getElementById('settings-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('settings-link-2')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // File input (notes only)
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // Submit
  document.getElementById('submit-btn').addEventListener('click', async () => {
    const title = document.getElementById('title').value.trim();
    const bodyHtml = editor.innerHTML.trim();
    const bodyText = htmlToText(bodyHtml);
    const secondary = document.getElementById('secondary').value.trim() ||
      (currentType === 'note' ? 'Notes' : SECONDARY_LABEL[currentType]);
    const btn = document.getElementById('submit-btn');

    if (!title) { setStatus('Title is required.', true); return; }
    if (!apiKey) { setStatus('API key not configured.', true); return; }
    if (currentType === 'event' && !document.getElementById('startDate-date').value) {
      setStatus('Start date is required for events.', true);
      return;
    }

    btn.disabled = true;
    setStatus('');

    try {
      let payload;
      if (currentType === 'note') {
        const attachments = [];
        if (pendingFiles.length > 0) {
          setStatus('Uploading files…');
          for (const file of pendingFiles) {
            const data = await uploadFile(settings.serverUrl, apiKey, file);
            attachments.push({ name: data.name, url: data.url, mimeType: data.mimeType });
          }
        }
        payload = { title, body: bodyHtml, folder: secondary, attachments };
      } else if (currentType === 'reminder') {
        payload = {
          title,
          notes: bodyText,
          list: secondary,
          dueDate: combineDateTime('dueDate'),
          priority: document.getElementById('priority').value,
        };
      } else {
        payload = {
          title,
          notes: bodyText,
          calendar: secondary,
          startDate: combineDateTime('startDate'),
          endDate: combineDateTime('endDate'),
          allDay: document.getElementById('allDay').checked,
          location: document.getElementById('location').value.trim(),
        };
      }

      setStatus('Saving…');
      const res = await fetch(`${settings.serverUrl}${ENDPOINT[currentType]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      setStatus('✓ Added to queue!');
      clearDraft();
      document.getElementById('title').value = '';
      document.getElementById('location').value = '';
      document.getElementById('priority').value = 'none';
      document.getElementById('allDay').checked = false;
      clearDateTime('dueDate');
      clearDateTime('startDate');
      clearDateTime('endDate');
      editor.textContent = '';
      pendingFiles = [];
      renderChips();
      if (!isExpandedSurface) setTimeout(() => window.close(), 1200);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
});
