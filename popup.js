import { createEditor } from './editor.js';

// The editor is the shared component from the dashboard — same toolbar,
// same markdown toggle, same checklist behaviour, same styles. Its value is
// always markdown, which is also what gets queued and what Notes is sent.
let editorApi = null;

let pendingFiles = [];
const pendingAttachmentIds = new Map();
let currentType = 'note';

// Attachment blobs cannot be safely stored in chrome.storage.local as Files.
// Keep the actual bytes in extension-owned IndexedDB and store only metadata/
// IDs in the short-lived draft. Popup, tab, and side-panel surfaces share this
// extension origin, so the same draft attachments are available everywhere.
const ATTACHMENT_DB_NAME = 'apple-queue-drafts';
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_STORE = 'attachments';

function openAttachmentDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) {
        db.createObjectStore(ATTACHMENT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putAttachmentBlob(id, file) {
  const db = await openAttachmentDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACHMENT_STORE, 'readwrite');
      tx.objectStore(ATTACHMENT_STORE).put(file, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getAttachmentBlob(id) {
  const db = await openAttachmentDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACHMENT_STORE, 'readonly');
      const request = tx.objectStore(ATTACHMENT_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function deleteAttachmentBlob(id) {
  if (!id) return;
  const db = await openAttachmentDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACHMENT_STORE, 'readwrite');
      tx.objectStore(ATTACHMENT_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function clearPendingAttachmentBlobs() {
  const ids = [...new Set(pendingFiles.map((file) => pendingAttachmentIds.get(file)).filter(Boolean))];
  await Promise.allSettled(ids.map((id) => deleteAttachmentBlob(id)));
  pendingAttachmentIds.clear();
}

const SECONDARY_LABEL = {
  note: 'Folder',
  reminder: 'List',
  event: 'Calendar',
};

const SECONDARY_DEFAULT_KEY = {
  note: 'defaultFolder',
  reminder: 'defaultList',
  event: 'defaultCalendar',
};

const BODY_LABEL = {
  note: 'Body',
  reminder: 'Notes',
  event: 'Notes',
};

const HEADER_TITLE = {
  note: '🍎 Apple Notes',
  reminder: '✅ Reminders',
  event: '📅 Calendar',
};

const ENDPOINT = {
  note: '/api/apple-notes',
  reminder: '/api/reminders',
  event: '/api/calendar',
};

// Firefox/Chrome extension popups render the native datetime-local calendar
// widget behind the popup itself, so date and time are split into separate
// inputs and combined here instead.
function combineDateTime(prefix, dateOnlyWhenTimeIsBlank = false) {
  const date = document.getElementById(`${prefix}-date`).value;
  const time = document.getElementById(`${prefix}-time`).value;

  if (!date) return '';
  if (!time && dateOnlyWhenTimeIsBlank) return date;

  return `${date}T${time || '00:00'}`;
}

function clearDateTime(prefix) {
  document.getElementById(`${prefix}-date`).value = '';
  document.getElementById(`${prefix}-time`).value = '';
}

function localTodayDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The Reminder Shortcut expects a due/alert date. New reminders therefore
// start with today's local date, while the time remains genuinely blank.
function ensureReminderDueDateDefault() {
  const dateInput = document.getElementById('dueDate-date');
  const timeInput = document.getElementById('dueDate-time');
  if (!dateInput || dateInput.value) return;

  dateInput.value = localTodayDate();
  if (timeInput) timeInput.value = '';
}

// Each visible white icon is a real button. Calling showPicker() from that
// user gesture opens Chrome's native browser/OS date or time picker reliably.
function setupNativeDateTimePickers() {
  document.querySelectorAll('[data-picker-target]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const input = document.getElementById(button.dataset.pickerTarget || '');
      if (!input) return;

      try {
        if (typeof input.showPicker === 'function') {
          input.showPicker();
          return;
        }
      } catch (error) {
        console.warn('Could not open the native date/time picker', error);
      }

      input.focus({ preventScroll: true });
      input.click();
    });
  });
}

// ── Draft persistence ────────────────────────────────────────────────────────

const DRAFT_KEY = 'draft';
const DRAFT_TTL_MS = 2 * 60 * 1000; // Remember the last-opened draft for 2 minutes.

const DRAFT_FIELDS = [
  'title',
  'secondary',
  'priority',
  'reminder-url',
  'location',
  'event-url',
  'invitees',
  'dueDate-date',
  'dueDate-time',
  'startDate-date',
  'startDate-time',
  'endDate-date',
  'endDate-time',
];

function getDraftState() {
  const state = {
    type: currentType,
    editorMode: editorApi ? editorApi.getMode() : 'markdown',
    bodyMarkdown: editorApi ? editorApi.getValue() : '',
    savedAt: Date.now(),
    attachments: pendingFiles.map((file) => ({
      id: pendingAttachmentIds.get(file) || '',
      name: file.name || 'attachment',
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now(),
    })).filter((item) => item.id),
  };

  for (const id of DRAFT_FIELDS) {
    const el = document.getElementById(id);

    if (el) {
      state[id] = el.value;
    }
  }

  state.allDay =
    document.getElementById('allDay').checked;

  return state;
}

let draftSaveTimer = null;
let draftPersistenceEnabled = true;

function saveDraftNow() {
  if (!draftPersistenceEnabled) return Promise.resolve();
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DRAFT_KEY]: getDraftState() }, resolve);
  });
}

