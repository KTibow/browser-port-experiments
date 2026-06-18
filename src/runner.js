// Boots a browser/OS inside v86 (WASM CPU + canvas) with Wisp networking.
// URL params:
//   os        - id from browsers.json (required)
//   cdn       - override image CDN host (default from registry)
//   relay_url - override Wisp relay (default from registry, wisps://anura.pro/)
import { V86 } from "./vendor/libv86.mjs";
import { formatDownload } from "./download-format.mjs";

const qs = new URLSearchParams(location.search);
const osId = qs.get("os");

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const engineEl = document.getElementById("engine");
const netEl = document.getElementById("net");
const screenContainer = document.getElementById("screen_container");
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progress_bar");
const progressLabel = document.getElementById("progress_label");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind || "";
}

function fatal(msg) {
  setStatus(msg, "error");
  console.error("[runner]", msg);
}

function fmtMB(bytes) {
  const mb = bytes / 1048576;
  if (mb >= 100) return mb.toFixed(0) + " MB";
  if (mb >= 10) return mb.toFixed(1) + " MB";
  if (mb >= 1) return mb.toFixed(2) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

// Visual loading progress bar. Shown while the OS image / saved state streams in
// (a big deal for the multi-hundred-MB Windows / Android images, which used to
// show only a number). Exposed on window so tests can drive it deterministically
// without depending on network timing.
let progressDone = false;
function showProgress(loaded, total, name) {
  if (!progressEl || progressDone) return;
  progressEl.hidden = false;
  const label = shortName(name || "image");
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, (100 * loaded) / total));
    progressBar.classList.remove("is-indeterminate");
    progressBar.style.width = pct.toFixed(1) + "%";
    progressLabel.textContent = `Downloading ${label} \u2014 ${Math.floor(pct)}% (${fmtMB(loaded)} / ${fmtMB(total)})`;
  } else {
    // Unknown total: indeterminate sweep + bytes-so-far.
    progressBar.classList.add("is-indeterminate");
    progressLabel.textContent = loaded > 0
      ? `Downloading ${label} \u2014 ${fmtMB(loaded)}\u2026`
      : `Downloading ${label}\u2026`;
  }
}
function hideProgress() {
  progressDone = true;
  if (!progressEl) return;
  progressBar.classList.remove("is-indeterminate");
  progressBar.style.width = "100%";
  progressEl.hidden = true;
}
// Test/console hook: window.__onDownloadProgress({file_name, loaded, total}).
window.__onDownloadProgress = (e) => {
  if (!e || progressDone) return;
  showProgress(Number(e.loaded) || 0, Number(e.total) || 0, e.file_name);
};

