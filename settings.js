const DEFAULTS = {
  serverUrl: 'https://dashboard.erinskidds.com',
  apiKey: '',
  defaultFolder: 'Notes',
  defaultList: 'Reminders',
  defaultCalendar: 'Calendar',
  aiEnabled: false,
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById('serverUrl').value = s.serverUrl;
    document.getElementById('apiKey').value = s.apiKey;
    document.getElementById('defaultFolder').value = s.defaultFolder;
    document.getElementById('defaultList').value = s.defaultList;
    document.getElementById('defaultCalendar').value = s.defaultCalendar;
    document.getElementById('aiEnabled').checked = !!s.aiEnabled;
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    const serverUrl = document.getElementById('serverUrl').value.trim() || DEFAULTS.serverUrl;
    const apiKey = document.getElementById('apiKey').value.trim();
    const defaultFolder = document.getElementById('defaultFolder').value.trim() || 'Notes';
    const defaultList = document.getElementById('defaultList').value.trim() || 'Reminders';
    const defaultCalendar = document.getElementById('defaultCalendar').value.trim() || 'Calendar';
    const aiEnabled = document.getElementById('aiEnabled').checked;
    chrome.storage.sync.set(
      { serverUrl, apiKey, defaultFolder, defaultList, defaultCalendar, aiEnabled },
      () => {
        const status = document.getElementById('status');
        status.textContent = '✓ Saved!';
        setTimeout(() => { status.textContent = ''; }, 2000);
      }
    );
  });

  // Reports on the AI backend using whatever is currently typed in the form,
  // so the connection can be checked before saving.
  document.getElementById('ai-test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ai-test-btn');
    const out = document.getElementById('ai-test-status');
    const serverUrl = document.getElementById('serverUrl').value.trim() || DEFAULTS.serverUrl;
    const apiKey = document.getElementById('apiKey').value.trim();

    if (!apiKey) {
      out.textContent = 'Enter your API key first.';
      out.className = 'err';
      return;
    }

    btn.disabled = true;
    out.textContent = 'Checking…';
    out.className = '';
    try {
      const res = await fetch(`${serverUrl}/api/ai/parse`, { headers: { 'x-api-key': apiKey } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (!data.enabled) {
        out.textContent = 'AI is turned off on the server (AI_ENABLED=false).';
        out.className = 'err';
      } else if (!data.reachable) {
        out.textContent = `Server can't reach the model at ${data.baseUrl}${data.error ? ` — ${data.error}` : ''}.`;
        out.className = 'err';
      } else if (!data.modelInstalled) {
        out.textContent = `Connected, but "${data.model}" is not installed. Run: ollama pull ${data.model}`;
        out.className = 'err';
      } else {
        out.textContent = `✓ Connected — using ${data.model}.`;
        out.className = 'ok';
      }
    } catch (err) {
      out.textContent = err.message;
      out.className = 'err';
    } finally {
      btn.disabled = false;
    }
  });
});