function scheduleDraftSave() {
  draftPersistenceEnabled = true;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    saveDraftNow();
  }, 250);
}

async function clearDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  draftPersistenceEnabled = false;

  // Remove blobs referenced by both the live File list and the last saved draft.
  const stored = await new Promise((resolve) => chrome.storage.local.get(DRAFT_KEY, resolve));
  const draftItems = Array.isArray(stored?.[DRAFT_KEY]?.attachments)
    ? stored[DRAFT_KEY].attachments
    : [];
  const savedIds = draftItems.map((item) => item?.id).filter(Boolean);
  const liveIds = pendingFiles.map((file) => pendingAttachmentIds.get(file)).filter(Boolean);
  await Promise.allSettled([...new Set([...savedIds, ...liveIds])].map(deleteAttachmentBlob));
  pendingAttachmentIds.clear();

  await new Promise((resolve) => chrome.storage.local.remove(DRAFT_KEY, resolve));
}

async function restoreDraftAttachments(draft) {
  pendingFiles = [];
  pendingAttachmentIds.clear();

  const items = Array.isArray(draft?.attachments) ? draft.attachments : [];
  for (const item of items) {
    if (!item?.id) continue;
    try {
      const blob = await getAttachmentBlob(item.id);
      if (!blob) continue;
      const file = new File(
        [blob],
        item.name || 'attachment',
        {
          type: item.type || blob.type || 'application/octet-stream',
          lastModified: Number(item.lastModified || Date.now()),
        }
      );
      pendingFiles.push(file);
      pendingAttachmentIds.set(file, item.id);
    } catch (error) {
      console.warn('Could not restore draft attachment', item.id, error);
    }
  }

  renderChips();
}

async function restoreDraft(settings) {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      DRAFT_KEY,
      resolve
    )
  );

  const draft = stored[DRAFT_KEY];

  if (!draft) {
    return false;
  }

  // Old drafts should not keep stale page title/URL around indefinitely.
  // Drafts from builds before this timestamp existed are treated as expired.
  const savedAt = Number(draft.savedAt || 0);
  if (!savedAt || Date.now() - savedAt > DRAFT_TTL_MS) {
    const oldItems = Array.isArray(draft.attachments) ? draft.attachments : [];
    await Promise.allSettled(oldItems.map((item) => deleteAttachmentBlob(item?.id)));
    chrome.storage.local.remove(DRAFT_KEY);
    return false;
  }

  await setType(
    draft.type || 'note',
    settings
  );

  for (const id of DRAFT_FIELDS) {
    const el =
      document.getElementById(id);

    if (
      el &&
      draft[id] !== undefined
    ) {
      el.value = draft[id];
    }
  }

  document.getElementById('allDay').checked =
    !!draft.allDay;

  if ((draft.type || 'note') === 'reminder') {
    ensureReminderDueDateDefault();
  }

  if (editorApi) {
    editorApi.setMode(
      draft.editorMode === 'wysiwyg'
        ? 'wysiwyg'
        : 'markdown'
    );

    editorApi.setValue(
      editorApi.markdown.toMarkdown(
        draft.bodyMarkdown ||
        draft.bodyHtml ||
        ''
      )
    );

    if ((draft.type || 'note') === 'reminder') {
      moveCapturedUrlOutOfBody('reminder');
    }
  }

  await restoreDraftAttachments(draft);
  return true;
}

// ── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl:
          'https://dashboard.erinskidds.com',

        // A fresh installation must be configured by the user. Never ship a
        // working API key inside the extension package.
        apiKey:
          '',

        defaultFolder:
          'Quick Notes',

        defaultList:
          'Inbox',

        defaultCalendar:
          'Calendar',

        aiEnabled:
          true,
        aiProvider:
          'openai',
        aiModel:
          '',
        aiBaseUrl:
          'http://localhost:11434',
      },
      (syncSettings) => {
        chrome.storage.local.get({ aiApiKey: '' }, (localSettings) => {
          resolve({ ...syncSettings, aiApiKey: localSettings.aiApiKey || '' });
        });
      }
    );
  });
}

// ── Status ──────────────────────────────────────────────────────────────────