// Populate and wire the Wisp relay picker. Switching relays reloads the page
// with ?relay_url= (the relay must be set when v86's net device is created).
function setupRelayPicker(registry, currentRelay) {
  const sel = document.getElementById("relay");
  if (!sel) return;
  const list = Array.isArray(registry.relays) && registry.relays.length
    ? registry.relays
    : [{ url: registry.relay || "wisps://anura.pro/", label: "default" }];

  sel.innerHTML = "";
  let matched = false;
  for (const r of list) {
    const opt = document.createElement("option");
    opt.value = r.url;
    opt.textContent = r.label || r.url;
    if (r.url === currentRelay) { opt.selected = true; matched = true; }
    sel.appendChild(opt);
  }
  // If the active relay (e.g. from ?relay_url=) isn't a preset, show it too.
  if (!matched) {
    const opt = document.createElement("option");
    opt.value = currentRelay;
    opt.textContent = currentRelay + " (current)";
    opt.selected = true;
    sel.appendChild(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom\u2026";
  sel.appendChild(customOpt);

  sel.addEventListener("change", () => {
    let next = sel.value;
    if (next === "__custom__") {
      next = (window.prompt("Wisp relay URL (wisps:// or wss://):", currentRelay) || "").trim();
      if (!next) { sel.value = currentRelay; return; }
    }
    if (next === currentRelay) return;
    const u = new URL(location.href);
    u.searchParams.set("relay_url", next);
    location.assign(u.toString());
  });
}

// Prepend the CDN host to a disk descriptor's url (unless it is already absolute).
// Resilience: an image may carry a same-origin `mirror` path (we self-host the
// small critical images so a copy.sh outage can't break the flagship, the
// @smoke deploy gate, or the @network proof). We prefer the mirror unless the
// visitor forced a source with `?cdn=` (e.g. ?cdn=https://i.copy.sh/).
function resolveImage(host, img, preferMirror) {
  if (!img) return img;
  const out = { ...img };
  const useMirror = preferMirror && out.mirror;
  if (useMirror) {
    out.url = new URL(out.mirror, location.href).href; // same-origin absolute URL
  } else if (out.url && !/^(https?:)?\/\//.test(out.url)) {
    out.url = host + out.url;
  }
  delete out.mirror;
  return out;
}

async function main() {
  if (!osId) return fatal("No ?os= specified.");

  let registry;
  try {
    registry = await (await fetch("browsers.json", { cache: "no-cache" })).json();
  } catch (e) {
    return fatal("Could not load browsers.json: " + e);
  }

  const entry = registry.browsers.find((b) => b.id === osId);
  if (!entry) return fatal(`Unknown browser id: ${osId}`);

  document.title = `${entry.name} \u2014 Browser Port Experiments`;
  titleEl.textContent = entry.name;
  engineEl.textContent = entry.engine;

  // Up-front download-size hint: tell visitors the data commitment *before* a
  // big image starts streaming (e.g. Android is ~236 MB).
  const dlEl = document.getElementById("dlsize");
  const dl = formatDownload(entry);
  if (dlEl && dl) {
    dlEl.textContent = dl.chip;
    dlEl.title = dl.title;
    dlEl.setAttribute("aria-label", dl.title);
    dlEl.hidden = false;
  }

  // Touch / coarse-pointer device? (mobile, tablet). Drives the touch help text.
  const isTouch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
    || (navigator.maxTouchPoints || 0) > 0
    || "ontouchstart" in window;

  const hintParts = [];
  if (isTouch) {
    hintParts.push("\uD83D\uDC46 Touch: drag to move the pointer \u00b7 tap = click \u00b7 long-press = right-click \u00b7 \u2328 = keyboard.");
  }
  if (entry.hint) hintParts.push(`\uD83D\uDCA1 ${entry.hint}`);
  if (hintParts.length) {
    const hintEl = document.getElementById("hint");
    hintEl.textContent = hintParts.join("  \u2014  ");
    hintEl.hidden = false;
    hintEl.title = "Click to dismiss";
    hintEl.onclick = () => { hintEl.hidden = true; };
  }

  const cdnOverride = qs.get("cdn");
  const host = cdnOverride || registry.cdn || "https://i.copy.sh/";
  // Prefer our self-hosted mirror unless the visitor explicitly forced a CDN.
  const preferMirror = cdnOverride == null;
  const relayUrl = qs.get("relay_url") || registry.relay || "wisps://anura.pro/";
  const cfg = entry.config || {};

  netEl.textContent = `Wisp: ${relayUrl}`;
  setupRelayPicker(registry, relayUrl);

  const opts = {
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/bios/seabios.bin" },
    vga_bios: { url: "vendor/bios/vgabios.bin" },
    screen: { container: screenContainer },
    autostart: true,
    net_device: {
      type: cfg.net_device_type || "ne2k",
      relay_url: relayUrl,
    },
  };

  // Disk / memory / misc options copied straight from the registry config.
  const passthrough = [
    "memory_size",
    "vga_memory_size",
    "acpi",
    "mac_address_translation",
    "cpuid_level",
    "cmdline",
    "bzimage_initrd_from_filesystem",
    "boot_order",
  ];
  for (const k of passthrough) if (k in cfg) opts[k] = cfg[k];

  let usedMirror = false;
  for (const k of ["fda", "fdb", "hda", "hdb", "cdrom", "bzimage", "initrd", "multiboot"]) {
    if (cfg[k]) {
      if (preferMirror && cfg[k].mirror) usedMirror = true;
      opts[k] = resolveImage(host, cfg[k], preferMirror);
    }
  }
  if (cfg.state) {
    if (preferMirror && cfg.state.mirror) usedMirror = true;
    opts.initial_state = resolveImage(host, cfg.state, preferMirror);
  }
  window.__usedMirror = usedMirror; // exposed for resilience tests
  if (cfg.filesystem) {
    opts.filesystem = { ...cfg.filesystem };
    if (cfg.filesystem.baseurl && !/^(https?:)?\/\//.test(cfg.filesystem.baseurl)) {
      opts.filesystem.baseurl = host + cfg.filesystem.baseurl;
    }
    if (cfg.filesystem.basefs?.url && !/^(https?:)?\/\//.test(cfg.filesystem.basefs.url)) {
      opts.filesystem.basefs = { ...cfg.filesystem.basefs, url: host + cfg.filesystem.basefs.url };
    }
  } else {
    opts.filesystem = {};
  }

  setStatus(
    usedMirror ? "Loading (self-hosted)\u2026" : cfg.state ? "Streaming saved state\u2026" : "Loading\u2026",
    "busy"
  );

  let emulator;
  try {
    emulator = new V86(opts);
  } catch (e) {
    return fatal("Failed to start v86: " + e);
  }
  window.__emulator = emulator; // expose for tests / console

  let bootStarted = false;
  emulator.add_listener("download-progress", (e) => {
    if (bootStarted || !e) return;
    showProgress(Number(e.loaded) || 0, Number(e.total) || 0, e.file_name);
  });

  emulator.add_listener("emulator-ready", () => {
    setStatus("CPU running\u2026", "busy");
  });

  emulator.add_listener("emulator-started", () => {
    bootStarted = true;
    hideProgress();
    setStatus("Running", "ok");
    // Some guests (e.g. DSL's Syslinux) pause at an interactive boot prompt and
    // require a keypress to continue. `autokeys` lets the registry boot them
    // unattended: a list of { delay(ms after start), text } sent into the guest.
    // An item may instead carry `scancodes` (an array of raw PS/2 set-1 codes,
    // make + break) for keys that have no text form, e.g. function keys: QNX's
    // Photon Display Configuration dialog is dismissed with F2 (= [0x3c,0xbc]).
    if (Array.isArray(cfg.autokeys)) {
      for (const k of cfg.autokeys) {
        const delay = Number(k.delay) || 0;
        const text = typeof k.text === "string" ? k.text : "";
        const scancodes = Array.isArray(k.scancodes) ? k.scancodes : null;
        if (!text && !scancodes) continue;
        setTimeout(() => {
          try {
            if (scancodes) emulator.keyboard_send_scancodes(scancodes);
            else emulator.keyboard_send_text(text);
          } catch (e) { console.warn("autokeys", e); }
        }, delay);
      }
    }
  });

  // Track Wisp / network activity so we can show it is actually connected.
  let sawNet = false;
  emulator.add_listener("net0-send", () => {
    if (!sawNet) {
      sawNet = true;
      window.__sawNetSend = true;
      netEl.textContent = `Wisp: connected (${relayUrl})`;
      netEl.dataset.kind = "ok";
    }
  });
  emulator.add_listener("net0-receive", () => {
    window.__sawNetReceive = true;
    netEl.dataset.kind = "ok";
  });

  wireControls(emulator, screenContainer);
  setupTouchControls(emulator, screenContainer);
}

// Touch support. v86's mouse adapter already turns a finger drag into relative
// mouse-delta (trackpad-style: drag to move the guest cursor), but it has no
// tap-to-click. Here we add: tap → left click, long-press → right click. We send
// on v86's input bus (the public V86 wrapper has no mouse_click method). A tap
// clicks wherever the cursor currently is (the guest mouse is relative-PS/2, so
// we can't jump to an absolute spot) — hence the "drag then tap" trackpad model.
function setupTouchControls(emulator, container) {
  const TAP_MAX_MS = 350;
  const MOVE_THRESHOLD = 12; // px before a touch counts as a drag, not a tap
  const LONGPRESS_MS = 500;
  let startX = 0, startY = 0, startT = 0, moved = false, handled = false;
  let lpTimer = 0, multi = false;

  function click(right) {
    try {
      emulator.bus.send("mouse-click", right ? [false, false, true] : [true, false, false]);
      setTimeout(() => {
        try { emulator.bus.send("mouse-click", [false, false, false]); } catch {}
      }, 45);
      window.__lastTouchClick = right ? "right" : "left"; // exposed for tests
    } catch (e) { /* emulator/bus not ready yet — ignore */ }
  }

  container.addEventListener("touchstart", (e) => {
    if (e.touches.length > 1) { multi = true; clearTimeout(lpTimer); return; }
    multi = false;
    const t = e.changedTouches[0];
    startX = t.clientX; startY = t.clientY; startT = Date.now();
    moved = false; handled = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (!moved && !multi) {
        handled = true;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
        click(true);
      }
    }, LONGPRESS_MS);
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (multi) return;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - startX) > MOVE_THRESHOLD ||
        Math.abs(t.clientY - startY) > MOVE_THRESHOLD) {
      moved = true;
      clearTimeout(lpTimer);
    }
  }, { passive: true });

  container.addEventListener("touchend", (e) => {
    clearTimeout(lpTimer);
    if (multi) { if (e.touches.length === 0) multi = false; return; }
    if (handled) return; // a long-press already fired a right click
    const dt = Date.now() - startT;
    if (!moved && dt <= TAP_MAX_MS) {
      // Stop the browser's synthesized mouse events so v86's window mouse
      // listeners don't fire a second (duplicate) click.
      if (e.cancelable) e.preventDefault();
      click(false);
    }
  }, { passive: false });
}

