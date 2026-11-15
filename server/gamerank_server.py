#!/usr/bin/env python3
"""Public GameRank boards with browser-owned writes and immediate SSE updates.

    python server/gamerank_server.py --port 8787 --db boards.db --static .

Reads and /api/events are public. /api/me and mutations use X-GameRank-Key, a
browser-generated secret; responses expose only its derived public owner ID.
Existing boards remain readable. Legacy ownership IDs cannot authorize writes;
clone those boards to create a new browser-owned copy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

MAX_BODY = 1024 * 1024
MAX_ITEMS = 5000
BOARD_PATH = re.compile(r"^/api/boards/([A-Za-z0-9_-]{1,64})$")
IDENTITY_KEY = re.compile(r"^[!-~]{32,256}$")
CLIENT_ID = re.compile(r"^[!-~]{1,128}$")
HEARTBEAT_SECONDS = 15
STATIC_DIR = None
DB_PATH = "boards.db"

_db_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    """Call under _db_lock once request threads have started."""
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
                   owner TEXT NOT NULL DEFAULT '',
                   identity_version INTEGER NOT NULL DEFAULT 0,
                   client_id TEXT,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
               )"""
        )
        columns = {row["name"] for row in _conn.execute("PRAGMA table_info(boards)")}
        for name, declaration in (
            ("owner", "TEXT NOT NULL DEFAULT ''"),
            ("identity_version", "INTEGER NOT NULL DEFAULT 0"),
            ("client_id", "TEXT"),
        ):
            if name not in columns:
                _conn.execute("ALTER TABLE boards ADD COLUMN " + name + " " + declaration)
        _conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS boards_client_id "
            "ON boards(owner, client_id) WHERE client_id IS NOT NULL"
        )
        _conn.commit()
    return _conn


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def board_of(row: sqlite3.Row, *, full: bool = True) -> dict:
    ranking = json.loads(row["ranking"] or "[]")
    board = {
        "id": row["id"],
        "name": row["name"],
        "count": len(ranking),
        "revision": row["revision"],
        "owner": row["owner"],
        "updatedAt": row["updated_at"],
    }
    if full:
        board["ranking"] = ranking
        board["customs"] = json.loads(row["customs"] or "[]")
    return board


def list_boards() -> list[dict]:
    with _db_lock:
        rows = db().execute("SELECT * FROM boards ORDER BY created_at, id").fetchall()
    return [board_of(row, full=False) for row in rows]


def get_board(board_id: str) -> dict | None:
    with _db_lock:
        row = db().execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    return board_of(row) if row is not None else None


class StoreError(Exception):
    def __init__(self, status: int, code: str, board: dict | None = None):
        super().__init__(code)
        self.status = status
        self.payload = {"error": code}
        if board is not None:
            self.payload.update(revision=board["revision"], board=board)


def create_board(payload: dict, owner: str) -> tuple[dict, bool]:
    """Create complete content atomically; retries reuse an owner's client ID."""
    stamp = now_iso()
    board_id = uuid.uuid4().hex
    client_id = payload.get("clientId")
    with _db_lock:
        conn = db()
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            if client_id is not None:
                row = conn.execute(
                    "SELECT * FROM boards WHERE owner = ? AND client_id = ?",
                    (owner, client_id),
                ).fetchone()
                if row is not None:
                    return board_of(row), False
            conn.execute(
                "INSERT INTO boards (id, name, ranking, customs, revision, owner, "
                "identity_version, client_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
                (board_id, payload["name"].strip()[:60],
                 json.dumps(payload.get("ranking", []), ensure_ascii=False, separators=(",", ":")),
                 json.dumps(payload.get("customs", []), ensure_ascii=False, separators=(",", ":")),
                 owner, client_id, stamp, stamp),
            )
        return board_of(conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()), True