function setStatus(
  msg,
  isError = false
) {
  const el =
    document.getElementById('status');

  el.textContent = msg;

  el.className =
    'status ' +
    (isError ? 'err' : 'ok');
}

// ── Attachments ──────────────────────────────────────────────────────────────

function isSupportedAttachment(file, type = currentType) {
  if (!file) return false;
  if (type === 'reminder') return file.type.startsWith('image/');
  // Notes accept any browser-provided File. The backend stores the bytes and
  // returns a URL, so unsupported preview formats can still be opened/downloaded.
  if (type === 'note') return true;
  return false;
}

function filesForCurrentType() {
  return pendingFiles.filter((file) => isSupportedAttachment(file));
}

function renderChips() {
  const container = document.getElementById('file-chips');
  container.innerHTML = '';

  pendingFiles.forEach((f, i) => {
    if (!isSupportedAttachment(f)) return;

    const chip = document.createElement('div');
    chip.className = 'chip';

    const label = document.createElement('span');
    label.textContent = `${f.type.startsWith('image/') ? '🖼️' : '📄'} ${f.name}`;
    chip.appendChild(label);

    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.onclick = async () => {
      const removed = pendingFiles[i];
      const id = pendingAttachmentIds.get(removed);
      pendingFiles.splice(i, 1);
      pendingAttachmentIds.delete(removed);
      await deleteAttachmentBlob(id).catch(() => {});
      renderChips();
      scheduleDraftSave();
    };

    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

async function addFiles(files, source = 'picker') {
  if (!files) return 0;

  let added = 0;
  let rejected = 0;

  for (const [index, inputFile] of Array.from(files).entries()) {
    let file = inputFile;

    // Clipboard image blobs sometimes arrive without a useful filename.
    if (file && !file.name && file.type.startsWith('image/')) {
      const ext = file.type.split('/')[1] || 'png';
      file = new File(
        [file],
        `clipboard-${Date.now()}-${index + 1}.${ext}`,
        { type: file.type, lastModified: Date.now() }
      );
    }

    if (!isSupportedAttachment(file)) {
      rejected += 1;
      continue;
    }

    const id = crypto.randomUUID();
    try {
      await putAttachmentBlob(id, file);
      pendingFiles.push(file);
      pendingAttachmentIds.set(file, id);
      added += 1;
    } catch (error) {
      console.error('Could not persist draft attachment', error);
      rejected += 1;
    }
  }

  renderChips();

  if (added > 0) {
    // Save attachment metadata immediately so switching to the side panel or
    // reopening the popup keeps the same files during the 2-minute draft TTL.
    await saveDraftNow();
  }

  if (rejected > 0) {
    setStatus(
      currentType === 'reminder'
        ? 'Reminders only accept pasted/attached images.'
        : 'One or more files could not be attached.',
      true
    );
  } else if (added > 0 && source === 'clipboard') {
    setStatus(`${added} clipboard attachment${added === 1 ? '' : 's'} added.`);
  }

  return added;
}

async function uploadPendingAttachments(settings, apiKey) {
  const attachments = [];
  const files = filesForCurrentType();

  for (const file of files) {
    setStatus(`Uploading ${file.name}…`);

    const data = await uploadFile(
      settings.serverUrl,
      apiKey,
      file,
      (percent) => {
        setStatus(`Uploading ${file.name}… ${percent}%`);
      }
    );

    attachments.push({
      name: data.name,
      url: data.url,
      mimeType: data.mimeType,
    });
  }

  return attachments;
}

/*
 * Upload one attachment.
 *
 * Important:
 * A stalled fetch used to leave the extension showing
 * "Uploading files…" forever. We now abort after 60 seconds.
 */
async function uploadFile(
  serverUrl,
  apiKey,
  file,
  onProgress = null
) {
  const fd = new FormData();
  fd.append('file', file);

  // XMLHttpRequest gives the extension a real network-level timeout and
  // upload progress. A stalled request can no longer sit in Pending forever.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const baseUrl = String(serverUrl || '').replace(/\/+$/, '');

    xhr.open(
      'POST',
      `${baseUrl}/api/apple-notes/upload`,
      true
    );

    xhr.setRequestHeader(
      'x-api-key',
      apiKey
    );

    // Hard cap for the complete upload request, including waiting for the
    // server response after the file bytes have finished sending.
    xhr.timeout = 60_000;

    xhr.upload.onprogress = (event) => {
      if (
        typeof onProgress === 'function' &&
        event.lengthComputable
      ) {
        const percent = Math.min(
          100,
          Math.round((event.loaded / event.total) * 100)
        );

        onProgress(percent);
      }
    };

    xhr.onload = () => {
      let data = {};

      try {
        data = xhr.responseText
          ? JSON.parse(xhr.responseText)
          : {};
      } catch {
        data = {};
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }

      reject(
        new Error(
          data.error ||
          `Upload failed: ${file.name} (HTTP ${xhr.status})`
        )
      );
    };

    xhr.ontimeout = () => {
      reject(
        new Error(
          `Upload timed out after 60 seconds: ${file.name}`
        )
      );
    };

    xhr.onerror = () => {
      reject(
        new Error(
          `Network error while uploading ${file.name}`
        )
      );
    };

    xhr.onabort = () => {
      reject(
        new Error(
          `Upload cancelled: ${file.name}`
        )
      );
    };

    xhr.send(fd);
  });
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 30_000
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      );
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Natural-language capture ────────────────────────────────────────────────

let userPickedType = false;

function localNow() {
  const d =
    new Date();

  const p = (n) =>
    String(n).padStart(
      2,
      '0'
    );

  return (
    `${d.getFullYear()}-` +
    `${p(d.getMonth() + 1)}-` +
    `${p(d.getDate())}T` +
    `${p(d.getHours())}:` +
    `${p(d.getMinutes())}`
  );
}

function setDateTime(
  prefix,
  value
) {
  const dateEl =
    document.getElementById(
      `${prefix}-date`
    );

  const timeEl =
    document.getElementById(
      `${prefix}-time`
    );

  if (!value) {
    dateEl.value = '';
    timeEl.value = '';
    return;
  }

  const [date, time] =
    value.split('T');

  dateEl.value =
    date || '';

  timeEl.value =
    time || '';
}

function setAiStatus(
  msg,
  kind = ''
) {
  const el =
    document.getElementById(
      'ai-status'
    );

  el.textContent = msg;
  el.className = kind;
}

async function applyCapture(
  capture,
  settings
) {
  await setType(
    capture.type,
    settings
  );

  document.getElementById(
    'title'
  ).value =
    capture.title || '';

  if (capture.container) {
    document.getElementById(
      'secondary'
    ).value =
      capture.container;
  }

  if (editorApi) {
    editorApi.setValue(
      capture.body || ''
    );

    if (capture.type === 'reminder') {
      moveCapturedUrlOutOfBody('reminder');
    }
  }

  setDateTime(
    'dueDate',
    capture.dueDate
  );

  if (capture.type === 'reminder') {
    ensureReminderDueDateDefault();
  }

  setDateTime(
    'startDate',
    capture.startDate
  );

  setDateTime(
    'endDate',
    capture.endDate
  );

  document.getElementById(
    'priority'
  ).value =
    capture.priority || 'none';

  document.getElementById(
    'allDay'
  ).checked =
    !!capture.allDay;

  document.getElementById(
    'location'
  ).value =
    capture.location || '';

  document.getElementById('event-url').value =
    capture.url || capture.eventUrl || '';

  document.getElementById('invitees').value =
    Array.isArray(capture.invitees) ? capture.invitees.join(', ') : (capture.invitees || '');

  scheduleDraftSave();
}

function setupAi(settings) {
  const section =
    document.getElementById(
      'ai-section'
    );

  section.classList.toggle(
    'hidden',
    !settings.aiEnabled
  );

  if (!settings.aiEnabled) {
    return;
  }

  const input =
    document.getElementById(
      'ai-input'
    );

  const btn =
    document.getElementById(
      'ai-parse-btn'
    );

  async function parse() {
    const text =
      input.value.trim();

    if (!text) {
      setAiStatus(
        'Type something to parse first.',
        'err'
      );

      return;
    }

    if (!settings.apiKey) {
      setAiStatus(
        'API key not configured.',
        'err'
      );

      return;
    }

    btn.disabled = true;

    setAiStatus(
      'Thinking…',
      'busy'
    );

    try {
      const res =
        await fetchWithTimeout(
          `${settings.serverUrl}/api/ai/parse`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',

              'x-api-key':
                settings.apiKey,
            },

            body: JSON.stringify({
              text,

              now:
                localNow(),

              ...(userPickedType
                ? {
                    type:
                      currentType,
                  }
                : {}),

              folders:
                [
                  settings.defaultFolder,
                ].filter(Boolean),

              lists:
                [
                  settings.defaultList,
                ].filter(Boolean),

              calendars:
                [
                  settings.defaultCalendar,
                ].filter(Boolean),

              ai: {
                provider: settings.aiProvider || 'openai',
                model: settings.aiModel || '',
                apiKey: settings.aiApiKey || '',
                baseUrl: settings.aiBaseUrl || '',
              },
            }),
          },
          90_000
        );

      const data =
        await res
          .json()
          .catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          data.error ||
          `HTTP ${res.status}`
        );
      }

      await applyCapture(
        data.capture,
        settings
      );

      const secs =
        data.ms
          ? ` in ${(data.ms / 1000).toFixed(1)}s`
          : '';

      setAiStatus(
        `✓ Filled in below — check it over${secs}.`,
        'ok'
      );

      input.value = '';
    } catch (err) {
      setAiStatus(
        err.message,
        'err'
      );
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener(
    'click',
    parse
  );

  input.addEventListener(
    'keydown',
    (e) => {
      if (
        e.key === 'Enter' &&
        !e.shiftKey
      ) {
        e.preventDefault();
        parse();
      }
    }
  );
}

