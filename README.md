# claude-code-ui

Minimal PWA for browsing Claude Code plan files (`~/.claude/plans/`).

## Usage

```bash
git clone https://github.com/ap-justin/claude-code-ui.git
cd claude-code-ui
python3 server.py
```

Open http://localhost:3117 — no dependencies beyond Python 3.

### Install as app

In Chrome, click the install icon in the address bar to add it as a standalone app.

## Features

- sidebar with search/filter, sorted by recency
- markdown rendering via marked.js
- edit plans inline (markdown editor with cmd+s to save)
- rename plans
- delete single or batch delete via multiselect
