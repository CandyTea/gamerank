#!/usr/bin/env python3
"""GameRank shared-board server.

Single-file, standard-library-only service that stores named ranking boards so
two people can see each other's lists. SQLite for storage, token auth for
writes and reads.

    GAMERANK_TOKEN=secret python gamerank_server.py --port 8787 --db boards.db

Optional: --static DIR also serves the site (index.html, data/games.js, ...),
so one process can host everything behind nginx or directly.

API (all JSON, all require X-GameRank-Token except /api/health):

    GET    /api/health                -> {"ok": true}
    GET    /api/boards                -> {"boards": [{id,name,count,revision,updatedAt}]}
    POST   /api/boards   {name}       -> 201 {"board": {…}}
    GET    /api/boards/<id>           -> {"board": {…, ranking, customs}}
    PUT    /api/boards/<id> {name?, ranking?, customs?}  -> {"board": {meta}}
    DELETE /api/boards/<id>           -> 204
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

MAX_BODY = 1024 * 1024          # 1 MiB per board write
MAX_ITEMS = 5000                # ranking / customs entries per board
BOARD_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TOKEN = os.environ.get("GAMERANK_TOKEN", "").strip()
# GAMERANK_OPEN=1 disables authentication: anyone who can reach the server can
# read and write boards. Use it only on a private/unlisted address (same-origin
# auto-connect), never on a public domain.
OPEN_MODE = os.environ.get("GAMERANK_OPEN", "").strip() in ("1", "true", "yes")
STATIC_DIR = None
DB_PATH = "boards.db"

_db_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


# --------------------------------------------------------------------- store

def db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS boards (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   ranking TEXT NOT NULL DEFAULT '[]',
                   customs TEXT NOT NULL DEFAULT '[]',
                   revision INTEGER NOT NULL DEFAULT 1,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               )"""
        )
        _conn.commit()
    return _conn


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def meta_of(row) -> dict:
    ranking = json.loads(row["ranking"] or "[]")
    return {
        "id": row["id"],
        "name": row["name"],
        "count": len(ranking) if isinstance(ranking, list) else 0,
        "revision": row["revision"],
        "updatedAt": row["updated_at"],
    }


def list_boards() -> list[dict]:
    with _db_lock:
        rows = db().execute(
            "SELECT id, name, ranking, revision, updated_at FROM boards ORDER BY created_at"
        ).fetchall()
    return [meta_of(r) for r in rows]


def get_board(board_id: str) -> dict | None:
    with _db_lock:
        row = db().execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    if row is None:
        return None
    board = meta_of(row)
    board["ranking"] = json.loads(row["ranking"] or "[]")
    board["customs"] = json.loads(row["customs"] or "[]")
    return board


def create_board(name: str) -> dict:
    board_id = uuid.uuid4().hex[:12]
    stamp = now_iso()
    with _db_lock:
        db().execute(
            "INSERT INTO boards (id, name, ranking, customs, revision, created_at, updated_at)"
            " VALUES (?, ?, '[]', '[]', 1, ?, ?)",
            (board_id, name, stamp, stamp),
        )
        db().commit()
    return get_board(board_id)


def update_board(board_id: str, payload: dict) -> dict | None:
    with _db_lock:
        row = db().execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if row is None:
            return None
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            name = row["name"]
        ranking = payload.get("ranking")
        if not isinstance(ranking, list):
            ranking = json.loads(row["ranking"] or "[]")
        customs = payload.get("customs")
        if not isinstance(customs, list):
            customs = json.loads(row["customs"] or "[]")
        db().execute(
            "UPDATE boards SET name = ?, ranking = ?, customs = ?, revision = revision + 1,"
            " updated_at = ? WHERE id = ?",
            (
                name.strip()[:60],
                json.dumps(ranking, ensure_ascii=False, separators=(",", ":")),
                json.dumps(customs, ensure_ascii=False, separators=(",", ":")),
                now_iso(),
                board_id,
            ),
        )
        db().commit()
    return get_board(board_id)


def delete_board(board_id: str) -> bool:
    with _db_lock:
        cur = db().execute("DELETE FROM boards WHERE id = ?", (board_id,))
        db().commit()
    return cur.rowcount > 0


