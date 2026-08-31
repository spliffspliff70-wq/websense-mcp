/**
 * WebSense — Upload confirmation verdict (P2, 2026-08-31)
 * ========================================================
 * Pure decision logic for upload_file truth-telling. The content script
 * (browser IIFE) mirrors this inline; this module exists so the verdict
 * semantics are unit-tested and shared with any non-browser caller.
 *
 * Background: nativeUploadFromBase64 used to check the page for the filename
 * SYNCHRONOUSLY after dispatching the drop. Many apps (GitHub dropzone,
 * Gmail) process uploads asynchronously (XHR → re-render), so the sync check
 * returned `confirmed:false` even though the file LANDED — agents then
 * retried into duplicates (phantom-failure trap, 2026-08-30 note).
 */
export function uploadVerdict(shown) {
  if (shown === true) {
    return {
      confirmed: 'preview-visible',
      note: 'Drop dispatched and page shows the filename.',
    };
  }
  return {
    confirmed: 'unconfirmed',
    note: 'Drop dispatched but no filename preview detected — verify visually before claiming success.',
  };
}
