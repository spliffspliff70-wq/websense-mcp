# Reddit composer — speed run + verified submit paths (2026-09-01)

This guide captures the timed Reddit post-composer session: what each operation costs,
which paths are proven, and the hard walls to not re-try. It complements the OSS repo's
`scripts/reddit-post.cjs` with the lessons learned after it shipped.

## Timed results (goal: <5s total fill)

| Sub | Title | Body | Flair | Validity | TOTAL |
|---|---|---|---|---|---|
| r/hermesagent (flair enforced) | 0.01s | 2.28s | 0.03s | 0.01s | **~2.3s** |
| r/mcp | 0.02s | 1.82s | not enforced | 0.01s | **~1.8s** |

Page load excluded (one-time per tab; reusing a loaded tab makes repeat posts free of it).

## The fast sequence

### 1. Title — main_world shadow-key (0.01-0.02s)
```js
const pct = document.querySelector('post-composer-title');
const ta = pct.shadowRoot.querySelector('textarea[name="title"]');
ta.focus();
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, TITLE);
ta.dispatchEvent(new Event('input', {bubbles: true}));
ta.dispatchEvent(new Event('change', {bubbles: true}));
```
⚠️ Plain `[name="title"]` can match the header search box in some layouts — always go
through the `post-composer-title` shadow host.

### 2. Body — content-script paste rung (1.8-2.3s)
`type_text {ref: '[slot="rte"][name="body"]', text, clearFirst: true}` →
`confirmed: "paste-dom-persisted"`.

🔴 **Hard wall (verified 3 ways): main_world cannot write into Lexical.**
- `document.execCommand('insertText', false, body)` after selectAll → silently reverted
- synthetic `ClipboardEvent('paste')` with real `DataTransfer` → silently reverted
Both return undefined; the editor stays empty. Lexical only accepts its own paste
pipeline, which the extension's content-script paste rung drives. Do not retry these.

### 3. Flair gate — component internals (0.03s)
The submit button host exposes the composer form (main_world readable):
```js
const host = document.querySelector('r-post-form-submit-button');
host.form.isValid                            // THE submit gate
host.form.isPostFlairClientValidationEnabled // flair required?
```
If flair is enforced:
```js
document.querySelector('r-post-tags-section').handleClick();          // open modal
const modal = document.querySelector('r-post-flairs-modal');
modal.shadowRoot.getElementById('post-flair-radio-input-<n>').click(); // n=0-12
modal.shadowRoot.getElementById('post-flair-modal-apply-button').click();
// isValid recomputes within ~25ms; "No flair" radio id: post-flair-radio-input-no-flair
```
The dialog closes but the modal ELEMENT stays mounted — check
`faceplate-dialog[open]` inside its shadow, not element presence.

### 4. Submit
`host.submitPostForm()` fires the `/svc/shreddit/graphql` mutation only when
`isValid === true`. **Honest status:** on r/hermesagent (2026-09-01) this alone did not
produce a visible submit — no redirect, post absent from profile. The VERIFIED end-to-end
submit remains the genuine-OS-input rung (`real_click` with title gate) plus the
rule-check modal ("Submit without editing"). Treat `submitPostForm()` as a fast path to
TEST, with real_click as the proven fallback.

## Per-tab content-script wedge (recovery)

Symptom: `main_world` AND `evaluate` both time out on ONE tab while `tabs list` works and
other tabs answer instantly. Cause: an in-flight `userScripts.execute` killed mid-run
(agent restart/timeout) wedges that tab's content script permanently.
`status {kind:"bridge"}` shows `hubConnected: true` with page probe timeout.

**FIX: close the tab + open a fresh one.** Navigate/reload/re-bind on the same tab do
NOT recover it (verified live).

## Verification discipline

- Title: read back `ta.value.length` via main_world (not the validity attribute — it can
  stay "invalid" while the value is persisted).
- Body: `evaluate {extract: "html"}` on `[slot="rte"][name="body"]` (extract:"text" can
  return "" on nested Lexical spans).
- End-to-end: check the profile's /submitted/ page for the post permalink.
