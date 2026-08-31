# Apple Queue

A Chrome and Firefox extension that queues **Notes**, **Reminders**, and **Calendar events**
to Apple, via [Apple Queue's Website](https://applequeue.erinskidds.com/) and an iOS Shortcut.

Apple has no public write API for Notes, Reminders, or Calendar. This extension posts to a
queue on my server; a Shortcut on my phone drains that queue and creates the real items.

## Features

- **Three capture types** — Apple Notes, Reminders, and Calendar events, from one popup.
- **Rich text editor** for note bodies, with headings, lists, checklists, and formatting.
- **Attachments** — drop images or PDFs onto a note.
- **Page context** — pre-fills the title, your text selection, and the page URL.
- **Draft autosave**, so closing the popup mid-thought loses nothing.
- **Sidebar / tab mode** for a roomier editor than the toolbar dropdown allows.
- **Natural-language capture** (optional, off by default) — see below.

## Natural-language capture

Type `call the vet friday at 3pm` and the form fills itself in: type, title, list, and date.

This runs against a **self-hosted LLM** — [Ollama](https://ollama.com) serving
**Qwen2.5 3B Instruct** on my own server. Nothing is sent to a third-party AI service.
The server speaks the OpenAI-compatible chat API, so the backend can be swapped for any
other provider by changing one environment variable.

Dates and times are **not** parsed by the model. They are resolved by a deterministic rule
engine on the server (weekdays, relative offsets, ranges like `3-4pm`, durations, dayparts),
because a 3B model asked to do calendar arithmetic gets it wrong often enough to be unusable.
The model only classifies the type and writes a title — the part it is actually good at.

Parsing **only fills the form**. Nothing is ever queued without you pressing Add, so a
misread date is always visible first.

To turn it on: **Settings → Enable natural-language parsing**, then use **Test connection**
to confirm the server can reach the model.

## Install

1. Download `apple-notes-extension.zip` from the [latest release](../../releases/latest).
2. Unzip it.
3. **Chrome** — go to `chrome://extensions`, enable *Developer mode*, click
   *Load unpacked*, and select the unzipped folder.
   **Firefox** — go to `about:debugging#/runtime/this-firefox`, click
   *Load Temporary Add-on*, and select `manifest.json`.
4. Open the extension's **Settings** and paste your API key.

## Configuration

| Setting | Purpose |
| --- | --- |
| Server URL | Defaults to `https://dashboard.erinskidds.com`. |
| API key | Found on the Apple Notes / Reminders / Calendar dashboard pages. One key covers all three. |
| Default Folder / List / Calendar | Where each type is filed. Must already exist on your device. |
| Enable natural-language parsing | Turns on the AI capture box. Off by default. |

## Releases

Releases are automated. Bump `version` in `manifest.json` and push to `main` — the
[release workflow](.github/workflows/release.yml) validates the extension, builds the zip,
and publishes it.

Pushing without a version bump does **not** cut a release, since browsers key updates off the
manifest version and a release nobody can install is just noise. To re-release the current
version anyway, run the workflow manually from the Actions tab with *force* enabled.