def owned_row(conn: sqlite3.Connection, board_id: str, owner: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    if row is None:
        raise StoreError(404, "not_found")
    # Older public IDs were supplied by clients and are not proof of ownership.
    if row["identity_version"] != 1 or row["owner"] != owner:
        raise StoreError(403, "not_owner")
    return row


def update_board(board_id: str, payload: dict, owner: str) -> dict:
    with _db_lock:
        conn = db()
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            row = owned_row(conn, board_id, owner)
            if "revision" in payload and payload["revision"] != row["revision"]:
                raise StoreError(409, "revision_conflict", board_of(row))
            conn.execute(
                "UPDATE boards SET name = ?, ranking = ?, customs = ?, "
                "revision = revision + 1, updated_at = ? WHERE id = ?",
                (payload["name"].strip()[:60] if "name" in payload else row["name"],
                 json.dumps(payload["ranking"], ensure_ascii=False, separators=(",", ":"))
                 if "ranking" in payload else row["ranking"],
                 json.dumps(payload["customs"], ensure_ascii=False, separators=(",", ":"))
                 if "customs" in payload else row["customs"],
                 now_iso(), board_id),
            )
        return board_of(conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone())


def delete_board(board_id: str, owner: str) -> None:
    with _db_lock:
        conn = db()
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            owned_row(conn, board_id, owner)
            conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))


class GameRankHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.events = threading.Condition()
        self.version = 0
        self.closing = False

    def publish(self) -> None:
        with self.events:
            self.version += 1
            self.events.notify_all()

    def close_events(self) -> None:
        with self.events:
            self.closing = True
            self.events.notify_all()

    def shutdown(self) -> None:
        self.close_events()
        super().shutdown()

    def server_close(self) -> None:
        self.close_events()
        super().server_close()


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".avif": "image/avif",
}
PUBLIC_FILES = {"index.html", "app.js", "styles.css", "favicon.ico"}


