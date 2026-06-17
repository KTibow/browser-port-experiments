// Boots a browser/OS inside v86 (WASM CPU + canvas) with Wisp networking.
// URL params:
//   os        - id from browsers.json (required)
//   cdn       - override image CDN host (default from registry)
//   relay_url - override Wisp relay (default from registry, wisps://anura.pro/)
import { V86 } from "./vendor/libv86.mjs";

const qs = new URLSearchParams(location.search);
const osId = qs.get("os");

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const engineEl = document.getElementById("engine");
const netEl = document.getElementById("net");
const screenContainer = document.getElementById("screen_container");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind || "";
}

function fatal(msg) {
  setStatus(msg, "error");
  console.error("[runner]", msg);
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

  if (entry.hint) {
    const hintEl = document.getElementById("hint");
    hintEl.textContent = `\uD83D\uDCA1 ${entry.hint}`;
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
    if (bootStarted) return;
    if (e.file_name && e.total) {
      const pct = Math.floor((100 * e.loaded) / e.total);
      setStatus(`Downloading ${shortName(e.file_name)} \u2014 ${pct}%`, "busy");
    }
  });

  emulator.add_listener("emulator-ready", () => {
    setStatus("CPU running\u2026", "busy");
  });

  emulator.add_listener("emulator-started", () => {
    bootStarted = true;
    setStatus("Running", "ok");
    // Some guests (e.g. DSL's Syslinux) pause at an interactive boot prompt and
    // require a keypress to continue. `autokeys` lets the registry boot them
    // unattended: a list of { delay(ms after start), text } sent into the guest.
    if (Array.isArray(cfg.autokeys)) {
      for (const k of cfg.autokeys) {
        const delay = Number(k.delay) || 0;
        const text = typeof k.text === "string" ? k.text : "";
        if (!text) continue;
        setTimeout(() => {
          try { emulator.keyboard_send_text(text); } catch (e) { console.warn("autokeys", e); }
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