# ------------------------------------------------------------------- handlers

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "GameRank/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------------------------------------------------------- helpers
    def log_message(self, fmt, *args):  # quieter, keeps stderr readable
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-GameRank-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def authorized(self) -> bool:
        if OPEN_MODE:
            return True
        given = self.headers.get("X-GameRank-Token", "")
        return bool(TOKEN) and hmac.compare_digest(given, TOKEN)

    def read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def valid_items(self, value) -> bool:
        if not isinstance(value, list) or len(value) > MAX_ITEMS:
            return False
        for item in value:
            if not isinstance(item, (dict, str)):
                return False
        return True

    # ------------------------------------------------------------------ verbs
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"ok": True, "open": OPEN_MODE})
            return
        if not path.startswith("/api/"):
            self.serve_static(path)
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return

        if path == "/api/boards":
            self.send_json(200, {"boards": list_boards()})
            return

        m = re.match(r"^/api/boards/([A-Za-z0-9_-]{1,64})$", path)
        if m:
            board = get_board(m.group(1))
            if board is None:
                self.send_json(404, {"error": "not_found"})
            else:
                self.send_json(200, {"board": board})
            return

        self.serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        if path != "/api/boards":
            self.send_json(404, {"error": "not_found"})
            return
        payload = self.read_json() or {}
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            self.send_json(400, {"error": "name_required"})
            return
        self.send_json(201, {"board": create_board(name.strip()[:60])})

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        m = re.match(r"^/api/boards/([A-Za-z0-9_-]{1,64})$", path)
        if not m:
            self.send_json(404, {"error": "not_found"})
            return
        payload = self.read_json()
        if payload is None:
            self.send_json(400, {"error": "bad_json"})
            return
        for field in ("ranking", "customs"):
            if field in payload and not self.valid_items(payload[field]):
                self.send_json(400, {"error": "bad_" + field})
                return
        board = update_board(m.group(1), payload)
        if board is None:
            self.send_json(404, {"error": "not_found"})
        else:
            self.send_json(200, {"board": {k: board[k] for k in ("id", "name", "count", "revision", "updatedAt")}})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        m = re.match(r"^/api/boards/([A-Za-z0-9_-]{1,64})$", path)
        if not m:
            self.send_json(404, {"error": "not_found"})
            return
        if not delete_board(m.group(1)):
            self.send_json(404, {"error": "not_found"})
            return
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----------------------------------------------------------------- static
    def serve_static(self, path: str) -> None:
        if not STATIC_DIR:
            self.send_json(404, {"error": "not_found"})
            return
        rel = unquote(path).lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        root = os.path.normpath(STATIC_DIR)
        if not target.startswith(root + os.sep) and target != root:
            self.send_json(403, {"error": "forbidden"})
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self.send_json(404, {"error": "not_found"})
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_json(500, {"error": "read_failed"})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Versioned assets (?v=) can cache; HTML must not.
        if ext in (".js", ".css", ".json") or "/data/" in target.replace("\\", "/"):
            self.send_header("Cache-Control", "public, max-age=2592000")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str]) -> int:
    global STATIC_DIR, DB_PATH
    ap = argparse.ArgumentParser(description="GameRank shared-board server")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--db", default="boards.db")
    ap.add_argument("--static", default="", help="optional site directory to serve")
    args = ap.parse_args(argv)

    if not TOKEN and not OPEN_MODE:
        print("GAMERANK_TOKEN is required (or set GAMERANK_OPEN=1 for an "
              "unauthenticated private deployment).", file=sys.stderr)
        return 2
    if OPEN_MODE:
        print("WARNING: open mode — anyone who can reach this server can edit boards.",
              file=sys.stderr)

    DB_PATH = args.db
    if args.static:
        STATIC_DIR = os.path.abspath(args.static)
        if not os.path.isdir(STATIC_DIR):
            print("--static directory not found: %s" % STATIC_DIR, file=sys.stderr)
            return 2

    db()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("GameRank server on http://%s:%d  (db=%s, static=%s)"
          % (args.host, args.port, DB_PATH, STATIC_DIR or "-"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