// ── Type switching ──────────────────────────────────────────────────────────

// Move a captured page URL out of the Notes body and into the type-specific
// URL field. Active-tab prefill is stored as a Markdown link.
function moveCapturedUrlOutOfBody(type = currentType) {
  if (!editorApi) return;

  const targetId = type === 'reminder' ? 'reminder-url' : type === 'event' ? 'event-url' : '';
  if (!targetId) return;

  const urlInput = document.getElementById(targetId);
  if (!urlInput || urlInput.value.trim()) return;

  const body = editorApi.getValue();
  if (!body) return;

  const markdownMatch = body.match(/(?:^|\n\s*\n)\[([^\]\s]+)\]\(\1\)\s*$/);
  const plainMatch = body.match(/(?:^|\n\s*\n)(https?:\/\/\S+)\s*$/);
  const match = markdownMatch || plainMatch;
  if (!match) return;

  urlInput.value = match[1];
  editorApi.setValue(body.slice(0, match.index).trimEnd());
}

function setType(
  type,
  settings
) {
  currentType = type;

  document
    .querySelectorAll(
      '.type-tab'
    )
    .forEach((tab) => {
      tab.classList.toggle(
        'active',
        tab.dataset.type === type
      );
    });

  document.getElementById(
    'header-title'
  ).innerHTML =
    HEADER_TITLE[type];

  document.getElementById(
    'secondary-label'
  ).textContent =
    SECONDARY_LABEL[type];

  document.getElementById(
    'secondary'
  ).value =
    settings[
      SECONDARY_DEFAULT_KEY[type]
    ] || '';

  document.getElementById(
    'body-label'
  ).textContent =
    BODY_LABEL[type];

  document.getElementById(
    'reminder-fields'
  ).classList.toggle(
    'hidden',
    type !== 'reminder'
  );

  document.getElementById(
    'event-fields'
  ).classList.toggle(
    'hidden',
    type !== 'event'
  );

  const attachmentsSection = document.getElementById('attachments-section');
  const attachmentsLabel = document.getElementById('attachments-label');
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');

  attachmentsSection.classList.toggle('hidden', type === 'event');

  if (type === 'reminder') {
    ensureReminderDueDateDefault();
    attachmentsLabel.innerHTML = 'Images <span style="color:#475569">(reminders only accept images)</span>';
    fileInput.accept = 'image/*';
    dropZone.textContent = 'Drop, paste, or click to attach images';
  } else if (type === 'note') {
    attachmentsLabel.innerHTML = 'Attachments <span style="color:#475569">(any file)</span>';
    fileInput.removeAttribute('accept');
    dropZone.textContent = 'Drop, paste, or click to attach any file';
  }

  renderChips();

  if (type === 'reminder' || type === 'event') {
    moveCapturedUrlOutOfBody(type);
  }

  setStatus('');
}

