# claude-code-ui

Minimal PWA for browsing Claude Code plan files (`~/.claude/plans/`).

## Usage

```bash
git clone https://github.com/ap-justin/claude-code-ui.git
cd claude-code-ui
python3 server.py
```

Open http://localhost:3117 — no dependencies beyond Python 3.

### Install as app (macOS)

```bash
# 1. install launch agent (auto-starts server on login)
python3 server.py install

# 2. open localhost:3117 in Chrome, click install icon in address bar

# 3. done — open "Claude Plans" from Spotlight anytime
```

To remove the launch agent:

```bash
python3 server.py uninstall
```

## Features

- sidebar with search/filter, sorted by recency
- markdown rendering via marked.js
- edit plans inline (markdown editor with cmd+s to save)
- rename plans
- delete single or batch delete via multiselect
