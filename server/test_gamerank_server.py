"""HTTP integration tests; run: python -m unittest discover -s server -v."""

import concurrent.futures
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest

from server import gamerank_server as app


KEY_A = "a1" * 32
KEY_B = "b2" * 32


class QuietHandler(app.Handler):
    def log_message(self, *args):
        pass


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gamerank-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.site = self.root / "site"
        for folder in ("data", "assets", ".git", "server", "deploy"):
            (self.site / folder).mkdir(parents=True)
        for filename, content in {
            "index.html": "<!doctype html><title>GameRank</title>",
            "app.js": "window.ready = true;",
            "styles.css": "body { color: black; }",
            "data/games.js": "window.GAMES = [];",
            "assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
            ".git/config": "private git configuration",
            ".env": "PRIVATE=secret",
            "boards.db": "private database",
            "server/gamerank_server.py": "private server code",
            "server/private.js": "private script",
            "deploy/gamerank.service": "private service configuration",
            "README.md": "private documentation",
        }.items():
            (self.site / filename).write_text(content, encoding="utf-8")
        app.DB_PATH = str(self.root / "boards.db")
        app.STATIC_DIR = str(self.site)
        app.db()
        self.server = app.GameRankHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if app._conn is not None:
            app._conn.close()
            app._conn = None

    def connection(self):
        return http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)

    def request(self, method, path, payload=None, key=None, headers=None, raw=None):
        request_headers = dict(headers or {})
        if key is not None:
            request_headers["X-GameRank-Key"] = key
        body = raw
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        conn = self.connection()
        try:
            conn.request(method, path, body=body, headers=request_headers)
            response = conn.getresponse()
            content = response.read()
            result = json.loads(content) if content and "application/json" in response.getheader("Content-Type", "") else content
            return response.status, result, dict(response.getheaders())
        finally:
            conn.close()

    def create(self, key=KEY_A, **fields):
        payload = {"name": "我的排行", **fields}
        status, result, _ = self.request("POST", "/api/boards", payload, key)
        self.assertEqual(status, 201, result)
        return result["board"]

    def stream(self):
        connection = self.connection()
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        self.addCleanup(connection.close)
        self.addCleanup(response.close)
        return response

    def read_event(self, response):
        values = {}
        while True:
            line = response.readline()
            self.assertTrue(line, "SSE stream closed before an event")
            if line == b"\n":
                if values:
                    return values
                continue
            if line.startswith(b":"):
                continue
            field, _, value = line.decode().partition(":")
            values[field] = value.strip()

    def test_public_reads_and_stable_secret_derived_identity(self):
        status, health, _ = self.request("GET", "/api/health")
        self.assertEqual((status, health), (200, {"ok": True, "open": True, "realtime": True}))
        status, me, _ = self.request("GET", "/api/me", key=KEY_A)
        self.assertEqual(status, 200)
        owner = "u_" + hashlib.sha256(KEY_A.encode()).hexdigest()
        self.assertEqual(me, {"user": {"id": owner}})
        self.assertEqual(self.request("GET", "/api/me", key=KEY_A)[1], me)
        self.assertNotEqual(self.request("GET", "/api/me", key=KEY_B)[1], me)
        board = self.create(ranking=[{"key": "game-1", "custom": False}], customs=[{"id": "custom-1", "name": "自定义"}])
        self.assertEqual(board["owner"], owner)
        self.assertEqual(board["count"], 1)
        self.assertEqual(board["revision"], 1)
        self.assertEqual(self.request("GET", "/api/boards/" + board["id"])[1], {"board": board})
        status, listed, _ = self.request("GET", "/api/boards")
        self.assertEqual(status, 200)
        self.assertEqual(listed["boards"][0]["owner"], owner)
        self.assertNotIn(KEY_A, json.dumps(listed))
        self.assertNotIn("clientId", board)

    def test_secret_required_and_public_ids_cannot_impersonate_owner(self):
        for key in (None, "short", "a" * 257, "a" * 31 + " "):
            with self.subTest(key_length=len(key) if key else 0):
                self.assertEqual(self.request("GET", "/api/me", key=key)[0], 401)
                self.assertEqual(self.request("POST", "/api/boards", {"name": "bad"}, key)[0], 401)
        owner_b = self.request("GET", "/api/me", key=KEY_B)[1]["user"]["id"]
        board = self.create(owner=owner_b)
        self.assertNotEqual(board["owner"], owner_b)
        path = "/api/boards/" + board["id"]
        spoof = {"X-Owner-Id": board["owner"]}
        self.assertEqual(self.request("PUT", path, {"name": "stolen", "owner": board["owner"]}, KEY_B, spoof)[0], 403)
        self.assertEqual(self.request("DELETE", path, key=KEY_B, headers=spoof)[0], 403)
        self.assertEqual(self.request("PUT", path, {"name": "stolen"}, headers=spoof)[0], 401)
        self.assertEqual(self.request("PUT", path, {"name": "mine"}, KEY_A)[0], 200)
        self.assertEqual(self.request("DELETE", path, key=KEY_A)[0], 204)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_idempotent_initial_import_is_scoped_by_owner_and_persistent(self):
        fields = {"name": "import", "clientId": "local:slot-123", "ranking": ["first", "second"], "customs": [{"id": "x", "name": "自定义"}]}
        status, first, _ = self.request("POST", "/api/boards", fields, KEY_A)
        self.assertEqual(status, 201)
        app._conn.close()
        app._conn = None
        status, again, _ = self.request("POST", "/api/boards", {**fields, "ranking": ["wrong retry"]}, KEY_A)
        self.assertEqual(status, 200)
        self.assertEqual(again, first)
        self.assertEqual(first["board"]["ranking"], fields["ranking"])
        self.assertEqual(first["board"]["customs"], fields["customs"])
        status, other, _ = self.request("POST", "/api/boards", fields, KEY_B)
        self.assertEqual(status, 201)
        self.assertNotEqual(other["board"]["id"], first["board"]["id"])
        self.assertEqual(len(self.request("GET", "/api/boards")[1]["boards"]), 2)

    def test_parallel_import_retries_create_one_complete_board(self):
        payload = {"name": "import", "clientId": "same-import", "ranking": ["a"], "customs": [{"id": "c"}]}
        barrier = threading.Barrier(4)

        def import_once(_):
            barrier.wait(timeout=3)
            return self.request("POST", "/api/boards", payload, KEY_A)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(import_once, range(4)))
        self.assertEqual(sorted(result[0] for result in results), [200, 200, 200, 201])
        self.assertEqual(len({result[1]["board"]["id"] for result in results}), 1)
        self.assertTrue(all(result[1]["board"]["ranking"] == ["a"] for result in results))

    def test_initial_content_and_update_validation_never_partially_write(self):
        bad_payloads = (
            {}, {"name": " "}, {"name": 10}, {"name": "ok", "ranking": {}},
            {"name": "ok", "ranking": [None]}, {"name": "ok", "customs": [10]},
            {"name": "ok", "ranking": ["a"] * (app.MAX_ITEMS + 1)},
            {"name": "ok", "clientId": ""}, {"name": "ok", "clientId": None},
        )
        for payload in bad_payloads:
            with self.subTest(payload_keys=list(payload)):
                self.assertEqual(self.request("POST", "/api/boards", payload, KEY_A)[0], 400)
        self.assertEqual(self.request("POST", "/api/boards", key=KEY_A, raw=b'{"name":"bad","ranking":[NaN]}')[0], 400)
        self.assertEqual(self.request("POST", "/api/boards", key=KEY_A, raw=b'{"name":"\\ud800"}')[0], 400)
        self.assertEqual(self.request("POST", "/api/boards", key=KEY_A, raw=b"[]")[0], 400)
        self.assertEqual(self.request("GET", "/api/boards")[1], {"boards": []})
        board = self.create(ranking=["original"])
        path = "/api/boards/" + board["id"]
        for payload in ({"name": "changed", "customs": False}, {"revision": True}, {"revision": 0}, {"name": ""}):
            self.assertEqual(self.request("PUT", path, payload, KEY_A)[0], 400)
        self.assertEqual(self.request("GET", path)[1]["board"], board)

    def test_stale_revision_contains_current_content_without_overwriting(self):
        board = self.create(ranking=["old"])
        path = "/api/boards/" + board["id"]
        status, updated, _ = self.request("PUT", path, {"ranking": ["new"], "revision": 1}, KEY_A)
        self.assertEqual(status, 200)
        self.assertEqual(updated["board"]["revision"], 2)
        status, conflict, _ = self.request("PUT", path, {"ranking": ["stale"], "revision": 1}, KEY_A)
        self.assertEqual(status, 409)
        self.assertEqual(conflict, {"error": "revision_conflict", "revision": 2, "board": updated["board"]})
        self.assertEqual(self.request("GET", path)[1], updated)

    def test_simultaneous_revisions_allow_exactly_one_writer(self):
        board = self.create()
        path = "/api/boards/" + board["id"]
        barrier = threading.Barrier(2)

        def update(name):
            barrier.wait(timeout=3)
            return self.request("PUT", path, {"revision": 1, "name": name}, KEY_A)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(update, ("first", "second")))
        self.assertEqual(sorted(result[0] for result in results), [200, 409])
        winner = next(result[1]["board"] for result in results if result[0] == 200)
        self.assertEqual(self.request("GET", path)[1]["board"], winner)

    def test_sse_notifies_all_viewers_on_each_successful_mutation_and_reconnect(self):
        viewers = [self.stream(), self.stream()]
        for response in viewers:
            self.assertEqual(self.read_event(response), {"event": "boards", "id": "0", "data": '{"version":0}'})
        started = time.monotonic()
        board = self.create(clientId="unique-import")
        for response in viewers:
            self.assertEqual(json.loads(self.read_event(response)["data"]), {"version": 1})
        self.assertLess(time.monotonic() - started, 2, "Push should arrive without polling")
        path = "/api/boards/" + board["id"]
        self.assertEqual(self.request("POST", "/api/boards", {"name": "retry", "clientId": "unique-import"}, KEY_A)[0], 200)
        self.assertEqual(self.request("PUT", path, {"ranking": ["edited"], "revision": 1}, KEY_A)[0], 200)
        for response in viewers:
            self.assertEqual(self.read_event(response)["id"], "2")
        self.assertEqual(self.request("PUT", path, {"ranking": ["stale"], "revision": 1}, KEY_A)[0], 409)
        self.assertEqual(self.request("DELETE", path, key=KEY_A)[0], 204)
        for response in viewers:
            self.assertEqual(self.read_event(response)["id"], "3")
        reconnected = self.stream()
        self.assertEqual(self.read_event(reconnected)["id"], "3")

    def test_sse_shutdown_closes_waiting_stream(self):
        response = self.stream()
        self.read_event(response)
        started = time.monotonic()
        self.server.shutdown()
        self.assertEqual(response.read(1), b"")
        self.assertLess(time.monotonic() - started, 1)

    def test_sse_heartbeat_keeps_idle_connections_active(self):
        original = app.HEARTBEAT_SECONDS
        app.HEARTBEAT_SECONDS = 0.05
        self.addCleanup(setattr, app, "HEARTBEAT_SECONDS", original)
        response = self.stream()
        self.read_event(response)
        self.assertEqual(response.readline(), b": heartbeat\n")
        self.assertEqual(response.readline(), b"\n")

    def test_browser_mutations_reject_cross_origin(self):
        for method in ("POST", "PUT", "DELETE", "OPTIONS"):
            self.assertEqual(self.request(method, "/api/boards", {"name": "x"}, KEY_A, {"Origin": "https://evil.example"})[0], 403)
        origin = "http://127.0.0.1:%d" % self.server.server_port
        self.assertEqual(self.request("POST", "/api/boards", {"name": "same site"}, KEY_A, {"Origin": origin})[0], 201)

    def test_static_public_assets_only_and_cache_requires_explicit_version(self):
        for path in ("/", "/index.html", "/app.js", "/styles.css", "/data/games.js", "/assets/logo.svg"):
            self.assertEqual(self.request("GET", path)[0], 200, path)
        for path in (
            "/.git/config", "/.env", "/boards.db", "/server/gamerank_server.py",
            "/deploy/gamerank.service", "/README.md", "/data/../.env", "/data/%2e%2e/.env",
            "/data/%2e%2e/server/private.js", "/data/..%5cserver%5cprivate.js", "/api/unknown",
        ):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        for path in ("/app.js", "/app.js?other=1", "/app.js?v=", "/index.html?v=123"):
            self.assertEqual(self.request("GET", path)[2]["Cache-Control"], "no-cache", path)
        for path in ("/app.js?v=123", "/data/games.js?v=123"):
            self.assertIn("max-age=", self.request("GET", path)[2]["Cache-Control"])

    def test_static_symlinks_cannot_expose_outside_or_private_files(self):
        outside = self.root / "secret.js"
        outside.write_text("private outside", encoding="utf-8")
        try:
            os.symlink(outside, self.site / "assets" / "outside.js")
            os.symlink(self.site / "server" / "private.js", self.site / "assets" / "private.js")
        except OSError:
            if os.name != "nt":
                raise
            # Directory junctions exercise the same resolve boundary without
            # requiring Windows Developer Mode or symlink privileges.
            outside_directory = self.root / "outside"
            outside_directory.mkdir()
            (outside_directory / "secret.js").write_text("private outside", encoding="utf-8")
            for name, target in (("outside", outside_directory), ("private", self.site / "server")):
                result = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(self.site / "assets" / name), str(target)],
                    capture_output=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            paths = ("/assets/outside/secret.js", "/assets/private/private.js")
        else:
            paths = ("/assets/outside.js", "/assets/private.js")
        for path in paths:
            self.assertEqual(self.request("GET", path)[0], 404)

    def test_old_schema_migration_preserves_legacy_boards_without_takeover(self):
        app._conn.close()
        app._conn = None
        legacy_path = self.root / "old.db"
        with sqlite3.connect(legacy_path) as conn:
            conn.execute("CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, ranking TEXT NOT NULL DEFAULT '[]', customs TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
            conn.execute("INSERT INTO boards VALUES ('legacy', '旧排行', '[\"old-game\"]', '[]', 4, '2020-01-01', '2020-01-01')")
        conn.close()
        app.DB_PATH = str(legacy_path)
        status, content, _ = self.request("GET", "/api/boards/legacy")
        self.assertEqual(status, 200)
        self.assertEqual(content["board"]["ranking"], ["old-game"])
        self.assertEqual(content["board"]["revision"], 4)
        self.assertEqual(content["board"]["owner"], "")
        self.assertEqual(self.request("PUT", "/api/boards/legacy", {"name": "takeover"}, KEY_A)[0], 403)
        # Even an old publicly supplied owner equal to a new derived ID proves nothing.
        owner = self.request("GET", "/api/me", key=KEY_A)[1]["user"]["id"]
        with app._conn:
            app._conn.execute("UPDATE boards SET owner = ? WHERE id = 'legacy'", (owner,))
        self.assertEqual(self.request("DELETE", "/api/boards/legacy", key=KEY_A)[0], 403)
        clone = self.create(ranking=content["board"]["ranking"])
        self.assertEqual(self.request("PUT", "/api/boards/" + clone["id"], {"name": "owned clone"}, KEY_A)[0], 200)


if __name__ == "__main__":
    unittest.main()
