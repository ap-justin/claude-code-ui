#!/usr/bin/env python3
"""minimal http server for browsing ~/.claude/plans/ markdown files."""

import json
import os
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

PLANS_DIR = Path.home() / ".claude" / "plans"
STATIC_DIR = Path(__file__).parent / "static"
PORT = 3117


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self):
        path = unquote(self.path)

        if path == "/api/plans":
            self._serve_plan_list()
        elif path.startswith("/api/plans/"):
            filename = path[len("/api/plans/"):]
            self._serve_plan(filename)
        else:
            super().do_GET()

    def do_DELETE(self):
        path = unquote(self.path)
        if path.startswith("/api/plans/"):
            filename = path[len("/api/plans/"):]
            self._delete_plan(filename)
        else:
            self.send_error(404)

    def do_PUT(self):
        path = unquote(self.path)
        if path.startswith("/api/plans/"):
            filename = path[len("/api/plans/"):]
            self._update_plan(filename)
        else:
            self.send_error(404)

    def do_POST(self):
        path = unquote(self.path)
        if path == "/api/plans/delete-batch":
            self._delete_batch()
        elif path.startswith("/api/plans/") and path.endswith("/rename"):
            # /api/plans/<name>/rename
            filename = path[len("/api/plans/"):-len("/rename")]
            self._rename_plan(filename)
        else:
            self.send_error(404)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length)

    def _validate_path(self, filename):
        """returns resolved path if safe, else None (sends error)."""
        filepath = PLANS_DIR / filename
        if filepath.resolve().parent != PLANS_DIR.resolve():
            self.send_error(403)
            return None
        return filepath

    def _serve_plan_list(self):
        plans = []
        for f in PLANS_DIR.iterdir():
            if f.suffix == ".md":
                plans.append({
                    "name": f.name,
                    "modified": f.stat().st_mtime,
                })
        plans.sort(key=lambda p: p["modified"], reverse=True)
        self._json_response(plans)

    def _serve_plan(self, filename):
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        content = filepath.read_text(encoding="utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _delete_plan(self, filename):
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        filepath.unlink()
        self._json_response({"ok": True})

    def _delete_batch(self):
        body = json.loads(self._read_body())
        deleted = []
        for name in body.get("files", []):
            filepath = PLANS_DIR / name
            if filepath.resolve().parent == PLANS_DIR.resolve() and filepath.exists():
                filepath.unlink()
                deleted.append(name)
        self._json_response({"deleted": deleted})

    def _update_plan(self, filename):
        """overwrite plan content."""
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        content = self._read_body().decode("utf-8")
        filepath.write_text(content, encoding="utf-8")
        self._json_response({"ok": True})

    def _rename_plan(self, filename):
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        body = json.loads(self._read_body())
        new_name = body.get("name", "")
        if not new_name.endswith(".md"):
            new_name += ".md"
        new_path = self._validate_path(new_name)
        if not new_path:
            return
        if new_path.exists():
            self.send_error(409)
            return
        filepath.rename(new_path)
        self._json_response({"ok": True, "name": new_name})

    def _json_response(self, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # quieter logging
        pass


PLIST_LABEL = "com.claude-code-ui.server"
PLIST_PATH = Path.home() / "Library/LaunchAgents" / f"{PLIST_LABEL}.plist"


def install_launchd():
    """install a launchd agent so the server starts on login."""
    server_py = Path(__file__).resolve()
    python = sys.executable
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python}</string>
        <string>{server_py}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-code-ui.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-code-ui.log</string>
</dict>
</plist>"""
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(plist)
    # load immediately
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST_PATH)],
                   capture_output=True)
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST_PATH)],
                   check=True)
    print(f"installed launch agent: {PLIST_PATH}")
    print("server will now auto-start on login.")


def uninstall_launchd():
    """remove the launchd agent."""
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST_PATH)],
                   capture_output=True)
    if PLIST_PATH.exists():
        PLIST_PATH.unlink()
    print("launch agent removed.")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] == "install":
            install_launchd()
            sys.exit(0)
        elif sys.argv[1] == "uninstall":
            uninstall_launchd()
            sys.exit(0)
        else:
            print(f"usage: {sys.argv[0]} [install|uninstall]")
            sys.exit(1)

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()
