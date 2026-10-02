// type_post.js — write text into the X.com composer contenteditable
const ce = document.querySelector('[data-testid="tweetTextarea_0RichTextInputContainer"] [data-contents="true"]');
if (ce) {
  const text = "Post 1/3: WebSense v2.0 live-verified on X.com compose \u2014 content script was stale, not a Cloudflare wall. Reload + rebind: 96\u2192590 elements, composer hydrated. Post button (tweetButtonInline) started disabled, enabled once text landed. Background tab, no focus steal, no Enter. #websense #automation";
  ce.textContent = text;
  const evt = new window.Event('input', { bubbles: true });
  ce.dispatchEvent(evt);
  window.__ws_result = { ok: true, found: true, textLen: ce.textContent.length };
} else {
  window.__ws_result = { ok: false, found: false };
}
window.__ws_result;
