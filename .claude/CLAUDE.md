<!-- kru v0.148.0 · derived 2026-10-16 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the team works.

- **server** → `kru:python-developer` — `server.py` (stdlib only, serves `~/.claude/plans/` on :3117)
- **pwa** — `static/` (`app.js`, `sw.js`, `styles.css`, `index.html`), vanilla JS with marked.js and no build step; no plugin seat covers it, so edits run inline
- **screens** — `python3 server.py` → http://localhost:3117
- **verify** — `npx biome check` (@biomejs/biome 2.5.0); `npm test` is the placeholder stub, no real suite

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would need — never a nearby seat pressed into the gap.
