We are trying to port as many useful browsers to the web as possible.

Useful = the browsers that implement many features and tend to be used.

Tips:
- You may use `gh` to read broader GitHub, spawn more `run-agent.yaml`, or anything
- You may use `git` within this repo
- You run on an ephemeral GitHub Actions runner so installing software or running tests is fine/encouraged
- You could synchronize by using Markdown files to plan out work
- You always have to commit and push your work at the end (no more than 6 hours runtime)
- You always have to make sure another agent will keep running, and your agents will keep other agents running once they finish, and so on...
- Always check your work; I trust that you can make good tests and harnesses to actually verify your work works and is usable instead of just compiles
- Don't be afraid of reusing existing libraries or code; after all, the whole point of this project is reusing browsers on the web
- Be ambitious; aim for usefulness; be transparent about pivots

Goal:
- GitHub Actions build -> GitHub Pages deployment
- Root page (kendell.dev/browser-port-experiments/?) has links to each browser (or engine, if we really can't port over the chrome) we have
- Each browser works completely in your browser, and this has been rigorously tested to actually function
- Logic probably uses WASM
- Graphics probably use canvases and ideally acceleration
- Networking probably uses [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) defaulted to `wss://anura.pro`

Good luck!
