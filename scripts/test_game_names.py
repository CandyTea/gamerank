"""Focused tests for stable curated localization of the generated catalogue."""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

import build_games


class ChineseNamesTests(unittest.TestCase):
    def test_apply_fills_english_and_preserves_existing_chinese(self):
        records = [
            {"id": 10, "name": "First Game", "nameZh": "", "mc": 91,
             "popularity": 0.8},
            {"id": "11", "name": "Second Game", "nameZh": "已有中文名",
             "mc": 88, "popularity": 0.7},
            {"id": "12", "name": "Third Game", "nameZh": "Third Game",
             "mc": 80, "popularity": 0.6},
            {"id": "13", "name": "Fourth Game", "nameZh": "旧的人工译名",
             "nameZhType": "reference", "mc": 77, "popularity": 0.5},
        ]
        names = {
            "10": {"nameZh": "第一款游戏", "type": "common"},
            "11": {"nameZh": "应被保留的译名", "type": "reference"},
            "12": {"nameZh": "第三款游戏", "type": "reference"},
            "13": {"nameZh": "修订后的译名", "type": "common"},
        }
        before = [(row["id"], row["mc"], row["popularity"]) for row in records]

        self.assertEqual(build_games.apply_chinese_names(records, names), 3)
        self.assertEqual(records[0]["nameZh"], "第一款游戏")
        self.assertEqual(records[0]["nameZhType"], "common")
        self.assertEqual(records[1]["nameZh"], "已有中文名")
        self.assertNotIn("nameZhType", records[1])
        self.assertEqual(records[2]["nameZhType"], "reference")
        self.assertEqual(records[3]["nameZh"], "修订后的译名")
        self.assertEqual(records[3]["nameZhType"], "common")
        self.assertEqual(
            [(row["id"], row["mc"], row["popularity"]) for row in records], before)

    def test_apply_is_idempotent_and_uses_exact_ids(self):
        records = [
            {"id": "mc:game-one", "nameZh": "", "mc": 90},
            {"id": "mc:game-one-extra", "nameZh": "", "mc": 70},
        ]
        names = {"mc:game-one": {"nameZh": "游戏一", "type": "reference"}}

        self.assertEqual(build_games.apply_chinese_names(records, names), 1)
        localized = json.loads(json.dumps(records, ensure_ascii=False))
        self.assertEqual(build_games.apply_chinese_names(records, names), 0)
        self.assertEqual(records, localized)
        self.assertEqual(records[1]["nameZh"], "")

    def test_snapshot_parser_rejects_executable_trailing_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "games.js")
            record = {"id": "one", "name": "Game", "nameZh": "游戏"}
            meta = {"generatedAt": "2026-11-15T00:00:00Z", "sources": [],
                    "count": 1}
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(build_games.render_js([record], meta))

            loaded, loaded_meta = build_games.load_snapshot(path)
            self.assertEqual(loaded, [record])
            self.assertEqual(loaded_meta, meta)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("window.GAMES.push({id: 'injected'});\n")
            with self.assertRaisesRegex(ValueError, "unexpected JavaScript"):
                build_games.load_snapshot(path)

    def test_localize_only_never_calls_network_and_preserves_snapshot_fields(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot_path = os.path.join(temp_dir, "games.js")
            names_path = os.path.join(temp_dir, "game_names_zh.json")
            index_path = os.path.join(temp_dir, "index.html")
            records = [
                {"id": 41, "name": "English Name", "nameZh": "English Name",
                 "mc": 92, "ign": 9, "popularity": 0.71,
                 "aliases": ["alias"], "platforms": ["PC"]},
                {"id": "mc:existing", "name": "Existing", "nameZh": "已有译名",
                 "mc": 88, "ign": None, "popularity": 0.63,
                 "aliases": [], "platforms": ["PS5"]},
            ]
            original_meta = {
                "generatedAt": "2026-11-14T03:04:05Z",
                "sources": ["Fixture source"], "count": len(records),
            }
            with open(snapshot_path, "w", encoding="utf-8") as fh:
                fh.write(build_games.render_js(records, original_meta))
            with open(names_path, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "names": {
                    "41": {"nameZh": "新中文名", "type": "common"},
                    "mc:existing": {"nameZh": "错误替换", "type": "reference"},
                }}, fh, ensure_ascii=False)
            with open(index_path, "w", encoding="utf-8") as fh:
                fh.write('<script src="data/games.js?v=old"></script>\n')

            with (patch.object(build_games, "OUT_PATH", snapshot_path),
                  patch.object(build_games, "ZH_NAMES_PATH", names_path),
                  patch.object(build_games, "INDEX_PATH", index_path),
                  patch.object(build_games, "ROOT", temp_dir),
                  patch.object(build_games, "http_text",
                               side_effect=AssertionError("network used"))):
                self.assertEqual(build_games.main(["--localize-only"]), 0)
                with open(snapshot_path, "rb") as fh:
                    first_result = fh.read()
                self.assertEqual(build_games.main(["--localize-only"]), 0)
                with open(snapshot_path, "rb") as fh:
                    self.assertEqual(fh.read(), first_result)

            localized, meta = build_games.load_snapshot(snapshot_path)
            self.assertEqual(localized[0]["nameZh"], "新中文名")
            self.assertEqual(localized[0]["nameZhType"], "common")
            self.assertEqual(localized[1]["nameZh"], "已有译名")
            self.assertEqual(localized[0]["mc"], records[0]["mc"])
            self.assertEqual(localized[0]["popularity"], records[0]["popularity"])
            self.assertEqual([row["id"] for row in localized],
                             [row["id"] for row in records])
            self.assertEqual(meta["generatedAt"], original_meta["generatedAt"])
            self.assertEqual(meta["sources"], original_meta["sources"])
            self.assertEqual(meta["localization"]["source"],
                             "data/game_names_zh.json")
            self.assertEqual(meta["localization"]["translated"], 2)
            self.assertEqual(meta["localization"]["common"], 1)
            self.assertEqual(meta["localization"]["missing"], 0)


if __name__ == "__main__":
    unittest.main()
