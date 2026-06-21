#!/usr/bin/env python3
"""minimal http server for browsing ~/.claude/plans/ markdown files."""

import html
import json
import os
import re
import signal
import subprocess
import uuid
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

PLANS_DIR = Path.home() / ".claude" / "plans"
STATIC_DIR = Path(__file__).parent / "static"
FAVORITES_FILE = PLANS_DIR / ".favorites.json"
HANDOFFS_DIR = Path(os.environ.get("TMPDIR", "/tmp"))
HANDOFF_RE = re.compile(r"^handoff-[A-Za-z0-9._-]+\.md$")
PORT = 3117

# inline comments are stored as a JSON block in an HTML comment at end of file
COMMENTS_MARKER = "<!-- __comments__"
COMMENTS_END = "-->"


def _load_favorites():
    if FAVORITES_FILE.exists():
        try:
            return set(json.loads(FAVORITES_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, TypeError):
            pass
    return set()


def _save_favorites(favs):
    FAVORITES_FILE.write_text(json.dumps(sorted(favs)), encoding="utf-8")


def _gen_id(prefix=""):
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _parse_plan_file(filepath):
    """split plan file into (content, threads_list)."""
    raw = filepath.read_text(encoding="utf-8")
    idx = raw.find(COMMENTS_MARKER)
    if idx == -1:
        return raw, []
    content = raw[:idx].rstrip("\n")
    json_start = idx + len(COMMENTS_MARKER)
    json_end = raw.find(COMMENTS_END, json_start)
    if json_end == -1:
        return content, []
    try:
        threads = json.loads(raw[json_start:json_end].strip())
    except (json.JSONDecodeError, TypeError):
        threads = []
    return content, threads


def _write_plan_file(filepath, content, threads):
    """write plan content with inline comments block."""
    parts = [content.rstrip("\n")]
    if threads:
        parts.append("")
        parts.append(COMMENTS_MARKER)
        parts.append(json.dumps(threads, separators=(",", ":")))
        parts.append(COMMENTS_END)
    parts.append("")  # trailing newline
    filepath.write_text("\n".join(parts), encoding="utf-8")


def _threads_for_plan(plan):
    """return threads list for a plan file."""
    filepath = PLANS_DIR / plan
    if not filepath.exists():
        return []
    _, threads = _parse_plan_file(filepath)
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
        elif parsed.path == "/api/handoffs/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            self._search_handoffs(query)
        elif path == "/api/plans":
            self._serve_plan_list()
        elif path == "/api/handoffs":
            self._serve_handoff_list()
        elif path == "/api/favorites":
            self._json_response(sorted(_load_favorites()))
        elif path.startswith("/api/comments/"):
            filename = path[len("/api/comments/"):]
            self._get_comments(filename)
        elif path.startswith("/api/handoffs/"):
            filename = path[len("/api/handoffs/"):]
            self._serve_handoff(filename)
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
                content, _ = _parse_plan_file(f)
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

    def _validate_handoff(self, filename):
        if not HANDOFF_RE.match(filename):
            self.send_error(403)
            return None
        filepath = HANDOFFS_DIR / filename
        try:
            if filepath.resolve().parent != HANDOFFS_DIR.resolve():
                self.send_error(403)
                return None
        except OSError:
            self.send_error(403)
            return None
        return filepath

    def _list_handoff_files(self):
        try:
            return [f for f in HANDOFFS_DIR.iterdir()
                    if f.is_file() and HANDOFF_RE.match(f.name)]
        except OSError:
            return []

    def _serve_handoff_list(self):
        items = []
        for f in self._list_handoff_files():
            try:
                items.append({"name": f.name, "modified": f.stat().st_mtime, "path": str(f)})
            except OSError:
                continue
        items.sort(key=lambda p: -p["modified"])
        self._json_response(items)

    def _serve_handoff(self, filename):
        filepath = self._validate_handoff(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        try:
            content = filepath.read_text(encoding="utf-8")
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _search_handoffs(self, query):
        q = query.lower()
        if not q:
            self._serve_handoff_list()
            return
        results = []
        for f in self._list_handoff_files():
            try:
                content = f.read_text(encoding="utf-8")
                mtime = f.stat().st_mtime
            except OSError:
                continue
            name_match = q in f.name.lower()
            snippet = None
            idx = content.lower().find(q)
            if idx >= 0:
                start = max(0, idx - 50)
                end = min(len(content), idx + len(query) + 50)
                raw = content[start:end]
                escaped = html.escape(raw)
                pattern = re.compile(re.escape(html.escape(query)), re.IGNORECASE)
                escaped = pattern.sub(lambda m: f"<mark>{m.group()}</mark>", escaped)
                prefix = "…" if start > 0 else ""
                suffix = "…" if end < len(content) else ""
                snippet = prefix + escaped + suffix
            if name_match or snippet is not None:
                results.append({"name": f.name, "modified": mtime, "path": str(f), "snippet": snippet})
        results.sort(key=lambda p: -p["modified"])
        self._json_response(results)

    def _serve_plan(self, filename):
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        content, _ = _parse_plan_file(filepath)
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
        self._json_response({"deleted": deleted})

    def _update_plan(self, filename):
        """overwrite plan content, preserving inline comments."""
        filepath = self._validate_path(filename)
        if not filepath:
            return
        if not filepath.exists():
            self.send_error(404)
            return
        content = self._read_body().decode("utf-8")
        _, threads = _parse_plan_file(filepath)
        _write_plan_file(filepath, content, threads)
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
        filepath = self._validate_path(filename)
        if not filepath or not filepath.exists():
            self.send_error(404)
            return
        body = json.loads(self._read_body())
        thread_id = _gen_id("t_")
        comment_id = _gen_id("c_")
        now = _now()
        thread = {
            "id": thread_id,
            "selectedText": body["selectedText"],
            "prefix": body.get("prefix", ""),
            "suffix": body.get("suffix", ""),
            "resolved": False,
            "createdAt": now,
            "comments": [{"id": comment_id, "body": body["body"], "createdAt": now}],
        }
        content, threads = _parse_plan_file(filepath)
        threads.append(thread)
        _write_plan_file(filepath, content, threads)
        self._json_response(thread)

    def _reply_thread(self, filename, thread_id):
        filepath = self._validate_path(filename)
        if not filepath or not filepath.exists():
            self.send_error(404)
            return
        body = json.loads(self._read_body())
        comment_id = _gen_id("c_")
        now = _now()
        content, threads = _parse_plan_file(filepath)
        for t in threads:
            if t["id"] == thread_id:
                t["comments"].append({"id": comment_id, "body": body["body"], "createdAt": now})
                break
        _write_plan_file(filepath, content, threads)
        self._json_response({"id": comment_id, "body": body["body"], "createdAt": now})

    def _resolve_thread(self, filename, thread_id):
        filepath = self._validate_path(filename)
        if not filepath or not filepath.exists():
            self.send_error(404)
            return
        content, threads = _parse_plan_file(filepath)
        for t in threads:
            if t["id"] == thread_id:
                t["resolved"] = True
                break
        _write_plan_file(filepath, content, threads)
        self._json_response({"ok": True})

    def _delete_thread(self, filename, thread_id):
        filepath = self._validate_path(filename)
        if not filepath or not filepath.exists():
            self.send_error(404)
            return
        content, threads = _parse_plan_file(filepath)
        threads = [t for t in threads if t["id"] != thread_id]
        _write_plan_file(filepath, content, threads)
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
    server = ReusableHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()