def public_path(path: Path) -> bool:
    parts = path.parts
    if not parts or any(part.startswith(".") for part in parts):
        return False
    return path.as_posix() in PUBLIC_FILES or (
        parts[0] in ("data", "assets") and len(parts) > 1 and path.suffix.lower() in CONTENT_TYPES
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "GameRank/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def identity(self) -> str | None:
        key = self.headers.get("X-GameRank-Key", "")
        if not IDENTITY_KEY.fullmatch(key):
            self.close_connection = True
            self.send_json(401, {"error": "identity_required"})
            return None
        return "u_" + hashlib.sha256(key.encode("ascii")).hexdigest()

    def same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed = urlparse(origin)
        if parsed.scheme in ("http", "https") and parsed.netloc.lower() == self.headers.get("Host", "").lower():
            return True
        self.close_connection = True
        self.send_json(403, {"error": "cross_origin_write"})
        return False

    def read_json(self) -> dict | None:
        def invalid_constant(value):
            raise ValueError("Non-finite JSON number")

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self.send_json(413 if length > MAX_BODY else 400, {"error": "bad_body_length"})
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=invalid_constant)
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except (UnicodeError, ValueError, RecursionError):
            self.send_json(400, {"error": "bad_json"})
            return None
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "bad_json"})
            return None
        return payload

    def valid_payload(self, payload: dict, *, creating: bool = False) -> bool:
        if creating and "name" not in payload:
            self.send_json(400, {"error": "name_required"})
            return False
        if "name" in payload and (not isinstance(payload["name"], str) or not payload["name"].strip()):
            self.send_json(400, {"error": "name_required"})
            return False
        for field in ("ranking", "customs"):
            if field in payload:
                items = payload[field]
                if not isinstance(items, list) or len(items) > MAX_ITEMS or any(
                    not isinstance(item, (dict, str)) for item in items
                ):
                    self.send_json(400, {"error": "bad_" + field})
                    return False
        if "revision" in payload and (type(payload["revision"]) is not int or payload["revision"] < 1):
            self.send_json(400, {"error": "bad_revision"})
            return False
        if "clientId" in payload and (
            not isinstance(payload["clientId"], str) or not CLIENT_ID.fullmatch(payload["clientId"])
        ):
            self.send_json(400, {"error": "bad_clientId"})
            return False
        return True

    def do_OPTIONS(self) -> None:
        if not self.same_origin():
            return
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"ok": True, "open": True, "realtime": True})
        elif path == "/api/me":
            owner = self.identity()
            if owner:
                self.send_json(200, {"user": {"id": owner}})
        elif path == "/api/boards":
            self.send_json(200, {"boards": list_boards()})
        elif path == "/api/events":
            self.serve_events()
        elif match := BOARD_PATH.fullmatch(path):
            board = get_board(match.group(1))
            if board is None:
                self.send_json(404, {"error": "not_found"})
            else:
                self.send_json(200, {"board": board})
        elif path.startswith("/api/"):
            self.send_json(404, {"error": "not_found"})
        else:
            self.serve_static(path)

    def do_POST(self) -> None:
        if not self.same_origin():
            return
        owner = self.identity()
        if not owner:
            return
        if urlparse(self.path).path != "/api/boards":
            self.send_json(404, {"error": "not_found"})
            return
        payload = self.read_json()
        if payload is None or not self.valid_payload(payload, creating=True):
            return
        board, created = create_board(payload, owner)
        if created:
            self.server.publish()
        self.send_json(201 if created else 200, {"board": board})

    def do_PUT(self) -> None:
        if not self.same_origin():
            return
        owner = self.identity()
        if not owner:
            return
        match = BOARD_PATH.fullmatch(urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "not_found"})
            return
        payload = self.read_json()
        if payload is None or not self.valid_payload(payload):
            return
        try:
            board = update_board(match.group(1), payload, owner)
        except StoreError as error:
            self.send_json(error.status, error.payload)
            return
        self.server.publish()
        self.send_json(200, {"board": board})

    def do_DELETE(self) -> None:
        if not self.same_origin():
            return
        owner = self.identity()
        if not owner:
            return
        match = BOARD_PATH.fullmatch(urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "not_found"})
            return
        try:
            delete_board(match.group(1), owner)
        except StoreError as error:
            self.send_json(error.status, error.payload)
            return
        self.server.publish()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def serve_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(5)
        version = None
        try:
            while True:
                with self.server.events:
                    self.server.events.wait_for(
                        lambda: self.server.closing or self.server.version != version,
                        timeout=HEARTBEAT_SECONDS,
                    )
                    if self.server.closing:
                        return
                    latest = self.server.version
                if latest != version:
                    message = 'event: boards\nid: %d\ndata: {"version":%d}\n\n' % (latest, latest)
                    version = latest
                else:
                    message = ": heartbeat\n\n"
                self.wfile.write(message.encode("utf-8"))
                self.wfile.flush()
        except (OSError, TimeoutError):
            return

    def serve_static(self, path: str) -> None:
        if not STATIC_DIR:
            self.send_json(404, {"error": "not_found"})
            return
        relative = Path(unquote(path).lstrip("/") or "index.html")
        if not public_path(relative) or "\\" in unquote(path):
            self.send_json(404, {"error": "not_found"})
            return
        root = Path(STATIC_DIR).resolve()
        try:
            target = (root / relative).resolve()
            resolved_relative = target.relative_to(root)
            if not public_path(resolved_relative) or not target.is_file():
                raise ValueError("Not a public asset")
            body = target.read_bytes()
        except (OSError, ValueError, RuntimeError):
            self.send_json(404, {"error": "not_found"})
            return
        extension = target.suffix.lower()
        query = parse_qs(urlparse(self.path).query)
        versioned = bool(query.get("v", [""])[0])
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES[extension])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "public, max-age=2592000, immutable"
                         if versioned and extension != ".html" else "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str]) -> int:
    global STATIC_DIR, DB_PATH, _conn
    parser = argparse.ArgumentParser(description="GameRank shared-board server")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--db", default="boards.db")
    parser.add_argument("--static", default="", help="optional site directory to serve")
    args = parser.parse_args(argv)
    DB_PATH = args.db
    if args.static:
        STATIC_DIR = os.path.abspath(args.static)
        if not os.path.isdir(STATIC_DIR):
            print("--static directory not found: %s" % STATIC_DIR, file=sys.stderr)
            return 2
    db()
    server = GameRankHTTPServer((args.host, args.port), Handler)
    print("GameRank server on http://%s:%d  (db=%s, static=%s)"
          % (args.host, server.server_port, DB_PATH, STATIC_DIR or "-"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if _conn is not None:
            _conn.close()
            _conn = None
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
