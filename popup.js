import { createEditor } from './editor.js';

// The editor is the shared component from the dashboard — same toolbar,
// same markdown toggle, same checklist behaviour, same styles. Its value is
// always markdown, which is also what gets queued and what Notes is sent.
let editorApi = null;

let pendingFiles = [];
let currentType = 'note';

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

// ── Draft persistence ────────────────────────────────────────────────────────

const DRAFT_KEY = 'draft';

const DRAFT_FIELDS = [
  'title',
  'secondary',
  'priority',
  'location',
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
    editorMode: editorApi ? editorApi.getMode() : 'wysiwyg',
    bodyMarkdown: editorApi ? editorApi.getValue() : '',
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

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);

  draftSaveTimer = setTimeout(() => {
    chrome.storage.local.set({
      [DRAFT_KEY]: getDraftState(),
    });
  }, 400);
}

function clearDraft() {
  clearTimeout(draftSaveTimer);
  chrome.storage.local.remove(DRAFT_KEY);
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

  if (editorApi) {
    editorApi.setMode(
      draft.editorMode === 'markdown'
        ? 'markdown'
        : 'wysiwyg'
    );

    editorApi.setValue(
      editorApi.markdown.toMarkdown(
        draft.bodyMarkdown ||
        draft.bodyHtml ||
        ''
      )
    );
  }

  return true;
}

// ── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl:
          'https://dashboard.erinskidds.com',

        apiKey:
          'a2369d061fa3dabb8e4da02b12a9c5d591264c7e5f59bfd70ac4c2450bcf6042',

        defaultFolder:
          'Quick Notes',

        defaultList:
          'Inbox',

        defaultCalendar:
          'Calendar',

        aiEnabled:
          true,
      },
      resolve
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

function renderChips() {
  const container =
    document.getElementById(
      'file-chips'
    );

  container.innerHTML = '';

  pendingFiles.forEach((f, i) => {
    const chip =
      document.createElement('div');

    chip.className = 'chip';

    const label =
      document.createElement('span');

    label.textContent =
      `${f.type.startsWith('image/')
        ? '🖼️'
        : '📄'} ${f.name}`;

    chip.appendChild(label);

    const btn =
      document.createElement('button');

    btn.textContent = '✕';

    btn.onclick = () => {
      pendingFiles.splice(i, 1);
      renderChips();
    };

    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

function addFiles(files) {
  if (!files) {
    return;
  }

  Array
    .from(files)
    .forEach((f) => {
      pendingFiles.push(f);
    });

  renderChips();
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
  file
) {
  const fd =
    new FormData();

  fd.append(
    'file',
    file
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      60_000
    );

  try {
    const res =
      await fetch(
        `${serverUrl}/api/apple-notes/upload`,
        {
          method: 'POST',

          headers: {
            'x-api-key': apiKey,
          },

          body: fd,

          signal:
            controller.signal,
        }
      );

    const data =
      await res
        .json()
        .catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        data.error ||
        `Upload failed: ${file.name} (HTTP ${res.status})`
      );
    }

    return data;
  } catch (err) {
    if (
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      throw new Error(
        `Upload timed out after 60 seconds: ${file.name}`
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
  }

  setDateTime(
    'dueDate',
    capture.dueDate
  );

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
        await fetch(
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
            }),
          }
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
  ).textContent =
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

  document.getElementById(
    'attachments-section'
  ).classList.toggle(
    'hidden',
    type !== 'note'
  );

  setStatus('');
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

// ── Main initialization ─────────────────────────────────────────────────────

document.addEventListener(
  'DOMContentLoaded',
  async () => {
    const settings =
      await getSettings();

    const { apiKey } =
      settings;

    if (!apiKey) {
      document.getElementById(
        'no-key'
      ).style.display =
        'block';

      document.getElementById(
        'main-form'
      ).style.display =
        'none';
    }

    const expandLink =
      document.getElementById(
        'expand-link'
      );

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

          minHeight:
            150,

          onChange:
            scheduleDraftSave,
        }
      );

    setupAi(settings);

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
      }
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

    // Settings links.
    document
      .getElementById(
        'settings-link'
      )
      .addEventListener(
        'click',
        (e) => {
          e.preventDefault();

          chrome.runtime
            .openOptionsPage();
        }
      );

    document
      .getElementById(
        'settings-link-2'
      )
      ?.addEventListener(
        'click',
        (e) => {
          e.preventDefault();

          chrome.runtime
            .openOptionsPage();
        }
      );

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
      (e) => {
        e.preventDefault();

        addFiles(
          e.dataTransfer.files
        );
      }
    );

    fileInput.addEventListener(
      'change',
      () => {
        addFiles(
          fileInput.files
        );

        fileInput.value = '';
      }
    );

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
              const attachments = [];

              if (
                pendingFiles.length >
                0
              ) {
                setStatus(
                  'Uploading files…'
                );

                for (
                  const file
                  of pendingFiles
                ) {
                  setStatus(
                    `Uploading ${file.name}…`
                  );

                  const data =
                    await uploadFile(
                      settings.serverUrl,
                      apiKey,
                      file
                    );

                  attachments.push({
                    name:
                      data.name,

                    url:
                      data.url,

                    mimeType:
                      data.mimeType,
                  });
                }
              }

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
              payload = {
                title,

                notes:
                  body,

                list:
                  secondary,

                dueDate:
                  combineDateTime(
                    'dueDate'
                  ),

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
              };
            }

            setStatus(
              'Saving…'
            );

            const res =
              await fetch(
                `${settings.serverUrl}${ENDPOINT[currentType]}`,
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
                }
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

            clearDraft();

            document.getElementById(
              'title'
            ).value = '';

            document.getElementById(
              'location'
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

            clearDateTime(
              'startDate'
            );

            clearDateTime(
              'endDate'
            );

            if (editorApi) {
              editorApi.setMode(
                'wysiwyg'
              );

              editorApi.setValue(
                ''
              );
            }

            pendingFiles = [];

            renderChips();

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