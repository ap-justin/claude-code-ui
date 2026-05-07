#!/usr/bin/env python3
"""minimal http server for browsing ~/.claude/plans/ markdown files."""

import html
import json
import os
import re
import signal
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

PLANS_DIR = Path.home() / ".claude" / "plans"
STATIC_DIR = Path(__file__).parent / "static"
FAVORITES_FILE = PLANS_DIR / ".favorites.json"
DB_PATH = PLANS_DIR / "comments.db"
PORT = 3117


def _load_favorites():
    if FAVORITES_FILE.exists():
        try:
            return set(json.loads(FAVORITES_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, TypeError):
            pass
    return set()


def _save_favorites(favs):
    FAVORITES_FILE.write_text(json.dumps(sorted(favs)), encoding="utf-8")


def _init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            plan TEXT NOT NULL,
            selected_text TEXT NOT NULL,
            prefix TEXT NOT NULL DEFAULT '',
            suffix TEXT NOT NULL DEFAULT '',
            resolved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_threads_plan ON threads(plan);
        CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);
    """)
    conn.close()


def _get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _gen_id(prefix=""):
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _threads_for_plan(plan):
    """return nested thread+comments structure for a plan."""
    db = _get_db()
    rows = db.execute(
        "SELECT * FROM threads WHERE plan = ? ORDER BY created_at", (plan,)
    ).fetchall()
    threads = []
    for r in rows:
        comments = db.execute(
            "SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at",
            (r["id"],),
        ).fetchall()
        threads.append({
            "id": r["id"],
            "selectedText": r["selected_text"],
            "prefix": r["prefix"],
            "suffix": r["suffix"],
            "resolved": bool(r["resolved"]),
            "createdAt": r["created_at"],
            "comments": [
                {"id": c["id"], "body": c["body"], "createdAt": c["created_at"]}
                for c in comments
            ],
        })
    db.close()
    return threads


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self):
        path = unquote(self.path)

        parsed = urlparse(path)

        if parsed.path == "/api/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._search_plans(query)
        elif path == "/api/plans":
            self._serve_plan_list()
        elif path == "/api/favorites":
            self._json_response(sorted(_load_favorites()))
        elif path.startswith("/api/comments/"):
            filename = path[len("/api/comments/"):]
            self._get_comments(filename)
        elif path.startswith("/api/plans/"):
            filename = path[len("/api/plans/"):]
            self._serve_plan(filename)
        else:
            super().do_GET()

    def do_DELETE(self):
        path = unquote(self.path)
        if path.startswith("/api/comments/"):
            # /api/comments/<plan>/<threadId>
            rest = path[len("/api/comments/"):]
            parts = rest.split("/", 1)
            if len(parts) == 2:
                self._delete_thread(parts[0], parts[1])
            else:
                self.send_error(404)
        elif path.startswith("/api/plans/"):
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
        elif path.startswith("/api/comments/"):
            rest = path[len("/api/comments/"):]
            if rest.endswith("/resolve"):
                # /api/comments/<plan>/<threadId>/resolve
                parts = rest[:-len("/resolve")].split("/", 1)
                if len(parts) == 2:
                    self._resolve_thread(parts[0], parts[1])
                else:
                    self.send_error(404)
            elif "/reply" in rest:
                # /api/comments/<plan>/<threadId>/reply
                parts = rest[:-len("/reply")].split("/", 1)
                if len(parts) == 2:
                    self._reply_thread(parts[0], parts[1])
                else:
                    self.send_error(404)
            else:
                # /api/comments/<plan> — create thread
                self._create_thread(rest)
        elif path.startswith("/api/favorites/"):
            filename = path[len("/api/favorites/"):]
            self._toggle_favorite(filename)
        elif path.startswith("/api/plans/") and path.endswith("/rename"):
            # /api/plans/<name>/rename
            filename = path[len("/api/plans/"):-len("/rename")]
            self._rename_plan(filename)
        elif path.startswith("/api/plans/") and path.endswith("/duplicate"):
            filename = path[len("/api/plans/"):-len("/duplicate")]
            self._duplicate_plan(filename)
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
        favs = _load_favorites()
        plans = []
        for f in PLANS_DIR.iterdir():
            if f.suffix == ".md":
                plans.append({
                    "name": f.name,
                    "modified": f.stat().st_mtime,
                    "favorited": f.name in favs,
                })
        # favorites first, then by modified desc
        plans.sort(key=lambda p: (not p["favorited"], -p["modified"]))
        self._json_response(plans)

    def _search_plans(self, query):
        """search plans by filename and content."""
        favs = _load_favorites()
        results = []
        q = query.lower()
        if not q:
            self._serve_plan_list()
            return
        for f in PLANS_DIR.iterdir():
            if f.suffix != ".md":
                continue
            name_match = q in f.name.lower()
            snippet = None
            try:
                content = f.read_text(encoding="utf-8")
            except Exception:
                content = ""
            # find content match
            idx = content.lower().find(q)
            if idx >= 0:
                # ~100 chars around the match
                start = max(0, idx - 50)
                end = min(len(content), idx + len(query) + 50)
                raw = content[start:end]
                # build snippet with <mark> around match
                escaped = html.escape(raw)
                pattern = re.compile(re.escape(html.escape(query)), re.IGNORECASE)
                escaped = pattern.sub(lambda m: f"<mark>{m.group()}</mark>", escaped)
                prefix = "\u2026" if start > 0 else ""
                suffix = "\u2026" if end < len(content) else ""
                snippet = prefix + escaped + suffix
            if name_match or snippet is not None:
                results.append({
                    "name": f.name,
                    "modified": f.stat().st_mtime,
                    "favorited": f.name in favs,
                    "snippet": snippet,
                })
        results.sort(key=lambda p: (not p["favorited"], -p["modified"]))
        self._json_response(results)

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
        favs = _load_favorites()
        if filename in favs:
            favs.discard(filename)
            _save_favorites(favs)
        # clean up comments
        db = _get_db()
        db.execute("DELETE FROM threads WHERE plan = ?", (filename,))
        db.commit()
        db.close()
        self._json_response({"ok": True})

    def _delete_batch(self):
        body = json.loads(self._read_body())
        deleted = []
        for name in body.get("files", []):
            filepath = PLANS_DIR / name
            if filepath.resolve().parent == PLANS_DIR.resolve() and filepath.exists():
                filepath.unlink()
                deleted.append(name)
        favs = _load_favorites()
        updated = favs - set(deleted)
        if updated != favs:
            _save_favorites(updated)
        # clean up comments
        db = _get_db()
        for name in deleted:
            db.execute("DELETE FROM threads WHERE plan = ?", (name,))
        db.commit()
        db.close()
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
        # carry over favorite
        favs = _load_favorites()
        if filename in favs:
            favs.discard(filename)
            favs.add(new_name)
            _save_favorites(favs)
        # migrate comments
        db = _get_db()
        db.execute("UPDATE threads SET plan = ? WHERE plan = ?", (new_name, filename))
        db.commit()
        db.close()
        self._json_response({"ok": True, "name": new_name})

    def _duplicate_plan(self, filename):
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        content = filepath.read_text(encoding="utf-8")
        stem = filename.rsplit(".md", 1)[0]
        new_name = f"{stem}-copy.md"
        counter = 2
        while (PLANS_DIR / new_name).exists():
            new_name = f"{stem}-copy-{counter}.md"
            counter += 1
        (PLANS_DIR / new_name).write_text(content, encoding="utf-8")
        # carry over favorite status
        favs = _load_favorites()
        if filename in favs:
            favs.add(new_name)
            _save_favorites(favs)
        self._json_response({"ok": True, "name": new_name})

    def _get_comments(self, filename):
        self._json_response(_threads_for_plan(filename))

    def _create_thread(self, filename):
        body = json.loads(self._read_body())
        thread_id = _gen_id("t_")
        comment_id = _gen_id("c_")
        now = _now()
        db = _get_db()
        db.execute(
            "INSERT INTO threads (id, plan, selected_text, prefix, suffix, created_at) VALUES (?,?,?,?,?,?)",
            (thread_id, filename, body["selectedText"], body.get("prefix", ""), body.get("suffix", ""), now),
        )
        db.execute(
            "INSERT INTO comments (id, thread_id, body, created_at) VALUES (?,?,?,?)",
            (comment_id, thread_id, body["body"], now),
        )
        db.commit()
        db.close()
        self._json_response({
            "id": thread_id,
            "selectedText": body["selectedText"],
            "prefix": body.get("prefix", ""),
            "suffix": body.get("suffix", ""),
            "resolved": False,
            "createdAt": now,
            "comments": [{"id": comment_id, "body": body["body"], "createdAt": now}],
        })

    def _reply_thread(self, filename, thread_id):
        body = json.loads(self._read_body())
        comment_id = _gen_id("c_")
        now = _now()
        db = _get_db()
        db.execute(
            "INSERT INTO comments (id, thread_id, body, created_at) VALUES (?,?,?,?)",
            (comment_id, thread_id, body["body"], now),
        )
        db.commit()
        db.close()
        self._json_response({"id": comment_id, "body": body["body"], "createdAt": now})

    def _resolve_thread(self, filename, thread_id):
        db = _get_db()
        db.execute("UPDATE threads SET resolved = 1 WHERE id = ?", (thread_id,))
        db.commit()
        db.close()
        self._json_response({"ok": True})

    def _delete_thread(self, filename, thread_id):
        db = _get_db()
        db.execute("DELETE FROM threads WHERE id = ?", (thread_id,))
        db.commit()
        db.close()
        self._json_response({"ok": True})

    def _toggle_favorite(self, filename):
        favs = _load_favorites()
        if filename in favs:
            favs.discard(filename)
            state = False
        else:
            favs.add(filename)
            state = True
        _save_favorites(favs)
        self._json_response({"name": filename, "favorited": state})

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



class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True

    def server_bind(self):
        import socket
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        super().server_bind()

def _kill_existing(port):
    """kill any process already listening on port, wait for release"""
    import time
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True
        )
        pids = [int(p) for p in result.stdout.strip().splitlines() if int(p) != os.getpid()]
        for pid in pids:
            os.kill(pid, signal.SIGTERM)
            print(f"killed old process {pid}")
        if pids:
            # wait for port to be released
            for _ in range(20):
                r = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
                if not r.stdout.strip():
                    break
                time.sleep(0.1)
    except Exception:
        pass


if __name__ == "__main__":
    _kill_existing(PORT)
    _init_db()
    server = ReusableHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()
