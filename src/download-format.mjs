// Shared helper for the up-front "download size" hint shown both on the landing
// cards and on the runner page, so visitors know the data commitment *before*
// launching a multi-hundred-MB OS image (e.g. Android streams ~236 MB).
//
// Used by scripts/build.mjs (Node, to render the landing-card chip) and by
// src/runner.js (browser, to render the bar note). Keep it dependency-free.
//
// Each browsers.json entry may carry:
//   "download": { "bytes": <approx up-front bytes>, "mode": "full"|"resume"|"stream" }
// where:
//   full   = the whole image is downloaded once (floppy / live-CD ISO).
//   resume = a saved-state .zst is downloaded fully+immediately to resume the
//            desktop; disk parts then stream on demand as you use it.
//   stream = the image streams on demand and the boot reads most of it.

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  const mb = b / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  if (mb >= 10) return Math.round(mb) + " MB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(b / 1024)) + " KB";
}

// Returns null if the entry has no download info, otherwise:
//   { short, chip, title }
//   short = compact pill text for the landing card (e.g. "↓ 28 MB")
//   chip  = slightly more descriptive text for the runner bar (adds a qualifier)
//   title = full sentence for the tooltip / aria-label
export function formatDownload(entry) {
  const d = entry && entry.download;
  if (!d || !(Number(d.bytes) > 0)) return null;
  const size = formatBytes(d.bytes);
  const mode = d.mode || "full";
  const ARROW = "\u2193 "; // ↓

  if (mode === "resume") {
    return {
      short: ARROW + size,
      chip: ARROW + size + " to resume",
      title: `Resumes instantly from a ~${size} saved state; disk parts then stream on demand as you use it.`,
    };
  }
  if (mode === "stream") {
    return {
      short: ARROW + "~" + size,
      chip: ARROW + "~" + size + " streamed",
      title: `Streams ~${size} on demand as it boots \u2014 give it a few minutes on first launch (best on a fast, unmetered connection).`,
    };
  }
  return {
    short: ARROW + size,
    chip: ARROW + size,
    title: `Downloads the full ~${size} image on first launch.`,
  };
}
