const AI_TEST_TIMEOUT_MS = 90_000;

const DEFAULTS = {
  serverUrl: 'https://dashboard.erinskidds.com',
  apiKey: '',
  defaultFolder: 'Notes',
  defaultList: 'Reminders',
  defaultCalendar: 'Calendar',
  aiEnabled: false,
  aiProvider: 'openai',
  aiModel: '',
  aiBaseUrl: 'http://localhost:11434',
};

const PROVIDERS = {
  openai: {
    name: 'ChatGPT / OpenAI',
    modelPlaceholder: 'e.g. gpt-5-mini',
    keyRequired: true,
    keyLabel: 'OpenAI API Key',
    keyHint: 'Required. Saved only in this browser profile, not Chrome Sync.',
  },
  anthropic: {
    name: 'Claude / Anthropic',
    modelPlaceholder: 'e.g. claude-sonnet-4-20250514',
    keyRequired: true,
    keyLabel: 'Anthropic API Key',
    keyHint: 'Required. Saved only in this browser profile, not Chrome Sync.',
  },
  gemini: {
    name: 'Gemini / Google',
    modelPlaceholder: 'e.g. gemini-3.7-flash',
    keyRequired: true,
    keyLabel: 'Gemini API Key',
    keyHint: 'Required. Saved only in this browser profile, not Chrome Sync.',
  },
  ollama: {
    name: 'Ollama',
    modelPlaceholder: 'e.g. gemma3 or gpt-oss:20b',
    keyRequired: false,
    keyLabel: 'Ollama API Key (optional)',
    keyHint: 'Not needed for local Ollama. Required for direct Ollama Cloud API access.',
  },
};

function normaliseBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function setStatus(id, message, kind = '') {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = `status-line${kind ? ` ${kind}` : ''}`;
}

function updateAiVisibility() {
  const enabled = document.getElementById('aiEnabled').checked;
  document.getElementById('ai-config').classList.toggle('hidden', !enabled);
}

function updateProviderFields() {
  const provider = document.getElementById('aiProvider').value;
  const meta = PROVIDERS[provider] || PROVIDERS.openai;
  const model = document.getElementById('aiModel');
  model.placeholder = meta.modelPlaceholder;
  document.getElementById('ai-model-hint').textContent = `Enter the exact ${meta.name} model ID you want Apple Queue to use.`;
  document.getElementById('ai-key-label').textContent = meta.keyLabel;
  document.getElementById('ai-key-hint').textContent = meta.keyHint;
  document.getElementById('ai-base-url-field').classList.toggle('hidden', provider !== 'ollama');
}

function currentAiConfig() {
  return {
    provider: document.getElementById('aiProvider').value,
    model: document.getElementById('aiModel').value.trim(),
    apiKey: document.getElementById('aiApiKey').value.trim(),
    baseUrl: normaliseBaseUrl(document.getElementById('aiBaseUrl').value),
  };
}