function shortName(u) {
  try { return u.split("/").pop().split("?")[0] || u; } catch { return u; }
}

function wireControls(emulator, container) {
  const btn = (id) => document.getElementById(id);

  btn("ctrlaltdel").onclick = () => {
    emulator.keyboard_send_scancodes([0x1d, 0x38, 0x53, 0xd3, 0xb8, 0x9d]);
  };
  btn("restart").onclick = () => {
    setStatus("Restarting\u2026", "busy");
    emulator.restart();
  };
  btn("pause").onclick = () => {
    if (emulator.is_running()) {
      emulator.stop();
      btn("pause").textContent = "Resume";
      setStatus("Paused", "");
    } else {
      emulator.run();
      btn("pause").textContent = "Pause";
      setStatus("Running", "ok");
    }
  };
  btn("fullscreen").onclick = () => {
    if (container.requestFullscreen) container.requestFullscreen();
  };

  // On-screen keyboard toggle (mobile): focusing #phonekbd raises the soft
  // keyboard; v86 forwards keys typed into a .phone_keyboard element to the
  // guest. Toggling again blurs it (hides the keyboard).
  const phoneKbd = document.getElementById("phonekbd");
  const kbdToggle = btn("kbdtoggle");
  if (kbdToggle && phoneKbd) {
    // Keep focus on #phonekbd when the button is pressed, otherwise the button
    // would steal focus before onclick runs and the toggle could never close.
    kbdToggle.addEventListener("mousedown", (e) => e.preventDefault());
    kbdToggle.onclick = () => {
      if (document.activeElement === phoneKbd) {
        phoneKbd.blur();
        kbdToggle.classList.remove("is-active");
      } else {
        phoneKbd.focus();
        kbdToggle.classList.add("is-active");
      }
    };
    // Keep the button state in sync if focus changes by other means (e.g. the
    // user taps the guest screen, which blurs the keyboard).
    phoneKbd.addEventListener("blur", () => kbdToggle.classList.remove("is-active"));
    phoneKbd.addEventListener("focus", () => kbdToggle.classList.add("is-active"));
  }

  // Type-into-guest helper.
  const sendInput = document.getElementById("sendtext");
  btn("sendbtn").onclick = () => {
    const text = sendInput.value;
    if (text) emulator.keyboard_send_text(text);
    sendInput.value = "";
    sendInput.focus();
  };
  sendInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      emulator.keyboard_send_text(sendInput.value + "\n");
      sendInput.value = "";
    }
  });
}

main();
