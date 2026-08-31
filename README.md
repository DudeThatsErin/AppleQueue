# Apple Queue

Apple Queue is a Chrome and Firefox extension for sending **Apple Notes**, **Reminders**, and **Calendar events** from the browser to Apple apps through an Apple Queue backend and iOS Shortcuts.

Apple does not provide a single public web API that a browser extension can use to write directly to all three apps. Apple Queue bridges that gap:

```text
Browser extension
      ↓
Apple Queue backend
      ↓
iOS Shortcut
      ↓
Notes / Reminders / Calendar
```

The extension submits structured items to a queue. An iOS Shortcut retrieves the pending items, creates them in the appropriate Apple app, and acknowledges the completed queue entries.

See [Apple Queue's website](https://applequeue.erinskidds.com/) for the dashboard and Shortcut setup instructions.

---

## Features

### Three capture types

Use one extension for all three Apple apps:

- **🍎 Notes** — title, folder, Markdown body, and arbitrary file attachments.
- **✅ Reminders** — title, list, due date, optional time, URL, priority, notes, and image attachments.
- **📅 Calendar events** — title, calendar, all-day status, start/end dates and times, location or video-call URL, separate event URL, invitee follow-up, and notes.

### Markdown-first editor

The editor stores and sends Markdown regardless of which editing surface is visible.

- Markdown mode is the default.
- Word wrapping is enabled by default.
- A **Wrap** button can toggle wrapping in Markdown source mode.
- A **Markdown** button switches between source mode and the visual editor.
- Visual formatting includes:
  - bold, italic, underline, and strikethrough;
  - H1, H2, and H3 headings;
  - paragraphs;
  - bulleted and numbered lists;
  - interactive checklists;
  - block quotes;
  - inline code and fenced code blocks;
  - links;
  - clear formatting.

### Page context

When no recent draft is being restored, Apple Queue can prefill information from the active browser tab:

- page title;
- selected text;
- page URL.

For Reminders and Calendar events, the captured page URL is moved into the dedicated **URL** field instead of being left in the notes body.

### Attachments

Apple Queue supports file picker, drag-and-drop, and clipboard paste.

- **Notes accept any file type.**
- **Reminders accept images only.**
- **Calendar events do not currently accept attachments.**
- Paste an image or browser-exposed clipboard file anywhere in Apple Queue to attach it.
- Ordinary text and Markdown paste continue to work normally.
- Upload progress is shown per file.
- Uploads have a 60-second timeout instead of remaining pending forever.
- Compatible backends return durable file URLs so formats Apple cannot embed directly can still be preserved as downloadable links.

The current extension uses the shared Apple Notes attachment upload endpoint for Note files and Reminder images, allowing both to use the same server-side attachment store.

### Persistent drafts and attachments

Drafts are shared between the normal popup, Chrome Side Panel, Firefox sidebar, and expanded tab view.

- Form values and editor content are remembered for **two minutes**.
- Attachment bytes are stored temporarily in extension-owned IndexedDB.
- Attachments survive closing and reopening the popup during the draft window.
- Attachments survive moving from the popup to the Side Panel.
- After the draft expires, Apple Queue clears it and captures the current tab's title and URL again.
- After a successful submit, the draft timer, form data, and temporary attachment blobs are cleared immediately.

### Reminder-specific behavior

- The due date defaults to **today in the user's local timezone**.
- Due time is optional and stays blank by default.
- A date-only value is sent when no time is selected.
- Date and time each appear on their own row.
- The white calendar and clock buttons open the browser's native picker.
- Reminders have a dedicated URL field and priority selector.
- Reminder attachments are restricted to images.

### Calendar-specific behavior

- Separate Start Date, Start Time, End Date, and End Time controls.
- Native date/time pickers through the calendar and clock buttons.
- All-day event support.
- Separate **Location or video call** and **URL** fields.
- Google Places address autocomplete through the configured backend.
- URLs typed into Location are treated as video-call links and do not trigger address autocomplete.
- Optional Invitees text such as `Joshua, Kevin, Jenny` can create one reminder 24 hours before the event:

```text
Make sure to invite Joshua, Kevin, and Jenny to Event Name
```

The invite reminder uses the event URL, or the location/video-call URL when no separate event URL is present. This behavior requires the compatible Calendar backend route.

### Google Places autocomplete

Calendar location suggestions are requested through the backend rather than directly from the extension:

```text
Extension
   ↓
/api/places/autocomplete
   ↓
Google Places API
```

The Google API key stays on the server and is never stored in the extension. Configure it on the backend with:

```env
GOOGLE_PLACES_API_KEY=your_key_here
```

Suggestions begin after at least three characters, are debounced, and display loading, empty-result, and error states.

### Chrome Side Panel, Firefox sidebar, and expanded view

- Chrome native Side Panel support.
- Firefox sidebar support.
- Full-tab fallback where a native sidebar is unavailable.
- The same form, draft, and attachments are available across surfaces.

### Browser context menus

Apple Queue adds browser context-menu actions for quick capture:

- Save selection to Apple Notes.
- Save page to Apple Notes.
- Save link to Apple Notes.
- Save image to Apple Notes.
- Remind me about selection.
- Remind me about this page.

Context-menu actions submit immediately rather than opening the review form.

### First-run setup gate

A fresh installation contains no embedded API key. Until a key is saved, Apple Queue displays an **API key required** screen with a direct link to Settings instead of showing a form that cannot submit.

### Connection tests

Settings provide two independent tests:

- **Test extension connection** checks the Server URL, Apple Queue API key, and the Notes, Reminders, and Calendar queue APIs. It does not test AI.
- **Test AI connection** is only visible while natural-language parsing is enabled and tests the selected provider and model.

---

## Natural-language capture

Natural-language parsing is optional and off by default.

Examples:

```text
call the vet friday at 3pm
```

```text
create an event called project review tomorrow from 2 to 3 at 3000 Gracie Kiltz Lane
```

The selected AI provider can fill the form with structured fields such as:

- type: Note, Reminder, or Event;
- title;
- body or notes;
- folder, list, or calendar;
- due/start/end dates and times;
- priority;
- all-day status;
- location;
- separate URL;
- invitees.

Parsing **only fills the form for review**. Nothing is queued until the user presses **Add to Queue**.

### Supported AI providers

| Provider | Required settings |
| --- | --- |
| ChatGPT / OpenAI | Exact model ID and OpenAI API key |
| Claude / Anthropic | Exact model ID and Anthropic API key |
| Gemini / Google | Exact model ID and Gemini API key |
| Ollama | Exact model ID and Ollama base URL; API key is optional for local Ollama |

Provider API keys are stored in `chrome.storage.local`, not Chrome Sync.

The Apple Queue backend must provide:

```text
POST /api/ai/test
POST /api/ai/parse
```

### Ollama

For Ollama running on the same machine as the backend, use a base URL such as:

```text
http://127.0.0.1:11434
```

Enter the base URL only—the backend adds `/api/chat` itself.

For example:

```text
Model: qwen2.5vl:7b
Base URL: http://127.0.0.1:11434
API key: leave blank for local Ollama
```

A large Ollama model may require up to 90 seconds for the first cold-start request. Later requests are usually faster while the model remains loaded.

`localhost` or `127.0.0.1` refers to the machine running the **backend route**, not necessarily the computer running the browser extension.

---

## Install

### Chrome

1. Download `apple-notes-extension.zip` from the [latest release](../../releases/latest).
2. Extract the ZIP to a permanent folder.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.
7. Keep that folder on your computer while using the unpacked extension.
8. Open Apple Queue. The first-run screen will ask you to open Settings and add your API key.

### Firefox

1. Download and extract `apple-notes-extension.zip`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on**.
4. Select `manifest.json` from the extracted folder.
5. Open Settings and add your API key.

A temporary Firefox add-on must be loaded again after restarting Firefox. A signed AMO build is preferable for permanent public distribution.

---

## Configuration

Open the extension's Settings page and configure the following fields.

| Setting | Purpose |
| --- | --- |
| Server URL | Apple Queue backend URL. The current build defaults to `https://dashboard.erinskidds.com`. |
| API Key | Authenticates Notes, Reminders, Calendar, uploads, Places, and AI routes. No working key is bundled with the extension. |
| Test extension connection | Verifies the server, API key, and all three queue APIs. |
| Default Folder | Apple Notes folder. It must already exist on the Apple device. |
| Default List | Apple Reminders list. It must already exist on the Apple device. |
| Default Calendar | Apple Calendar name. It must already exist on the Apple device. |
| Enable natural-language parsing | Shows the optional AI capture box. Off by default. |
| AI Provider | OpenAI, Anthropic, Gemini, or Ollama. |
| Model | Exact provider model ID. No model is automatically selected. |
| Provider API Key | Required for OpenAI, Anthropic, Gemini, and hosted Ollama; optional for local Ollama. |
| Ollama Base URL | Address of the Ollama server, such as `http://127.0.0.1:11434`. |
| Test AI connection | Tests only the selected AI provider and model. |

The normal connection test and AI connection test do different jobs. A working queue backend does not automatically mean the selected AI provider is configured correctly.

---

## Compatible backend routes

The extension and iOS Shortcuts expect a compatible Apple Queue backend. The current feature set uses routes equivalent to:

### Notes

```text
GET/POST /api/apple-notes
POST     /api/apple-notes/upload
GET      /api/apple-notes/files/[filename]
GET      /api/apple-notes/pending
POST     /api/apple-notes/ack
```

### Reminders

```text
GET/POST /api/reminders
GET      /api/reminders/pending
POST     /api/reminders/ack
```

Reminder image metadata must be preserved in the Reminder queue. The current extension uploads those images through the shared Apple Notes upload route.

### Calendar

```text
GET/POST /api/calendar
GET      /api/calendar/pending
POST     /api/calendar/ack
```

### Optional services

```text
POST /api/places/autocomplete
POST /api/ai/test
POST /api/ai/parse
```

The backend is responsible for persistent queue storage, attachment storage, authentication, provider API calls, and the Calendar invite-reminder workaround.

---

## iOS Shortcuts

Apple Queue does not create the final Apple item by itself. Configure the matching iOS Shortcuts from the Apple Queue website or dashboard.

Each Shortcut should generally:

1. Fetch pending queue items with the `x-api-key` header.
2. Read the item fields.
3. Convert Markdown to rich text where appropriate.
4. Create the Note, Reminder, or Calendar event.
5. Download/embed supported attachments or retain their server URLs as links.
6. Acknowledge the queue item only after successful creation.

Do not acknowledge failed items, or they will disappear from the queue before being created on the Apple device.

---

## Privacy and security notes

- A working Apple Queue API key is required; none is bundled in public extension builds.
- The Google Places key remains on the backend.
- AI-provider keys are stored only in the local browser profile, not Chrome Sync.
- Natural-language parsing sends the entered capture text to the selected AI provider through the configured backend.
- Parsing never submits an item automatically.
- Context-menu queue actions do submit immediately.
- Uploaded files are stored by the configured backend. Review that backend's retention and access rules before sharing sensitive files.

---

## Troubleshooting

### The extension only shows “API key required”

Open Settings, enter the Apple Queue API key, save, and run **Test extension connection**.

### `Failed to fetch`

Check the Server URL, network access, browser host permissions, TLS certificate, reverse proxy, and whether the backend is running.

### Upload returns HTTP 413

Increase the reverse proxy request-body limit. For nginx, the site configuration may need a value such as:

```nginx
client_max_body_size 25M;
```

The proxy limit must be larger than the backend's maximum attachment size.

### AI test returns HTTP 404

Confirm the backend contains and has deployed:

```text
src/app/api/ai/test/route.ts
```

Then rebuild and restart the backend.

### Ollama test times out

- Test Ollama directly on the backend host.
- Confirm the exact model with `ollama list`.
- Use the Ollama base URL, not the complete `/api/chat` endpoint.
- Allow enough time for a cold model load.
- Consider a smaller text model if a vision model is unnecessarily slow.

### Address suggestions do not appear

Confirm the backend has `/api/places/autocomplete`, `GOOGLE_PLACES_API_KEY` is configured, Places API is enabled, and the Apple Queue API key is valid.

---

## Releases

Releases are automated. Bump `version` in `manifest.json` and push to `main`—the [release workflow](.github/workflows/release.yml) validates the extension, builds the ZIP, and publishes it.

Pushing without a version bump does **not** create a release because browsers use the manifest version for updates. To re-release the current version intentionally, run the workflow manually from the Actions tab with **force** enabled.

Before publishing, verify that the release ZIP contains all required runtime files at its root, including:

```text
manifest.json
background.js
popup.html
popup.js
editor.js
settings.html
settings.js
marked.js
turndown.js
icons/
```

---

## Development

After changing extension source files:

1. Reload the unpacked extension from `chrome://extensions`.
2. Close and reopen any popup, Side Panel, options page, or expanded tab.
3. Test all capture types.
4. Verify popup-to-Side-Panel draft and attachment persistence.
5. Verify the built ZIP matches the committed source before publishing.
