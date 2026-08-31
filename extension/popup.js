'use strict';

// Check if offscreen document exists and is connected
// by sending a message to the background service worker

// Cross-browser bridge check. Chrome uses an offscreen document for the WS bridge;
// Firefox holds the bridge directly in the persistent background script (no offscreen).
// We avoid chrome.runtime.getContexts on Firefox (OFFSCREEN_DOCUMENT is invalid there).
async function bridgeUp() {
  if (typeof chrome.runtime.getContexts !== 'function') return true; // Firefox: bridge in background
  try {
    var c = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    return c.length > 0;
  } catch (e) {
    return true; // Firefox or unsupported enum: bridge lives in background
  }
}

async function checkStatus() {
  var dot = document.getElementById('dot');
  var text = document.getElementById('status-text');
  var urlInfo = document.getElementById('url-info');

  try {
    // Try to get active tab
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      urlInfo.textContent = tabs[0].title ? tabs[0].title.slice(0, 40) : tabs[0].url || '';
    }

    var up = await bridgeUp();

    if (up) {
      dot.className = 'dot green';
      text.textContent = 'Connected — Bridge active';
    } else {
      dot.className = 'dot yellow';
      text.textContent = 'Bridge not ready — retrying…';
    }
  } catch (err) {
    dot.className = 'dot red';
    text.textContent = 'Error: ' + (err.message || 'unknown');
  }
}

document.getElementById('reconnect').addEventListener('click', function() {
  // Force offscreen recreation by reloading the extension context
  chrome.runtime.reload();
});

checkStatus();
// Refresh every 3 seconds
setInterval(checkStatus, 3000);
