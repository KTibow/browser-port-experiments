export const DEFAULT_WISP_URL = 'wss://anura.pro/';

export const browsers = [
  {
    id: 'iframe-shell',
    name: 'Baseline Iframe Browser Shell',
    status: 'working-limited',
    kind: 'browser chrome',
    path: '#/browser/iframe-shell',
    summary:
      'A small browser UI with URL bar, history, reload, home, and an iframe viewport. It is useful as a control and UX harness while real WASM engines land.',
    engine: 'Host browser iframe',
    networking: 'Host browser networking; Wisp endpoint is stored for ports that need a socket bridge.',
    tested: 'Production build, registry invariants, and Playwright Chromium route smoke test.',
    limitations: [
      'Sites that set X-Frame-Options or CSP frame-ancestors will refuse to load.',
      'It reuses the host browser engine instead of porting an independent engine.',
    ],
  },
];

export const plannedPorts = [
  {
    id: 'netsurf-wasm',
    name: 'NetSurf WASM',
    priority: 1,
    rationale:
      'Small C browser engine with framebuffer front ends; likely the fastest path to a real independent web engine in WASM.',
  },
  {
    id: 'ladybird-engine',
    name: 'Ladybird/LibWeb experiment',
    priority: 2,
    rationale:
      'Modern engine with useful coverage. Harder C++/POSIX port, but worth early feasibility research.',
  },
  {
    id: 'servo-shell',
    name: 'Servo shell',
    priority: 3,
    rationale:
      'A high-value Rust engine; determine whether current Servo can target wasm32 with a canvas/WebGPU shell.',
  },
];

export function getBrowser(id) {
  return browsers.find((browser) => browser.id === id);
}