// ── Google Places address autocomplete ─────────────────────────────────────

function setupPlaceAutocomplete(settings) {
  const input = document.getElementById('location');
  const box = document.getElementById('place-suggestions');
  if (!input || !box) return;

  let timer = null;
  let requestSeq = 0;

  const hide = () => {
    box.classList.add('hidden');
    box.innerHTML = '';
  };

  const message = (text, isError = false) => {
    box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'place-message' + (isError ? ' err' : '');
    row.textContent = text;
    box.appendChild(row);
    box.classList.remove('hidden');
  };

  const normaliseSuggestion = (item) => {
    if (typeof item === 'string') return item;
    return (
      item?.text ||
      item?.description ||
      item?.formattedAddress ||
      item?.placePrediction?.text?.text ||
      item?.placePrediction?.structuredFormat?.mainText?.text ||
      ''
    );
  };

  const render = (items) => {
    const texts = items.map(normaliseSuggestion).filter(Boolean);
    box.innerHTML = '';
    if (!texts.length) {
      message('No matching addresses found.');
      return;
    }

    texts.slice(0, 5).forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'place-suggestion';
      btn.textContent = text;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        input.value = text;
        hide();
        scheduleDraftSave();
      });
      box.appendChild(btn);
    });

    const credit = document.createElement('div');
    credit.className = 'place-google';
    credit.textContent = 'Powered by Google';
    box.appendChild(credit);
    box.classList.remove('hidden');
  };

  input.addEventListener('input', () => {
    scheduleDraftSave();
    clearTimeout(timer);

    const q = input.value.trim();
    if (q.length < 3 || /^https?:\/\//i.test(q)) {
      hide();
      return;
    }

    const seq = ++requestSeq;
    message('Searching addresses…');

    timer = setTimeout(async () => {
      try {
        const base = String(settings.serverUrl || '').replace(/\/+$/, '');
        const res = await fetchWithTimeout(`${base}/api/places/autocomplete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.apiKey,
          },
          body: JSON.stringify({ input: q }),
        }, 8_000);

        const data = await res.json().catch(() => ({}));
        if (seq !== requestSeq) return;

        if (!res.ok) {
          message(data.error || `Address search failed (HTTP ${res.status}).`, true);
          return;
        }

        const suggestions = Array.isArray(data.suggestions)
          ? data.suggestions
          : Array.isArray(data.predictions)
            ? data.predictions
            : [];

        render(suggestions);
      } catch (err) {
        if (seq !== requestSeq) return;
        message(err?.message || 'Address search failed.', true);
      }
    }, 250);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 3 && box.innerHTML) {
      box.classList.remove('hidden');
    }
  });

  input.addEventListener('blur', () => setTimeout(hide, 180));
}

// ── Expanded view ───────────────────────────────────────────────────────────

const surface =
  new URLSearchParams(
    location.search
  ).get('surface');

const isExpandedSurface =
  surface === 'sidebar' ||
  surface === 'tab';

async function openExpanded() {
  // Flush the current draft before moving from popup to side panel/tab.
  await saveDraftNow();
  try {
    if (
      typeof browser !==
        'undefined' &&
      browser.sidebarAction
    ) {
      await browser.sidebarAction.open();
      window.close();
      return;
    }
  } catch {
    // Sidebar unavailable.
  }

  try {
    if (chrome.sidePanel) {
      const win =
        await chrome.windows
          .getCurrent();

      await chrome.sidePanel
        .setOptions({
          path:
            'popup.html?surface=sidebar',

          enabled:
            true,
        });

      await chrome.sidePanel.open({
        windowId:
          win.id,
      });

      window.close();

      return;
    }
  } catch {
    // Side panel unavailable.
  }

  chrome.tabs.create({
    url:
      chrome.runtime.getURL(
        'popup.html?surface=tab'
      ),
  });

  window.close();
}

// Flush short-lived draft state when the popup/surface is being hidden. This
// complements the normal debounce and helps preserve attachments/body if Chrome
// closes the popup before the timer fires.
window.addEventListener('pagehide', () => {
  if (editorApi) saveDraftNow();
});

// ── Main initialization ─────────────────────────────────────────────────────

document.addEventListener(
  'DOMContentLoaded',
  async () => {
    const settings =
      await getSettings();

    const { apiKey } =
      settings;

    const openSettings = (event) => {
      event?.preventDefault();
      chrome.runtime.openOptionsPage();
    };

    // Settings must remain reachable even when the rest of the extension is
    // locked behind initial API-key setup.
    document
      .getElementById('settings-link')
      ?.addEventListener('click', openSettings);

    document
      .getElementById('settings-link-2')
      ?.addEventListener('click', openSettings);

    const expandLink =
      document.getElementById(
        'expand-link'
      );

    if (!String(apiKey || '').trim()) {
      document.body.classList.add('setup-required');

      document.getElementById(
        'no-key'
      ).style.display =
        'block';

      document.getElementById(
        'main-form'
      ).style.display =
        'none';

      // Opening the Side Panel before setup would only show the same blocked
      // form, so keep the first-run screen focused on the required action.
      if (expandLink) expandLink.style.display = 'none';

      return;
    }

    if (isExpandedSurface) {
      expandLink.style.display =
        'none';

      document.body.classList.add(
        'expanded'
      );
    } else {
      expandLink.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          openExpanded();
        }
      );
    }

    // Initialize shared editor.
    editorApi =
      createEditor(
        document.getElementById(
          'editor-mount'
        ),
        {
          marked,
          TurndownService,

          placeholder:
            'Content…',

          mode:
            'markdown',

          minHeight:
            150,

          onChange:
            scheduleDraftSave,
        }
      );

    setupAi(settings);
    setupPlaceAutocomplete(settings);
    setupNativeDateTimePickers();

    // Type tabs.
    document
      .querySelectorAll(
        '.type-tab'
      )
      .forEach((tab) => {
        tab.addEventListener(
          'click',
          () => {
            userPickedType = true;

            setType(
              tab.dataset.type,
              settings
            );
          }
        );
      });

    await setType(
      'note',
      settings
    );

    const draftRestored =
      await restoreDraft(
        settings
      );

    if (!draftRestored) {
      let tab;

      try {
        [tab] =
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
      } catch {
        // No active tab.
      }

      if (tab?.title) {
        document.getElementById(
          'title'
        ).value =
          tab.title;
      }

      let selectedText = '';

      try {
        const [result] =
          await chrome.scripting
            .executeScript({
              target: {
                tabId:
                  tab.id,
              },

              func: () =>
                window
                  .getSelection()
                  ?.toString() ||
                '',
            });

        selectedText =
          result?.result || '';
      } catch {
        // Selection unavailable.
      }

      const prefill = [];

      if (selectedText) {
        prefill.push(
          selectedText
        );
      }

      if (tab?.url) {
        prefill.push(
          `[${tab.url}](${tab.url})`
        );
      }

      if (prefill.length) {
        editorApi.setValue(
          prefill.join('\n\n')
        );

        // If Reminder is already active, immediately move the captured page
        // URL into its dedicated field instead of leaving it in Notes.
        if (currentType === 'reminder' || currentType === 'event') {
          moveCapturedUrlOutOfBody(currentType);
        }
      }

      // Remember this freshly captured tab for a short window. If Apple Queue
      // is reopened within 2 minutes, keep this draft; after that the savedAt
      // check above expires it and the current tab is captured instead.
      scheduleDraftSave();
    }

    // Draft autosave.
    document
      .getElementById('title')
      .addEventListener(
        'input',
        scheduleDraftSave
      );

    document
      .getElementById('secondary')
      .addEventListener(
        'input',
        scheduleDraftSave
      );

    document
      .getElementById('location')
      .addEventListener(
        'input',
        scheduleDraftSave
      );

    document
      .getElementById('event-url')
      .addEventListener('input', scheduleDraftSave);

    document
      .getElementById('invitees')
      .addEventListener('input', scheduleDraftSave);

    document
      .getElementById('reminder-url')
      .addEventListener(
        'input',
        scheduleDraftSave
      );

    document
      .getElementById('priority')
      .addEventListener(
        'change',
        scheduleDraftSave
      );

    document
      .getElementById('allDay')
      .addEventListener(
        'change',
        scheduleDraftSave
      );

    [
      'dueDate-date',
      'dueDate-time',
      'startDate-date',
      'startDate-time',
      'endDate-date',
      'endDate-time',
    ].forEach((id) => {
      document
        .getElementById(id)
        .addEventListener(
          'change',
          scheduleDraftSave
        );
    });

    [
      'endDate-date',
      'endDate-time',
    ].forEach((id) => {
      document
        .getElementById(id)
        .addEventListener(
          'input',
          () => {
            document
              .getElementById(
                'endDate-date'
              )
              .classList.remove(
                'input-error'
              );

            document
              .getElementById(
                'endDate-time'
              )
              .classList.remove(
                'input-error'
              );

            document
              .getElementById(
                'endDate-label'
              )
              .classList.remove(
                'label-error'
              );
          }
        );
    });

    document
      .querySelectorAll(
        '.type-tab'
      )
      .forEach((tab) => {
        tab.addEventListener(
          'click',
          scheduleDraftSave
        );
      });

    // File input.
    const dropZone =
      document.getElementById(
        'drop-zone'
      );

    const fileInput =
      document.getElementById(
        'file-input'
      );

    dropZone.addEventListener(
      'click',
      () =>
        fileInput.click()
    );

    dropZone.addEventListener(
      'dragover',
      (e) =>
        e.preventDefault()
    );

    dropZone.addEventListener(
      'drop',
      async (e) => {
        e.preventDefault();
        await addFiles(e.dataTransfer.files);
      }
    );

    fileInput.addEventListener(
      'change',
      async () => {
        await addFiles(fileInput.files);
        fileInput.value = '';
      }
    );

    // Paste clipboard files/images anywhere in the extension to attach them.
    // Plain-text paste is untouched, so Markdown/editor paste still behaves normally.
    document.addEventListener('paste', async (e) => {
      if (currentType === 'event') return;

      const clipboardFiles = e.clipboardData?.files;
      if (!clipboardFiles || clipboardFiles.length === 0) return;

      // Prevent duplicate insertion into the editor while the file is being
      // persisted as a draft attachment.
      e.preventDefault();
      await addFiles(clipboardFiles, 'clipboard');
    });

    // Submit.
    document
      .getElementById(
        'submit-btn'
      )
      .addEventListener(
        'click',
        async () => {
          const title =
            document
              .getElementById(
                'title'
              )
              .value
              .trim();

          const body =
            editorApi
              ? editorApi
                  .getValue()
                  .trim()
              : '';

          const secondary =
            document
              .getElementById(
                'secondary'
              )
              .value
              .trim() ||
            (
              currentType === 'note'
                ? 'Notes'
                : SECONDARY_LABEL[
                    currentType
                  ]
            );

          const btn =
            document.getElementById(
              'submit-btn'
            );

          const endDateInput =
            document.getElementById(
              'endDate-date'
            );

          const endDateTimeInput =
            document.getElementById(
              'endDate-time'
            );

          const endDateLabel =
            document.getElementById(
              'endDate-label'
            );

          endDateInput.classList.remove(
            'input-error'
          );

          endDateTimeInput.classList.remove(
            'input-error'
          );

          endDateLabel.classList.remove(
            'label-error'
          );

          if (!title) {
            setStatus(
              'Title is required.',
              true
            );

            return;
          }

          if (!apiKey) {
            setStatus(
              'API key not configured.',
              true
            );

            return;
          }

          if (currentType === 'reminder') {
            ensureReminderDueDateDefault();
          }

          if (
            currentType ===
              'event' &&
            !document.getElementById(
              'startDate-date'
            ).value
          ) {
            setStatus(
              'Start date is required for events.',
              true
            );

            return;
          }

          if (
            currentType ===
              'event' &&
            !endDateInput.value
          ) {
            endDateInput.classList.add(
              'input-error'
            );

            endDateTimeInput.classList.add(
              'input-error'
            );

            endDateLabel.classList.add(
              'label-error'
            );

            endDateInput.focus();

            setStatus(
              'End date is required for events.',
              true
            );

            return;
          }

          btn.disabled = true;

          setStatus('');

          try {
            let payload;

            if (
              currentType ===
              'note'
            ) {
              const attachments = await uploadPendingAttachments(settings, apiKey);

              payload = {
                title,
                body,
                folder:
                  secondary,

                attachments,
              };
            } else if (
              currentType ===
              'reminder'
            ) {
              const attachments = await uploadPendingAttachments(settings, apiKey);

              payload = {
                title,

                notes:
                  body,

                list:
                  secondary,

                dueDate:
                  combineDateTime(
                    'dueDate',
                    true
                  ),

                url:
                  document
                    .getElementById(
                      'reminder-url'
                    )
                    .value
                    .trim(),

                attachments,

                priority:
                  document.getElementById(
                    'priority'
                  ).value,
              };
            } else {
              payload = {
                title,

                notes:
                  body,

                calendar:
                  secondary,

                startDate:
                  combineDateTime(
                    'startDate'
                  ),

                endDate:
                  combineDateTime(
                    'endDate'
                  ),

                allDay:
                  document.getElementById(
                    'allDay'
                  ).checked,

                location:
                  document
                    .getElementById(
                      'location'
                    )
                    .value
                    .trim(),

                url:
                  document
                    .getElementById('event-url')
                    .value
                    .trim(),

                invitees:
                  document
                    .getElementById('invitees')
                    .value
                    .trim(),
              };
            }

            setStatus(
              'Saving…'
            );

            const res =
              await fetchWithTimeout(
                `${String(settings.serverUrl || '').replace(/\/+$/, '')}${ENDPOINT[currentType]}`,
                {
                  method:
                    'POST',

                  headers: {
                    'Content-Type':
                      'application/json',

                    'x-api-key':
                      apiKey,
                  },

                  body:
                    JSON.stringify(
                      payload
                    ),
                },
                30_000
              );

            if (!res.ok) {
              const d =
                await res
                  .json()
                  .catch(
                    () => ({})
                  );

              throw new Error(
                d.error ||
                `HTTP ${res.status}`
              );
            }

            setStatus(
              '✓ Added to queue!'
            );

            document.getElementById(
              'title'
            ).value = '';

            document.getElementById(
              'location'
            ).value = '';

            document.getElementById('event-url').value = '';
            document.getElementById('invitees').value = '';

            document.getElementById(
              'reminder-url'
            ).value = '';

            document.getElementById(
              'priority'
            ).value =
              'none';

            document.getElementById(
              'allDay'
            ).checked =
              false;

            clearDateTime(
              'dueDate'
            );

            if (currentType === 'reminder') {
              ensureReminderDueDateDefault();
            }

            clearDateTime(
              'startDate'
            );

            clearDateTime(
              'endDate'
            );

            if (editorApi) {
              editorApi.setMode(
                'markdown'
              );

              editorApi.setValue(
                ''
              );
            }

            pendingFiles = [];

            renderChips();

            // Clearing the editor can trigger its onChange handler and schedule a
            // fresh draft save. Clear the draft *after* all successful-submit
            // resets so the next open always starts from the current browser tab.
            await clearDraft();

            if (
              !isExpandedSurface
            ) {
              setTimeout(
                () =>
                  window.close(),
                1200
              );
            }
          } catch (err) {
            console.error(
              'Submit failed:',
              err
            );

            setStatus(
              err?.message ||
              'Something went wrong.',
              true
            );
          } finally {
            btn.disabled = false;
          }
        }
      );
  }
);