function validateAiConfig(config) {
  const meta = PROVIDERS[config.provider] || PROVIDERS.openai;
  if (!config.model) return 'Enter a model name.';
  if (meta.keyRequired && !config.apiKey) return `${meta.keyLabel} is required.`;
  if (config.provider === 'ollama' && !config.baseUrl) return 'Enter your Ollama base URL.';
  return '';
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    document.getElementById('serverUrl').value = s.serverUrl;
    document.getElementById('apiKey').value = s.apiKey;
    document.getElementById('defaultFolder').value = s.defaultFolder;
    document.getElementById('defaultList').value = s.defaultList;
    document.getElementById('defaultCalendar').value = s.defaultCalendar;
    document.getElementById('aiEnabled').checked = !!s.aiEnabled;
    document.getElementById('aiProvider').value = s.aiProvider || 'openai';
    document.getElementById('aiModel').value = s.aiModel || '';
    document.getElementById('aiBaseUrl').value = s.aiBaseUrl || 'http://localhost:11434';
    chrome.storage.local.get({ aiApiKey: '' }, (local) => {
      document.getElementById('aiApiKey').value = local.aiApiKey || '';
    });
    updateAiVisibility();
    updateProviderFields();
  });

  document.getElementById('aiEnabled').addEventListener('change', updateAiVisibility);
  document.getElementById('aiProvider').addEventListener('change', updateProviderFields);

  document.getElementById('save-btn').addEventListener('click', () => {
    const serverUrl = normaliseBaseUrl(document.getElementById('serverUrl').value) || DEFAULTS.serverUrl;
    const apiKey = document.getElementById('apiKey').value.trim();
    const defaultFolder = document.getElementById('defaultFolder').value.trim() || 'Notes';
    const defaultList = document.getElementById('defaultList').value.trim() || 'Reminders';
    const defaultCalendar = document.getElementById('defaultCalendar').value.trim() || 'Calendar';
    const aiEnabled = document.getElementById('aiEnabled').checked;
    const ai = currentAiConfig();

    if (aiEnabled) {
      const err = validateAiConfig(ai);
      if (err) {
        setStatus('status', err, 'err');
        return;
      }
    }

    chrome.storage.sync.set(
      {
        serverUrl,
        apiKey,
        defaultFolder,
        defaultList,
        defaultCalendar,
        aiEnabled,
        aiProvider: ai.provider,
        aiModel: ai.model,
        aiBaseUrl: ai.baseUrl,
      },
      () => {
        chrome.storage.local.set({ aiApiKey: ai.apiKey }, () => {
          const status = document.getElementById('status');
          status.textContent = '✓ Saved!';
          status.style.color = '#34d399';
          setTimeout(() => { status.textContent = ''; }, 2000);
        });
      }
    );
  });

  document.getElementById('extension-test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('extension-test-btn');
    const serverUrl = normaliseBaseUrl(document.getElementById('serverUrl').value) || DEFAULTS.serverUrl;
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) {
      setStatus('extension-test-status', 'Enter the Apple Queue API key first.', 'err');
      return;
    }

    btn.disabled = true;
    setStatus('extension-test-status', 'Checking Notes, Reminders, and Calendar…', 'busy');
    const endpoints = [
      ['Notes', '/api/apple-notes'],
      ['Reminders', '/api/reminders'],
      ['Calendar', '/api/calendar'],
    ];
    try {
      const results = [];
      for (const [name, path] of endpoints) {
        try {
          const { res, data } = await fetchJson(`${serverUrl}${path}`, {
            method: 'GET',
            headers: { 'x-api-key': apiKey },
          }, 12000);
          results.push({ name, ok: res.ok, status: res.status, error: data.error || '' });
        } catch (err) {
          results.push({ name, ok: false, status: 0, error: err.message });
        }
      }
      const failed = results.filter((r) => !r.ok);
      if (!failed.length) {
        setStatus('extension-test-status', '✓ Extension connection works — Notes, Reminders, and Calendar all authenticated.', 'ok');
      } else {
        setStatus(
          'extension-test-status',
          `Connection issue: ${failed.map((r) => `${r.name} (${r.status || r.error})`).join(', ')}.`,
          'err'
        );
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('ai-test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ai-test-btn');
    const serverUrl = normaliseBaseUrl(document.getElementById('serverUrl').value) || DEFAULTS.serverUrl;
    const appleQueueApiKey = document.getElementById('apiKey').value.trim();
    const ai = currentAiConfig();
    const validation = validateAiConfig(ai);
    if (!appleQueueApiKey) {
      setStatus('ai-test-status', 'Enter the Apple Queue API key first.', 'err');
      return;
    }
    if (validation) {
      setStatus('ai-test-status', validation, 'err');
      return;
    }

    btn.disabled = true;
    const providerName = PROVIDERS[ai.provider]?.name || ai.provider;
    const coldStartHint = ai.provider === 'ollama'
      ? ' The first request can take up to 90 seconds while Ollama loads the model.'
      : '';
    setStatus('ai-test-status', `Testing ${providerName}…${coldStartHint}`, 'busy');
    try {
      const { res, data } = await fetchJson(`${serverUrl}/api/ai/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': appleQueueApiKey,
        },
        body: JSON.stringify({ ai }),
      }, AI_TEST_TIMEOUT_MS);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus('ai-test-status', `✓ AI connected — ${data.provider || ai.provider} / ${data.model || ai.model}.`, 'ok');
    } catch (err) {
      setStatus('ai-test-status', err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});
