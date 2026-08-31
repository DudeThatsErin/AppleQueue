chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-selection',
    title: 'Save selection to Apple Notes',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'save-page',
    title: 'Save page to Apple Notes',
    contexts: ['page', 'frame'],
  });
  chrome.contextMenus.create({
    id: 'save-link',
    title: 'Save link to Apple Notes',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'save-image',
    title: 'Save image to Apple Notes',
    contexts: ['image'],
  });
  chrome.contextMenus.create({
    id: 'remind-selection',
    title: 'Remind me about selection',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'remind-page',
    title: 'Remind me about this page',
    contexts: ['page', 'frame'],
  });
});

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        serverUrl: 'https://dashboard.erinskidds.com',
        apiKey: '',
        defaultFolder: 'Quick Notes',
        defaultList: 'Inbox',
        defaultCalendar: 'Calendar',
      },
      resolve
    );
  });
}

async function queueNote(title, body, folder, attachments = []) {
  const { serverUrl, apiKey } = await getSettings();
  if (!apiKey) {
    chrome.notifications?.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Apple Notes', message: 'API key not set. Open extension settings.' });
    chrome.runtime.openOptionsPage();
    return;
  }
  const res = await fetch(`${serverUrl}/api/apple-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ title, body, folder, attachments }),
  });
  return res.ok;
}

async function queueReminder(title, notes, list) {
  const { serverUrl, apiKey } = await getSettings();
  if (!apiKey) {
    chrome.notifications?.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Reminders', message: 'API key not set. Open extension settings.' });
    chrome.runtime.openOptionsPage();
    return;
  }
  const res = await fetch(`${serverUrl}/api/reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ title, notes, list, dueDate: '', priority: 'none' }),
  });
  return res.ok;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const { defaultFolder, defaultList } = await getSettings();

  if (info.menuItemId === 'save-selection') {
    const title = tab?.title || 'Selection';
    const body = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
    await queueNote(title, body, defaultFolder);
  } else if (info.menuItemId === 'save-page') {
    await queueNote(tab?.title || info.pageUrl, info.pageUrl, defaultFolder);
  } else if (info.menuItemId === 'save-link') {
    await queueNote(info.linkText || info.linkUrl, info.linkUrl, defaultFolder);
  } else if (info.menuItemId === 'save-image') {
    // Download image from content script and upload to server
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (srcUrl) => srcUrl,
      args: [info.srcUrl],
    });
    const imageUrl = result?.result || info.srcUrl;
    const { serverUrl, apiKey } = await getSettings();
    if (!apiKey) {
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Apple Queue',
        message: 'You need to add your API key. Open extension settings to add it.',
      });
      chrome.runtime.openOptionsPage();
      return;
    }
    try {
      // Fetch the image as blob then upload
      const imgRes = await fetch(imageUrl);
      const blob = await imgRes.blob();
      const ext = blob.type.split('/')[1] || 'jpg';
      const fd = new FormData();
      fd.append('file', blob, `image.${ext}`);
      const upRes = await fetch(`${serverUrl}/api/apple-notes/upload`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: fd,
      });
      if (upRes.ok) {
        const data = await upRes.json();
        await queueNote('Image from ' + (tab?.title || 'page'), `Source: ${info.pageUrl}`, defaultFolder, [
          { name: data.name, url: data.url, mimeType: data.mimeType },
        ]);
      }
    } catch {
      // Fall back to just queuing the URL
      await queueNote('Image from ' + (tab?.title || 'page'), imageUrl, defaultFolder);
    }
  } else if (info.menuItemId === 'remind-selection') {
    const title = info.selectionText?.slice(0, 100) || tab?.title || 'Reminder';
    const notes = `${info.selectionText}\n\nSource: ${info.pageUrl}`;
    await queueReminder(title, notes, defaultList);
  } else if (info.menuItemId === 'remind-page') {
    await queueReminder(tab?.title || info.pageUrl, info.pageUrl, defaultList);
  }
});
