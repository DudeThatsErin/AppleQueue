let pendingFiles = [];
let currentType = 'note';
let editorMode = 'wysiwyg'; // 'wysiwyg' | 'markdown' — always sends HTML on submit either way

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

// ── Markdown <-> HTML — same libraries and same rules as the dashboard's
// MarkdownEditor, vendored locally (turndown.js, marked.js) so the two stay
// in sync. The editor always sends HTML on submit; markdown is only ever an
// alternate way to type into the same editor.
let turndownService = null;
function getTurndown() {
  if (turndownService) return turndownService;
  turndownService = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  turndownService.addRule('div', {
    filter: 'div',
    replacement: (content) => `\n\n${content}\n\n`,
  });
  turndownService.addRule('taskListItem', {
    filter: (node) => node.nodeName === 'LI' && !!node.querySelector('input[type="checkbox"]'),
    replacement: (content, node) => {
      const box = node.querySelector('input[type="checkbox"]');
      const checked = box?.hasAttribute('checked') || box?.checked;
      const text = content.replace(/^\s*\[[ xX]\]\s*/, '').trim();
      return `- [${checked ? 'x' : ' '}] ${text}\n`;
    },
  });
  return turndownService;
}

function htmlToMarkdown(html) {
  if (!html) return '';
  return getTurndown().turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

// marked renders GFM task list checkboxes as disabled="" — fine for a
// preview, wrong for a note the user needs to actually check off.
function stripCheckboxDisabled(html) {
  return html.replace(/<input([^>]*type="checkbox"[^>]*)>/gi, (m, attrs) =>
    `<input${attrs.replace(/\s*disabled(="")?/gi, '')}>`
  );
}

function markdownToHtml(md) {
  if (!md) return '';
  return stripCheckboxDisabled(marked.parse(md, { async: false, gfm: true, breaks: true }));
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
  const state = { type: currentType, editorMode };
  if (editorMode === 'markdown') {
    state.bodyMarkdown = document.getElementById('editor-source').value;
  } else {
    state.bodyHtml = document.getElementById('editor').innerHTML;
  }
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

  editorMode = draft.editorMode || 'wysiwyg';
  if (editorMode === 'markdown') {
    document.getElementById('editor-source').value = draft.bodyMarkdown || '';
  } else if (draft.bodyHtml) {
    setEditorHtml(document.getElementById('editor'), draft.bodyHtml);
  }
  applyEditorModeUI();
  return true;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl: 'https://dashboard.erinskidds.com',
        apiKey: 'a2369d061fa3dabb8e4da02b12a9c5d591264c7e5f59bfd70ac4c2450bcf6042',
        defaultFolder: 'Quick Notes',
        defaultList: 'Inbox',
        defaultCalendar: 'Calendar',
        aiEnabled: true,
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

  // A capture always writes into the WYSIWYG surface directly, so force
  // that surface to be the visible/current one first.
  if (editorMode !== 'wysiwyg') { editorMode = 'wysiwyg'; applyEditorModeUI(); }
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

  // Checklist — same minimal markup as the dashboard's editor. A nested
  // contenteditable span here previously caused clicking a checkbox to
  // disable every checkbox in the note; a plain <li> with an inline
  // checkbox doesn't have that problem because there's nothing nested.
  document.getElementById('btn-checklist').addEventListener('mousedown', (e) => {
    e.preventDefault();
    editor.focus();
    document.execCommand('insertHTML', false, '<ul><li><input type="checkbox"> </li></ul>');
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

  // WYSIWYG <-> markdown-source toggle
  document.getElementById('btn-source-toggle').addEventListener('click', () => {
    setEditorMode(editorMode === 'markdown' ? 'wysiwyg' : 'markdown');
  });
  document.getElementById('editor-source').addEventListener('input', scheduleDraftSave);
}

// Switches the editing surface and converts content across, matching the
// dashboard's MarkdownEditor exactly (marked/turndown, same rules). Either
// surface is just a way to type — see the submit handler for where this
// always resolves back down to HTML regardless of which one was used.
function setEditorMode(mode) {
  const editor = document.getElementById('editor');
  const source = document.getElementById('editor-source');
  if (mode === editorMode) return;

  if (mode === 'markdown') {
    source.value = htmlToMarkdown(editor.innerHTML);
  } else {
    setEditorHtml(editor, markdownToHtml(source.value));
  }
  editorMode = mode;
  applyEditorModeUI();
  scheduleDraftSave();
}

// Applies the current editorMode to the DOM without converting anything —
// used after a draft restore, where the right surface already has the right
// content and a conversion would be redundant (or lossy, going markdown ->
// html -> markdown again for no reason).
function applyEditorModeUI() {
  const isMarkdown = editorMode === 'markdown';
  document.getElementById('editor').classList.toggle('hidden', isMarkdown);
  document.getElementById('editor-source').classList.toggle('hidden', !isMarkdown);
  document.getElementById('btn-source-toggle').classList.toggle('active', isMarkdown);
  document.getElementById('btn-source-toggle').textContent = isMarkdown ? 'Editor' : 'Markdown';
  // Only the mode toggle itself stays usable in markdown mode — formatting
  // buttons act on the WYSIWYG surface, which isn't what's on screen.
  document.querySelectorAll('.toolbar button, .toolbar select').forEach((el) => {
    if (el.id !== 'btn-source-toggle') el.disabled = isMarkdown;
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
  applyEditorModeUI();
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
  ['endDate-date', 'endDate-time'].forEach((id) => document.getElementById(id).addEventListener('input', () => {
    document.getElementById('endDate-date').classList.remove('input-error');
    document.getElementById('endDate-time').classList.remove('input-error');
    document.getElementById('endDate-label').classList.remove('label-error');
  }));
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
    // Whichever surface was used to type, the wire format is always HTML —
    // markdown mode just converts on the way out.
    const bodyHtml = (editorMode === 'markdown'
      ? markdownToHtml(document.getElementById('editor-source').value)
      : editor.innerHTML
    ).trim();
    const secondary = document.getElementById('secondary').value.trim() ||
      (currentType === 'note' ? 'Notes' : SECONDARY_LABEL[currentType]);
    const btn = document.getElementById('submit-btn');

    const endDateInput = document.getElementById('endDate-date');
    const endDateTimeInput = document.getElementById('endDate-time');
    const endDateLabel = document.getElementById('endDate-label');
    endDateInput.classList.remove('input-error');
    endDateTimeInput.classList.remove('input-error');
    endDateLabel.classList.remove('label-error');

    if (!title) { setStatus('Title is required.', true); return; }
    if (!apiKey) { setStatus('API key not configured.', true); return; }
    if (currentType === 'event' && !document.getElementById('startDate-date').value) {
      setStatus('Start date is required for events.', true);
      return;
    }
    // The Shortcut's "Add New Event" action requires both dates.
    if (currentType === 'event' && !endDateInput.value) {
      endDateInput.classList.add('input-error');
      endDateTimeInput.classList.add('input-error');
      endDateLabel.classList.add('label-error');
      endDateInput.focus();
      setStatus('End date is required for events.', true);
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
          notes: bodyHtml,
          list: secondary,
          dueDate: combineDateTime('dueDate'),
          priority: document.getElementById('priority').value,
        };
      } else {
        payload = {
          title,
          notes: bodyHtml,
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
      document.getElementById('editor-source').value = '';
      if (editorMode !== 'wysiwyg') { editorMode = 'wysiwyg'; applyEditorModeUI(); }
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
