#!/usr/bin/env python3
"""Build data/games.js for GameRank.

Python 3 standard library only. Reproducible + idempotent:

    python scripts/build_games.py            # incremental, uses scripts/.cache
    python scripts/build_games.py --refresh  # ignore the on-disk cache
    python scripts/build_games.py --no-ign   # skip the IGN review pass

Sources (each one is best-effort; whatever fails is reported in
window.GAMES_META.sources and contributes nothing):

  1. Steam most-played chart  api.steampowered.com/ISteamChartsService
  2. Steam featuredcategories top sellers / new releases / specials
  3. Metacritic all-time best games, both the all-platform and the PC browse:
     /browse/game/all/all/all-time/metascore/?page=N
     /browse/game/pc/all/all-time/metascore/?page=N
     (the site is a Nuxt SSR app now: the ranked list is server-rendered cards,
     with the same items mirrored in the __NUXT_DATA__ devalue payload)
  4. Steam appdetails, l=english (metadata) + l=schinese (Chinese name)
  5. IGN per-game JSON-LD (reviewRating.ratingValue); no bulk endpoint exists

Metacritic titles are mapped to Steam appids with storesearch + fuzzy name
matching; anything that cannot be matched is dropped (no invention).
"""

from __future__ import annotations

import argparse
import difflib
import gzip
import hashlib
import html
import json
import os
import random
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

# --------------------------------------------------------------------------- #
# paths / knobs
# --------------------------------------------------------------------------- #

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "games.js")
ZH_NAMES_PATH = os.path.join(ROOT, "data", "game_names_zh.json")
INDEX_PATH = os.path.join(ROOT, "index.html")
CACHE_TOKEN_RE = re.compile(
    r'((?:src|href)="/?(?:data/games\.js|app\.js|styles\.css))\?v=[^"]*(")')
CACHE_DIR = os.path.join(ROOT, "scripts", ".cache")
HTTP_CACHE = os.path.join(CACHE_DIR, "http")
IGN_CACHE = os.path.join(CACHE_DIR, "ign")
FIXTURE_IDS = os.path.join(CACHE_DIR, "fixture_ids.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

STEAM_THREADS = 8          # store.steampowered.com
MC_THREADS = 4             # metacritic.com
IGN_THREADS = 4            # www.ign.com
MAX_MC_PAGES = 40          # site currently stops returning cards around page 21
MC_CARDS_PER_PAGE = 50
MATCH_THRESHOLD = 0.80     # fuzzy name match for MC title -> Steam appid
IGN_MATCH_THRESHOLD = 0.80

PLATFORM_ORDER = ["PC", "Mac", "Linux", "PS5", "PS4", "XSX", "XB1", "Switch"]

MC_PLATFORM_MAP = {
    "pclogo": "PC",
    "maclogo": "Mac",
    "linuxlogo": "Linux",
    "ps5logo": "PS5",
    "ps4logo": "PS4",
    "xboxxserieslogo": "XSX",
    "xboxonelogo": "XB1",
    "switchlogo": "Switch",
    "switch2logo": "Switch",
}

# Community (mostly Chinese) nicknames, hand-written for the most famous games
# only. Keyed by Steam appid so it survives dataset rebuilds; entries whose
# appid is absent from the final set are silently ignored.
ALIASES = {
    730: ["CS2", "CSGO", "反恐精英", "CS"],
    570: ["刀塔2", "刀塔", "DOTA"],
    578080: ["PUBG", "绝地求生", "吃鸡"],
    1172470: ["Apex", "Apex英雄", "派派"],
    1174180: ["大镖客2", "RDR2", "荒野大镖客2", "红死"],
    1091500: ["2077", "赛博朋克", "赛博朋克2077"],
    271590: ["GTA5", "GTAV", "侠盗猎车5", "给他爱"],
    1245620: ["老头环", "法环", "艾尔登法环"],
    1086940: ["BG3", "博德之门", "博德3"],
    292030: ["巫师3", "昆特牌3", "杰洛特"],
    1938090: ["COD", "使命召唤", "决胜时刻"],
    236390: ["战雷", "战争雷霆"],
    227300: ["欧卡2", "欧洲卡车模拟"],
    322170: ["GD", "几何冲刺"],
    220: ["半条命2", "HL2"],
    1145360: ["哈迪斯"],
    1145350: ["哈迪斯2", "哈迪斯II"],
    2379780: ["小丑牌"],
    413150: ["星露谷", "星露谷物语"],
    105600: ["泰拉瑞亚", "泰拉"],
    2358720: ["黑神话", "黑神话悟空", "黑猴"],
    2246340: ["怪猎荒野", "怪物猎人荒野"],
    582010: ["怪猎世界", "怪物猎人世界", "MHW"],
    1446780: ["怪猎崛起", "怪物猎人崛起", "MHR"],
    1817070: ["漫威蜘蛛侠", "蜘蛛侠"],
    1593500: ["战神4", "战神"],
    268910: ["茶杯头"],
    391540: ["传说之下"],
    489830: ["老滚5", "上古卷轴5", "天际"],
    377160: ["辐射4"],
    255710: ["城市天际线", "天际线"],
    289070: ["文明6", "文明VI"],
    990080: ["霍格沃茨", "霍格沃茨之遗"],
    814380: ["只狼", "隻狼"],
    374320: ["黑魂3", "黑暗之魂3", "DS3"],
    1966720: ["致命公司"],
    1203220: ["永劫无间", "永劫"],
    1623730: ["幻兽帕鲁", "帕鲁"],
    252490: ["腐蚀", "RUST"],
    346110: ["方舟", "ARK"],
}

# Metacritic-only titles (console exclusives, f2p giants). Steam has no record
# for these, so the Chinese name cannot come from appdetails; this hand-written
# map covers the ones a Chinese player is most likely to search for. Keys are
# raw titles; they are normalised at load time. Scores still come from
# Metacritic — nothing here invents a rating.
CONSOLE_ZH = {
    "The Legend of Zelda: Breath of the Wild":
        ("塞尔达传说 旷野之息", ["塞尔达", "旷野之息", "荒野之息", "BOTW"]),
    "The Legend of Zelda: Tears of the Kingdom":
        ("塞尔达传说 王国之泪", ["塞尔达", "王国之泪", "TOTK"]),
    "The Legend of Zelda: Ocarina of Time":
        ("塞尔达传说 时之笛", ["塞尔达", "时之笛"]),
    "The Legend of Zelda: Majora's Mask":
        ("塞尔达传说 梅祖拉的假面", ["塞尔达", "假面"]),
    "The Legend of Zelda: The Wind Waker":
        ("塞尔达传说 风之律动", ["塞尔达", "风之杖"]),
    "The Legend of Zelda: Twilight Princess":
        ("塞尔达传说 黄昏公主", ["塞尔达"]),
    "The Legend of Zelda: Skyward Sword":
        ("塞尔达传说 御天之剑", ["塞尔达", "天空之剑"]),
    "The Legend of Zelda: Link's Awakening":
        ("塞尔达传说 织梦岛", ["塞尔达", "织梦岛"]),
    "Super Mario Odyssey": ("超级马力欧 奥德赛", ["马力欧", "马里奥", "奥德赛"]),
    "Super Mario Galaxy": ("超级马力欧 银河", ["马力欧", "马里奥"]),
    "Super Mario Galaxy 2": ("超级马力欧 银河2", ["马力欧", "马里奥"]),
    "Super Mario 64": ("超级马力欧64", ["马力欧", "马里奥"]),
    "Super Mario Bros. Wonder": ("超级马力欧兄弟 惊奇", ["马力欧", "马里奥"]),
    "Super Mario 3D World": ("超级马力欧 3D世界", ["马力欧", "马里奥"]),
    "Super Mario Maker 2": ("超级马力欧制造2", ["马力欧", "马里奥"]),
    "Super Mario RPG": ("超级马力欧RPG", ["马力欧", "马里奥"]),
    "Mario Kart 8 Deluxe": ("马力欧赛车8 豪华版", ["马车8", "马里奥赛车"]),
    "Mario Kart World": ("马力欧赛车 世界", ["马车", "马里奥赛车"]),
    "Super Smash Bros. Ultimate": ("任天堂明星大乱斗 特别版", ["大乱斗", "明星大乱斗"]),
    "Animal Crossing: New Horizons": ("集合啦！动物森友会", ["动森", "动物之森"]),
    "Splatoon 3": ("斯普拉遁3", ["喷射战士3", "喷喷"]),
    "Metroid Dread": ("密特罗德 生存恐惧", ["银河战士", "密特罗德"]),
    "Metroid Prime Remastered": ("密特罗德 究极 重制版", ["银河战士", "密特罗德"]),
    "Fire Emblem: Three Houses": ("火焰纹章 风花雪月", ["火焰纹章", "火纹"]),
    "Fire Emblem Engage": ("火焰纹章 Engage", ["火焰纹章", "火纹"]),
    "Xenoblade Chronicles 3": ("异度神剑3", ["异度之刃3", "异度"]),
    "Kirby and the Forgotten Land": ("星之卡比 探索发现", ["卡比"]),
    "Pikmin 4": ("皮克敏4", ["皮克敏"]),
    "Luigi's Mansion 3": ("路易吉洋馆3", ["路易吉"]),
    "Paper Mario: The Thousand-Year Door": ("纸片马力欧 千年之门", ["纸马"]),
    "Bayonetta 3": ("猎天使魔女3", ["魔女3", "贝姐"]),
    "Astro Bot": ("宇宙机器人", ["小机器人"]),
    "Bloodborne": ("血源诅咒", ["血源", "老猎人"]),
    "Demon's Souls": ("恶魔之魂 重制版", ["恶魔之魂", "恶魂"]),
    "Gran Turismo 7": ("GT赛车7", ["GT7", "跑车浪漫旅"]),
    "The Last of Us Part II": ("最后生还者 第二部", ["美末2", "最后生还者2"]),
    "Uncharted 4: A Thief's End": ("神秘海域4 盗贼末路", ["神秘海域4", "神海4"]),
    "God of War III": ("战神3", ["战神"]),
    "Pokemon Scarlet and Violet": ("宝可梦 朱/紫", ["宝可梦", "朱紫"]),
    "Pokemon Legends: Arceus": ("宝可梦传说 阿尔宙斯", ["宝可梦", "阿尔宙斯"]),
    "Pokemon Legends: Z-A": ("宝可梦传说 Z-A", ["宝可梦"]),
    "Pokemon Sword and Shield": ("宝可梦 剑/盾", ["宝可梦", "剑盾"]),
    "Pokemon Black and White": ("宝可梦 黑/白", ["宝可梦"]),
    "Pokemon HeartGold and SoulSilver": ("宝可梦 心金/魂银", ["宝可梦"]),
    "Minecraft": ("我的世界", ["MC", "麦块"]),
    "Fortnite": ("堡垒之夜", ["吃鸡", "Fortnite"]),
    "League of Legends": ("英雄联盟", ["LOL", "撸啊撸"]),
    "Valorant": ("无畏契约", ["瓦罗兰特", "瓦"]),
    "Genshin Impact": ("原神", ["Genshin"]),
    "Honkai: Star Rail": ("崩坏：星穹铁道", ["星铁", "星穹铁道"]),
    "Zenless Zone Zero": ("绝区零", ["ZZZ"]),
    "Counter-Strike": ("反恐精英", ["CS"]),
    "Hades": ("哈迪斯", ["冥王"]),
}

CONSOLE_MIN_SCORE = 60     # Metacritic-only entries below this are dropped

def dedupe_key(name: str) -> str:
    """Edition- and numeral-insensitive key, so "Divinity: Original Sin II" and
    "Divinity: Original Sin 2 - Definitive Edition" collide. Uses the edition
    and roman maps defined below for match_score()."""
    tokens = [t for t in norm_name(name).split() if t not in _EDITION_WORDS]
    return " ".join(str(_ROMAN.get(t, t)) for t in tokens)

_stats_lock = threading.Lock()
_stats = {"http_requests": 0, "cache_hits": 0, "retries": 0}


def _bump(key: str) -> None:
    with _stats_lock:
        _stats[key] += 1


# --------------------------------------------------------------------------- #
# http + disk cache
# --------------------------------------------------------------------------- #

def _cache_path(url: str, suffix: str = ".json") -> str:
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return os.path.join(HTTP_CACHE, h + suffix)


def _atomic_write(path: str, data: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.%d.tmp" % (path, os.getpid(), threading.get_ident())
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)
    os.replace(tmp, path)


def cached_body(url: str) -> str | None:
    path = _cache_path(url)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)["body"]
    except Exception:  # noqa: BLE001
        return None


class Pacer:
    """Evenly spaces requests across threads.

    store.steampowered.com/api/appdetails allows roughly 200 calls per 5
    minutes per IP; bursting past it earns long 429 streaks, so calls are
    metered up front instead of retried into the ground.
    """

    def __init__(self, calls: int, seconds: float):
        self.interval = seconds / float(calls)
        self._lock = threading.Lock()
        self._next = time.monotonic()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self.interval
        delay = slot - time.monotonic()
        if delay > 0:
            time.sleep(delay)


APPDETAILS_PACER = Pacer(185, 300.0)   # ~1 request / 1.62s
SEARCH_PACER = Pacer(8, 1.0)           # storesearch tolerates ~8 rps


def http_text(url: str, *, refresh: bool = False, cache: bool = True) -> str:
    """GET a URL as text, with an on-disk cache and retry/backoff."""
    path = _cache_path(url)
    if cache and not refresh and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                body = json.load(fh)["body"]
            _bump("cache_hits")
            return body
        except Exception:
            pass

    last = None
    for attempt in range(3):
        if attempt:
            _bump("retries")
            wait = 1.5 * attempt + random.random()
            if isinstance(last, urllib.error.HTTPError) and last.code == 429:
                wait = 25.0 * attempt + random.random() * 5   # quota window
            time.sleep(wait)
        try:
            time.sleep(random.uniform(0.03, 0.10))
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                text = raw.decode("utf-8", "replace")
            _bump("http_requests")
            if cache:
                try:
                    _atomic_write(path, json.dumps({"url": url, "body": text,
                                                    "ts": int(time.time())}))
                except OSError:
                    pass
            return text
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (408, 429, 500, 502, 503, 504):
                raise
        except Exception as exc:  # noqa: BLE001 - network flake
            last = exc
    raise last  # type: ignore[misc]


def http_json(url: str, *, refresh: bool = False) -> object:
    text = http_text(url, refresh=refresh)
    return json.loads(text)

# --------------------------------------------------------------------------- #
# small text helpers
# --------------------------------------------------------------------------- #

_TRADEMARK_RE = re.compile(r"[™®©℗]")
_PAREN_YEAR_RE = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9 ]+")
_SPACES_RE = re.compile(r"\s+")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f]")


def has_cjk(text: object) -> bool:
    """Whether text contains a Han ideograph used by Chinese titles."""
    return isinstance(text, str) and bool(_CJK_RE.search(text))


def load_chinese_names(path: str | None = None) -> dict[str, dict[str, str]]:
    """Load the curated id-to-Chinese-title map used by every build path."""
    path = path or ZH_NAMES_PATH
    if not os.path.isfile(path):
        raise FileNotFoundError(
            "Chinese display-name map is required but missing: %s" % path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Cannot read Chinese display-name map %s: %s"
                         % (path, exc)) from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("Chinese display-name map %s must have version 1" % path)
    names = data.get("names")
    if not isinstance(names, dict):
        raise ValueError("Chinese display-name map %s must contain a names object"
                         % path)
    for game_id, entry in names.items():
        if (not isinstance(game_id, str) or not game_id or
                not isinstance(entry, dict) or
                not isinstance(entry.get("nameZh"), str) or
                not entry["nameZh"].strip() or not has_cjk(entry["nameZh"]) or
                entry.get("type") not in ("common", "reference")):
            raise ValueError("Invalid Chinese display-name entry for id %r in %s"
                             % (game_id, path))
    return names


def apply_chinese_names(records: list[dict],
                        names: dict[str, dict[str, str]]) -> int:
    """Fill missing titles and refresh titles previously set by the curated map."""
    applied = 0
    for record in records:
        entry = names.get(str(record.get("id")))
        if entry is None:
            continue
        current = record.get("nameZh")
        curated = record.get("nameZhType") in ("common", "reference")
        if has_cjk(current) and not curated:
            continue
        if current == entry["nameZh"] and record.get("nameZhType") == entry["type"]:
            continue
        record["nameZh"] = entry["nameZh"]
        record["nameZhType"] = entry["type"]
        applied += 1
    return applied


def localization_stats(records: list[dict],
                       updated_at: str | None = None) -> dict[str, object]:
    translated = sum(1 for record in records if has_cjk(record.get("nameZh")))
    common = sum(1 for record in records
                 if record.get("nameZhType") == "common")
    reference = sum(1 for record in records
                    if record.get("nameZhType") == "reference")
    return {
        "source": "data/game_names_zh.json",
        "total": len(records),
        "translated": translated,
        "common": common,
        "reference": reference,
        "missing": len(records) - translated,
        "updatedAt": updated_at or datetime.now(timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


def clean_name(name: str) -> str:
    s = html.unescape(name or "")
    s = _TRADEMARK_RE.sub(" ", s)
    s = _PAREN_YEAR_RE.sub("", s)
    return _SPACES_RE.sub(" ", s).strip()


def norm_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", clean_name(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    # split CamelCase-ish boundaries so "CSGO" vs "cs go" still overlaps
    s = _NON_ALNUM_RE.sub(" ", s)
    tokens = [t for t in s.split() if t not in ("the", "a", "of", "and")]
    return " ".join(tokens)


def name_similarity(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    ta, tb = set(na.split()), set(nb.split())
    jaccard = len(ta & tb) / len(ta | tb) if (ta | tb) else 0.0
    if na in nb or nb in na:
        ratio = max(ratio, 0.85)
    return max(ratio, jaccard)


_EDITION_WORDS = {
    "remastered", "remake", "remakes", "definitive", "complete", "deluxe",
    "ultimate", "enhanced", "goty", "edition", "collection", "hd", "directors",
    "director", "cut", "anniversary", "special", "trilogy", "compilation",
    "bundle", "gold", "premium", "launch", "standard",
}
_ROMAN = {"ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
          "ix": 9, "x": 10, "xi": 11}


def _sequel_numerals(norm: str) -> set[int]:
    out = set()
    for tok in norm.split():
        if tok.isdigit() and 2 <= int(tok) <= 20:
            out.add(int(tok))
        elif tok in _ROMAN:
            out.add(_ROMAN[tok])
    return out


def match_score(a: str, b: str) -> float:
    """Like name_similarity, but refuses to bridge a sequel gap ("Part II",
    "2", "III"). Edition suffixes (Remastered, Complete ...) are ignored."""
    na = " ".join(t for t in norm_name(a).split() if t not in _EDITION_WORDS)
    nb = " ".join(t for t in norm_name(b).split() if t not in _EDITION_WORDS)
    if not na or not nb:
        return 0.0
    score = name_similarity(na, nb)
    if _sequel_numerals(na) != _sequel_numerals(nb):
        # different instalments: only accept a near-identical title
        return score if score >= 0.95 else 0.0
    return score


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", clean_name(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = s.replace("&", " and ")
    s = re.sub(r"['’`]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def parse_year(text: str) -> int | None:
    m = re.search(r"((?:19|20)\d{2})", text or "")
    return int(m.group(1)) if m else None


def as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# 1. Steam chart
# --------------------------------------------------------------------------- #

def fetch_steam_chart(*, refresh: bool) -> list[dict]:
    url = "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/"
    try:
        data = http_json(url, refresh=refresh)
    except Exception as exc:  # noqa: BLE001
        print("  ! steam chart failed: %s" % exc, file=sys.stderr)
        return []
    ranks = (data.get("response") or {}).get("ranks") or []
    out = []
    for row in ranks:
        appid = as_int(row.get("appid"))
        if not appid:
            continue
        out.append({
            "appid": appid,
            "rank": as_int(row.get("rank")),
            "peak": as_int(row.get("peak_in_game")),
        })
    return out


# --------------------------------------------------------------------------- #
# 2. Steam featured categories (top sellers / new releases / specials)
# --------------------------------------------------------------------------- #

FEATURED_KEYS = ("top_sellers", "new_releases", "specials")


def fetch_steam_featured(*, refresh: bool) -> dict[str, list[int]]:
    url = ("https://store.steampowered.com/api/featuredcategories"
           "?cc=us&l=english")
    out: dict[str, list[int]] = {k: [] for k in FEATURED_KEYS}
    try:
        data = http_json(url, refresh=refresh)
    except Exception as exc:  # noqa: BLE001
        print("  ! steam featured failed: %s" % exc, file=sys.stderr)
        return out
    for key in FEATURED_KEYS:
        block = data.get(key) or {}
        for item in block.get("items") or []:
            # type == 0 / "app" == a store app; type 1 is a bundle/package
            if item.get("type") not in (0, "app", None):
                continue
            appid = as_int(item.get("id"))
            if appid and appid not in out[key]:
                out[key].append(appid)
    return out


# --------------------------------------------------------------------------- #
# 3. Metacritic all-time browse
# --------------------------------------------------------------------------- #

# Two ranked browses from the same Metacritic page family. The site now renders
# these as Nuxt SSR cards (`?page=N`, 50 per page, ~20 pages then empty).
MC_LISTS = [
    ("all", "https://www.metacritic.com/browse/game/all/all/all-time/metascore/"
            "?page=%d"),
    ("pc", "https://www.metacritic.com/browse/game/pc/all/all-time/metascore/"
           "?page=%d"),
]

_MC_RANK_RE = re.compile(r"<span>(\d+)\. </span>")
_MC_DATE_RE = re.compile(r"<span>([A-Z][a-z]{2} \d{1,2}, \d{4})</span>")
_MC_SCORE_RE = re.compile(r"Metascore (\d{1,3}) out of 100")
_MC_HREF_RE = re.compile(r'href="(/game/[^"]+?)"[^>]*>')
_MC_TITLE_RE = re.compile(r'data-title="([^"]*)"')
_MC_PLAT_RE = re.compile(r"i-mc-platform:([a-z0-9\-]+)")
# Card artwork through the site's resize proxy (portrait 2:3; landscape presets
# are not offered, so console-only entries keep the portrait crop).
_MC_IMG_RE = re.compile(
    r'https://www\.metacritic\.com/a/img/resize/[^"\s\\)]+?/catalog/provider/'
    r'[^"\s\\)]+?\?[^"\s\\)]*height=288[^"\s\\)]*')
_MC_IMG_TAG_RE = re.compile(r"<img\b[^>]*>")
_MC_ALT_RE = re.compile(r'alt="([^"]*)"')


def mc_covers(text: str) -> dict[str, str]:
    """alt text -> 2x card artwork URL, for one browse page."""
    covers: dict[str, str] = {}
    for tag in _MC_IMG_TAG_RE.finditer(text):
        raw = tag.group(0)
        alt = _MC_ALT_RE.search(raw)
        src = _MC_IMG_RE.search(raw)
        if alt and src:
            covers[html.unescape(alt.group(1))] = html.unescape(src.group(0))
    return covers
# Nuxt devalue payload fallback: "Title","slug",2022,"2022-02-25",26
_MC_PAYLOAD_RE = re.compile(
    r'"([^"\\]{2,160})","([a-z0-9\-]{2,160})",((?:19|20)\d{2}|null),'
    r'"((?:19|20)\d{2}-\d{2}-\d{2}|null)",(\d{1,5})')


def parse_mc_page(text: str) -> list[dict]:
    """Parse one browse page. The list is server-rendered as cards; the same
    items also appear in the __NUXT_DATA__ devalue stream, used as fallback."""
    anchors = [(m.start(), m.group(1)) for m in _MC_HREF_RE.finditer(text)]
    titles = [(m.start(), html.unescape(m.group(1))) for m in _MC_TITLE_RE.finditer(text)]
    if not titles:
        return parse_mc_payload(text)

    items: list[dict] = []
    covers = mc_covers(text)
    anchor_i = 0
    for idx, (pos, title) in enumerate(titles):
        # nearest preceding /game/ anchor (cards are ~2KB long, nav links are far)
        while anchor_i + 1 < len(anchors) and anchors[anchor_i + 1][0] < pos:
            anchor_i += 1
        slug = None
        if anchors and anchors[anchor_i][0] < pos and pos - anchors[anchor_i][0] < 4000:
            slug = anchors[anchor_i][1].strip("/").split("/")[-1]
        slice_end = len(text)
        if idx + 1 < len(titles):
            slice_end = titles[idx + 1][0]
        nxt_anchor = next((a[0] for a in anchors[anchor_i:] if a[0] > pos), None)
        if nxt_anchor is not None and nxt_anchor < slice_end:
            slice_end = nxt_anchor
        chunk = text[pos:slice_end]

        rank = _MC_RANK_RE.search(chunk)
        date = _MC_DATE_RE.search(chunk)
        score = _MC_SCORE_RE.search(chunk)
        plats = sorted({MC_PLATFORM_MAP[t] for t in _MC_PLAT_RE.findall(chunk)
                        if t in MC_PLATFORM_MAP},
                       key=PLATFORM_ORDER.index)
        art = covers.get(clean_name(title)) or covers.get(title) or ""
        items.append({
            "title": clean_name(title),
            "slug": slug,
            "rank": int(rank.group(1)) if rank else None,
            "score": int(score.group(1)) if score else None,
            "year": parse_year(date.group(1)) if date else None,
            "platforms": plats,
            "cover": art,
        })
    return [i for i in items if i["title"] and i["rank"] is not None]


def parse_mc_payload(text: str) -> list[dict]:
    """Fallback: scrape the Nuxt devalue stream for (title, slug, year, rank)."""
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', text, re.S)
    payload = m.group(1) if m else text
    out = []
    for hit in _MC_PAYLOAD_RE.finditer(payload):
        title = html.unescape(hit.group(1))
        year = as_int(hit.group(3))
        rank = as_int(hit.group(5))
        if not title or rank is None or rank < 1 or rank > 10000:
            continue
        if " " not in title and len(title) < 3:
            continue
        out.append({"title": clean_name(title), "slug": hit.group(2),
                    "rank": rank, "score": None, "year": year,
                    "platforms": []})
    # dedupe by rank, keep first
    seen, uniq = set(), []
    for item in out:
        if item["rank"] in seen:
            continue
        seen.add(item["rank"])
        uniq.append(item)
    return uniq


def fetch_mc_list(url_tpl: str, *, refresh: bool) -> tuple[list[dict], int]:
    """Fetch pages of one browse URL until a page comes back empty."""
    items: list[dict] = []
    with ThreadPoolExecutor(MC_THREADS) as pool:
        futures = {pool.submit(http_text, url_tpl % p, refresh=refresh): p
                   for p in range(1, MAX_MC_PAGES + 1)}
        page_results: dict[int, list[dict]] = {}
        for fut in as_completed(futures):
            page = futures[fut]
            try:
                page_results[page] = parse_mc_page(fut.result())
            except Exception:  # noqa: BLE001
                page_results[page] = []
    pages_ok = 0
    for page in sorted(page_results):
        got = page_results[page]
        if not got:
            break
        pages_ok += 1
        for item in got:
            item["mc_page"] = page
            items.append(item)
    return items, pages_ok


def fetch_metacritic(*, refresh: bool) -> tuple[list[dict], str]:
    """All-time best games, from the all-platform and the PC rankings.

    Both are the same Metacritic browse, one ranked 1000-long page set each;
    the PC one contributes titles the all-platform list omits, and every title
    here still has to resolve to a Steam appid before it is kept."""
    items: list[dict] = []
    parts: list[str] = []
    for label, tpl in MC_LISTS:
        got, pages = fetch_mc_list(tpl, refresh=refresh)
        for item in got:
            item["mc_list"] = label
        items.extend(got)
        if pages:
            parts.append("%s %d pages/%d entries" % (label, pages, len(got)))
    return items, ("; ".join(parts) if parts else "unavailable")


def dedupe_mc(items: list[dict]) -> list[dict]:
    """Collapse per-platform duplicates: keep the best rank + highest score."""
    by_key: dict[str, dict] = {}
    for item in items:
        key = norm_name(item["title"]) or item["title"].lower()
        cur = by_key.get(key)
        if cur is None:
            by_key[key] = dict(item, all_platforms=list(item.get("platforms") or []))
            continue
        cur["all_platforms"] = sorted(set(cur["all_platforms"]) |
                                      set(item.get("platforms") or []),
                                      key=PLATFORM_ORDER.index)
        if item["rank"] < cur["rank"]:
            cur["rank"] = item["rank"]
            cur["title"] = item["title"]
            cur["slug"] = cur["slug"] or item["slug"]
        if item["score"] is not None:
            cur["score"] = max(cur["score"] or 0, item["score"])
        if cur["year"] is None:
            cur["year"] = item["year"]
        if not cur.get("cover") and item.get("cover"):
            cur["cover"] = item["cover"]
    return list(by_key.values())


# --------------------------------------------------------------------------- #
# 4. Metacritic title -> Steam appid
# --------------------------------------------------------------------------- #

def steam_search(term: str, *, refresh: bool, lang: str = "english") -> list[dict]:
    url = ("https://store.steampowered.com/api/storesearch/?term="
           + urllib.parse.quote(term) + "&cc=us&l=" + lang)
    if not refresh and cached_body(url) is None:
        SEARCH_PACER.wait()
    data = http_json(url, refresh=refresh)
    return data.get("items") or []


def resolve_title(item: dict, *, refresh: bool) -> dict | None:
    term = item["title"]
    try:
        results = steam_search(term, refresh=refresh)
    except Exception:  # noqa: BLE001
        return None
    best, best_sim = None, 0.0
    for res in results:
        name = res.get("name") or ""
        sim = match_score(term, name)
        if sim > best_sim:
            best, best_sim = res, sim
    if not best or best_sim < MATCH_THRESHOLD:
        return None
    return {
        "appid": as_int(best.get("id")),
        "steam_name": clean_name(best.get("name") or ""),
        "similarity": round(best_sim, 3),
        "store_metascore": as_int(best.get("metascore")),
    }


# --------------------------------------------------------------------------- #
# 5. Steam appdetails (english full + schinese name)
# --------------------------------------------------------------------------- #

def appdetails_url(appid: int, lang: str, filters: str | None) -> str:
    url = ("https://store.steampowered.com/api/appdetails?appids=%d&l=%s"
           % (appid, lang))
    if filters:
        url += "&filters=" + filters
    return url


def appdetails(appid: int, lang: str, *, refresh: bool, filters: str | None = None):
    """One appdetails call. Cached responses are free; uncached ones go through
    the appdetails pacer so a cold build never trips Steam's quota."""
    url = appdetails_url(appid, lang, filters)
    if refresh or cached_body(url) is None:
        APPDETAILS_PACER.wait()
    try:
        data = http_json(url, refresh=refresh)
    except Exception:  # noqa: BLE001
        return None
    entry = data.get(str(appid)) or {}
    if not entry.get("success"):
        return None
    return entry.get("data") or {}


def fetch_details(appids: list[int], *, refresh: bool) -> dict[int, dict]:
    out: dict[int, dict] = {}
    done = [0]
    total = len(appids) or 1
    with ThreadPoolExecutor(STEAM_THREADS) as pool:
        futures = {pool.submit(appdetails, a, "english", refresh=refresh): a
                   for a in appids}
        for fut in as_completed(futures):
            appid = futures[fut]
            try:
                data = fut.result()
            except Exception:  # noqa: BLE001
                data = None
            if data:
                out[appid] = data
            done[0] += 1
            if done[0] % 100 == 0:
                print("    %d/%d appids" % (done[0], total))
    return out


def zh_name_for(appid: int, english_name: str, *, refresh: bool) -> str | None:
    """Localized store name via a Chinese-locale store search, matched by appid
    (no fuzzy guessing). One cheap call instead of a second appdetails call."""
    try:
        items = steam_search(english_name, refresh=refresh, lang="schinese")
    except Exception:  # noqa: BLE001
        return None
    for item in items:
        if as_int(item.get("id")) == appid and item.get("name"):
            return clean_name(item["name"])
    return None


ZH_FALLBACK_LIMIT = 90


def fetch_zh_names(games: dict[int, dict], *, refresh: bool) -> tuple[dict[int, str], int]:
    """Return ({appid: chinese_name}, fallback_calls)."""
    out: dict[int, str] = {}
    misses: list[int] = []

    def worker(appid: int) -> None:
        data = games.get(appid) or {}
        name = clean_name(data.get("name") or "")
        if not name:
            return
        zh = zh_name_for(appid, name, refresh=refresh)
        if zh:
            with _stats_lock:
                out[appid] = zh
            return
        langs = data.get("supported_languages") or ""
        if "Simplified Chinese" in langs:
            with _stats_lock:
                misses.append(appid)

    with ThreadPoolExecutor(STEAM_THREADS) as pool:
        list(pool.map(worker, sorted(games)))

    misses.sort()
    fallbacks = misses[:ZH_FALLBACK_LIMIT]
    for appid in fallbacks:
        data = appdetails(appid, "schinese", refresh=refresh, filters="basic")
        if data and data.get("name"):
            out[appid] = clean_name(data["name"])
    return out, len(fallbacks)


# --------------------------------------------------------------------------- #
# 6. IGN per-game JSON-LD
# --------------------------------------------------------------------------- #

def ign_slugs(name: str) -> list[str]:
    base = clean_name(name)
    cands = [slugify(base)]
    if ":" in base:
        cands.append(slugify(base.split(":")[0]))
    if base.lower().startswith("the "):
        cands.append(slugify(base[4:]))
    if "-" in base or ":" in base:
        cands.append(slugify(re.sub(r"[:\-–—].*$", "", base)))
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _ign_cache_path(slug: str) -> str:
    return os.path.join(IGN_CACHE, slug + ".json")


def ign_lookup(slug: str, *, refresh: bool) -> dict:
    """One IGN game page -> {name, rating}. Cached compactly (pages are ~350KB)."""
    path = _ign_cache_path(slug)
    if not refresh and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                _bump("cache_hits")
                return json.load(fh)
        except Exception:
            pass
    result = {"slug": slug, "status": 0, "name": None, "rating": None}
    try:
        text = http_text("https://www.ign.com/games/" + slug, refresh=refresh,
                         cache=False)
    except urllib.error.HTTPError as exc:
        result["status"] = exc.code
        _atomic_write(path, json.dumps(result))
        return result
    except Exception:  # noqa: BLE001
        result["status"] = -1
        return result

    result["status"] = 200
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>',
                        text, re.S)
    for raw in blocks:
        if '"Game"' not in raw:
            continue
        try:
            doc = json.loads(raw)
        except Exception:  # noqa: BLE001
            continue
        items = doc if isinstance(doc, list) else [doc]
        for obj in items:
            if not isinstance(obj, dict):
                continue
            if obj.get("@type") not in ("Game", "VideoGame"):
                continue
            result["name"] = obj.get("name")
            rating = (obj.get("review") or {}).get("reviewRating") or {}
            value = rating.get("ratingValue")
            if isinstance(value, str):
                value = value.strip()
            try:
                value = float(value)
            except (TypeError, ValueError):
                value = None
            if value is not None and 0.0 <= value <= 10.0:
                result["rating"] = round(value, 1)
            break
        if result["name"]:
            break
    _atomic_write(path, json.dumps(result))
    return result


def fetch_ign(records: list[dict], *, refresh: bool) -> tuple[int, int]:
    """Fill record['ign']. Returns (hits, attempts)."""
    attempts = 0
    hits = 0
    error_streak = [0]

    def worker(record: dict) -> None:
        nonlocal attempts, hits
        for slug in ign_slugs(record["name"])[:3]:
            try:
                res = ign_lookup(slug, refresh=refresh)
            except Exception:  # noqa: BLE001
                return
            with _stats_lock:
                attempts += 1
            if res.get("status") == 200 and res.get("name"):
                if match_score(record["name"], res["name"]) >= IGN_MATCH_THRESHOLD:
                    if res.get("rating") is not None:
                        record["ign"] = res["rating"]
                        with _stats_lock:
                            hits += 1
                    return
                return  # page exists but is a different game: stop, don't guess
            if res.get("status") in (403, 429):
                error_streak[0] += 1
                return

    with ThreadPoolExecutor(IGN_THREADS) as pool:
        list(pool.map(worker, records))
    return hits, attempts


# --------------------------------------------------------------------------- #
# 7. assembly
# --------------------------------------------------------------------------- #

def build_record(appid: int, data: dict, zh: str | None,
                 chart: dict | None, featured: dict[str, list[int]],
                 mc: dict | None) -> dict:
    platforms = set()
    plats = data.get("platforms") or {}
    if plats.get("windows"):
        platforms.add("PC")
    if plats.get("mac"):
        platforms.add("Mac")
    if plats.get("linux"):
        platforms.add("Linux")
    if mc:
        platforms |= set(mc.get("all_platforms") or [])

    steam_mc = as_int((data.get("metacritic") or {}).get("score"))
    mc_score = (mc or {}).get("score")
    mc_score = mc_score if mc_score is not None else steam_mc

    year = parse_year((data.get("release_date") or {}).get("date") or "")
    if year is None and mc:
        year = mc.get("year")

    genres = [g.get("description") for g in (data.get("genres") or [])
              if g.get("description")]

    return {
        "id": appid,
        "name": clean_name(data.get("name") or ""),
        "nameZh": zh or "",
        "aliases": list(ALIASES.get(appid, [])),
        "mc": mc_score,
        "ign": None,
        "year": year,
        "platforms": [p for p in PLATFORM_ORDER if p in platforms],
        "genres": genres,
        "cover": data.get("header_image") or "",
        "popularity": 0.0,
        "popDetail": {
            "chartRank": (chart or {}).get("rank"),
            "peak": (chart or {}).get("peak"),
        },
        "_mcRank": (mc or {}).get("rank"),
    }


CONSOLE_ZH_NORM = {norm_name(k): v for k, v in CONSOLE_ZH.items()}


def build_console_records(items: list[dict],
                          steam_by_key: dict[str, dict]) -> list[dict]:
    """Metacritic ranking entries with no Steam appid: console exclusives and
    f2p titles Steam does not list. Their ids are `mc:<slug>` strings, their
    art is the 2:3 Metacritic card image, and their Chinese names only exist
    where CONSOLE_ZH covers them (never guessed).

    A title whose edition-insensitive key matches a Steam record is not added
    again; its Metascore is copied onto that record when Steam had none."""
    out: list[dict] = []
    for item in items:
        slug = item.get("slug")
        score = item.get("score")
        key = dedupe_key(item.get("title") or "")
        if not key or not slug or score is None or score < CONSOLE_MIN_SCORE:
            continue
        existing = steam_by_key.get(key)
        if existing is not None:
            if existing.get("mc") is None:
                existing["mc"] = score
            continue
        zh, extra = CONSOLE_ZH_NORM.get(norm_name(item["title"]), ("", []))
        out.append({
            "id": "mc:" + slug,
            "name": item["title"],
            "nameZh": zh,
            "aliases": list(extra),
            "mc": score,
            "ign": None,
            "year": item.get("year"),
            "platforms": list(item.get("all_platforms") or []),
            "genres": [],
            "cover": item.get("cover") or "",
            "coverPortrait": True,
            "popularity": 0.0,
            "popDetail": {"chartRank": None, "peak": None},
            "_mcRank": item["rank"],
        })
    return out


def compute_popularity(records: list[dict], featured: dict[str, list[int]],
                       mc_total: int) -> None:
    top_sellers = set(featured.get("top_sellers", []))
    new_releases = set(featured.get("new_releases", []))
    max_peak = max((r["popDetail"]["peak"] or 0) for r in records) or 1

    for rec in records:
        peak = rec["popDetail"]["peak"] or 0
        rank = rec["popDetail"]["chartRank"]

        peak_norm = peak / max_peak                                    # dominant
        rank_norm = 0.0 if not rank else max(0.0, 1.0 - (rank - 1) / 100.0)
        mc_rank = rec.get("_mcRank")
        mc_rank_norm = 0.0 if not mc_rank else max(0.0, 1.0 - (mc_rank - 1) / max(mc_total, 1))
        mc_score_norm = 0.0
        if rec["mc"] is not None:
            mc_score_norm = min(1.0, max(0.0, (rec["mc"] - 60) / 40.0))
        shelf = 1.0 if rec["id"] in top_sellers else 0.0
        fresh = 0.5 if rec["id"] in new_releases and not shelf else 0.0

        rec["popularity"] = round(
            0.58 * peak_norm
            + 0.14 * rank_norm
            + 0.10 * mc_rank_norm
            + 0.09 * mc_score_norm
            + 0.06 * shelf
            + 0.03 * fresh
            + 0.02, 6)                                                 # floor
        rec.pop("_mcRank", None)

    top = max((r["popularity"] for r in records), default=1.0) or 1.0
    for rec in records:
        value = rec["popularity"] / top
        rec["popularity"] = round(min(1.0, max(0.01, value)), 4)
    records.sort(key=lambda r: (-r["popularity"], -(r["popDetail"]["peak"] or 0),
                                r["name"].lower()))


def render_js(records: list[dict], meta: dict) -> str:
    lines = [
        "// AUTO-GENERATED by scripts/build_games.py — do not edit by hand.",
        "// Sources: %s" % ", ".join(meta["sources"]),
        "// Generated: %s | games: %d" % (meta["generatedAt"], meta["count"]),
        "window.GAMES = [",
    ]
    for rec in records:
        payload = json.dumps(rec, ensure_ascii=False, indent=1)
        lines.append(payload.replace("\n", "\n "))
        lines[-1] = lines[-1] + ","
    if records:
        lines[-1] = lines[-1][:-1]
    lines.append("];")
    lines.append("window.GAMES_META = " + json.dumps(meta, ensure_ascii=False) + ";")
    return "\n".join(lines) + "\n"


def load_snapshot(path: str) -> tuple[list[dict], dict]:
    """Read this builder's two JSON assignments without executing JavaScript."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        raise ValueError("Cannot read generated game snapshot %s: %s"
                         % (path, exc)) from exc

    if (len(lines) < 6 or
            lines[0] != "// AUTO-GENERATED by scripts/build_games.py — do not edit by hand." or
            not lines[1].startswith("// Sources: ") or
            not lines[2].startswith("// Generated: ") or
            lines[3] != "window.GAMES = ["):
        raise ValueError("Unrecognized generated game snapshot: %s" % path)
    try:
        end = lines.index("];")
    except ValueError as exc:
        raise ValueError("Generated game snapshot has no array terminator: %s"
                         % path) from exc
    meta_index = end + 1
    meta_prefix = "window.GAMES_META = "
    if (meta_index != len(lines) - 1 or
            not lines[meta_index].startswith(meta_prefix) or
            not lines[meta_index].endswith(";")):
        raise ValueError("Generated game snapshot contains unexpected JavaScript: %s"
                         % path)

    array_assignment = "\n".join(lines[3:end + 1])
    array_json = array_assignment[len("window.GAMES = "):-1]
    meta_json = lines[meta_index][len(meta_prefix):-1]

    def reject_constant(value: str) -> None:
        raise ValueError("Invalid JSON constant %s" % value)

    try:
        records = json.loads(array_json, parse_constant=reject_constant)
        meta = json.loads(meta_json, parse_constant=reject_constant)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("Generated game snapshot contains invalid JSON: %s"
                         % path) from exc
    if (not isinstance(records, list) or
            not all(isinstance(record, dict) for record in records) or
            not isinstance(meta, dict) or meta.get("count") != len(records)):
        raise ValueError("Generated game snapshot has invalid records or metadata: %s"
                         % path)
    return records, meta


def bump_cache_token(count: int, generated_at: str) -> str | None:
    """Rewrite the ?v= cache-buster on data/games.js and its siblings in
    index.html. Without it a browser can keep serving a previously cached
    library after a rebuild (the site showed 19 games while data/games.js
    held 857). The token also carries a digest of the three assets, so edits
    to app.js or styles.css invalidate them too."""
    if not os.path.exists(INDEX_PATH):
        return None
    digest = hashlib.sha1()
    for asset in ("data/games.js", "app.js", "styles.css"):
        path = os.path.join(ROOT, asset)
        try:
            with open(path, "rb") as fh:
                digest.update(fh.read())
        except OSError:
            digest.update(asset.encode("utf-8"))
    token = "%s-%d-%s" % (generated_at[:10].replace("-", ""), count,
                          digest.hexdigest()[:8])
    with open(INDEX_PATH, "r", encoding="utf-8") as fh:
        text = fh.read()
    patched, changed = CACHE_TOKEN_RE.subn(
        lambda m: "%s?v=%s%s" % (m.group(1), token, m.group(2)), text)
    if not changed:
        return None
    if patched != text:
        _atomic_write(INDEX_PATH, patched)
    return token


def load_fixture_ids() -> dict[int, str]:
    """Snapshot the pre-existing 19-game fixture so re-runs can still diff
    against it after data/games.js has been overwritten. Must run before the
    new file is written, and never re-snapshots generated output."""
    if os.path.exists(FIXTURE_IDS):
        try:
            with open(FIXTURE_IDS, "r", encoding="utf-8") as fh:
                return {int(k): v for k, v in json.load(fh).items()}
        except Exception:
            pass
    if not os.path.exists(OUT_PATH):
        return {}
    try:
        text = open(OUT_PATH, "r", encoding="utf-8").read()
        if "AUTO-GENERATED fixture" not in text[:400]:
            return {}
        pairs = re.findall(r'"id":\s*(\d+),\s*\n?\s*"name":\s*"([^"]*)"', text)
        fixture = {int(a): b for a, b in pairs}
        if fixture:
            _atomic_write(FIXTURE_IDS, json.dumps(fixture, ensure_ascii=False))
        return fixture
    except Exception:  # noqa: BLE001
        return {}


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Build data/games.js")
    ap.add_argument("--refresh", action="store_true",
                    help="ignore the on-disk cache")
    ap.add_argument("--no-ign", action="store_true", help="skip IGN scores")
    ap.add_argument("--localize-only", action="store_true",
                    help="apply curated Chinese names to the existing snapshot without network requests")
    args = ap.parse_args(argv)

    try:
        chinese_names = load_chinese_names()
    except (OSError, ValueError) as exc:
        ap.error(str(exc))

    if args.localize_only:
        records, meta = load_snapshot(OUT_PATH)
        applied = apply_chinese_names(records, chinese_names)
        previous_localization = meta.get("localization")
        previous_updated_at = None
        if (applied == 0 and isinstance(previous_localization, dict) and
                isinstance(previous_localization.get("updatedAt"), str)):
            previous_updated_at = previous_localization["updatedAt"]
        localization = localization_stats(records, previous_updated_at)
        if applied == 0 and localization == previous_localization:
            print("Localization is already current; snapshot left unchanged")
            return 0
        meta["localization"] = localization
        js = render_js(records, meta)
        _atomic_write(OUT_PATH, js)
        token = bump_cache_token(len(records), meta["generatedAt"])
        print("Localized %d of %d records (%d currently contain Chinese titles)"
              % (applied, len(records), meta["localization"]["translated"]))
        print("  index.html cache token: v=%s"
              % (token or "unchanged (no script tag found)"))
        return 0

    for d in (CACHE_DIR, HTTP_CACHE, IGN_CACHE):
        os.makedirs(d, exist_ok=True)

    fixture = load_fixture_ids()   # before data/games.js is replaced
    started = time.time()
    sources: list[str] = []

    print("[1/6] Steam chart + featured categories")
    chart = fetch_steam_chart(refresh=args.refresh)
    featured = fetch_steam_featured(refresh=args.refresh)
    if chart:
        sources.append("Steam Most Played (%d entries)" % len(chart))
    if any(featured.values()):
        sources.append("Steam Top Sellers (%d) / New Releases (%d)"
                       % (len(featured["top_sellers"]),
                          len(featured["new_releases"])))
    chart_by_app: dict[int, dict] = {row["appid"]: row for row in chart}

    print("[2/6] Metacritic all-time browse")
    mc_items, mc_note = fetch_metacritic(refresh=args.refresh)
    mc_unique = dedupe_mc(mc_items) if mc_items else []
    if mc_unique:
        sources.append("Metacritic all-time best (%s)" % mc_note)
    else:
        sources.append("Metacritic: unavailable")
    print("  %d raw entries -> %d unique titles" % (len(mc_items), len(mc_unique)))

    print("[3/6] Resolving Metacritic titles to Steam appids")
    mc_by_appid: dict[int, dict] = {}
    unresolved = 0
    with ThreadPoolExecutor(STEAM_THREADS) as pool:
        futures = {pool.submit(resolve_title, item, refresh=args.refresh): item
                   for item in mc_unique}
        for fut in as_completed(futures):
            item = futures[fut]
            try:
                match = fut.result()
            except Exception:  # noqa: BLE001
                match = None
            if not match or not match["appid"]:
                unresolved += 1
                continue
            appid = match["appid"]
            entry = {
                "score": item["score"] if item["score"] is not None
                else match.get("store_metascore"),
                "rank": item["rank"],
                "year": item["year"],
                "all_platforms": item["all_platforms"],
                "title": item["title"],
            }
            prev = mc_by_appid.get(appid)
            if prev is None:
                mc_by_appid[appid] = entry
            else:
                # same Steam app for two MC entries: keep the better rank
                if entry["rank"] < prev["rank"]:
                    entry["score"] = max(entry["score"] or 0, prev["score"] or 0) or None
                    mc_by_appid[appid] = entry
                else:
                    prev["score"] = max(prev["score"] or 0, entry["score"] or 0) or None
                    prev["all_platforms"] = sorted(
                        set(prev["all_platforms"]) | set(entry["all_platforms"]),
                        key=PLATFORM_ORDER.index)
    print("  matched %d appids, %d unmatched titles dropped"
          % (len(mc_by_appid), unresolved))
    if mc_by_appid:
        sources.append("Steam storesearch matching (%d matched)" % len(mc_by_appid))

    candidate_ids = set(mc_by_appid) | set(chart_by_app) | {
        a for ids in featured.values() for a in ids}
    print("[4/6] appdetails for %d candidate appids" % len(candidate_ids))
    details = fetch_details(sorted(candidate_ids), refresh=args.refresh)
    games = {a: d for a, d in details.items() if d.get("type") == "game"}
    print("  %d store entries, %d are type=game" % (len(details), len(games)))

    print("  fetching Chinese names")
    zh_names, zh_fallbacks = fetch_zh_names(games, refresh=args.refresh)
    if zh_names:
        sources.append("Steam storesearch l=schinese (%d names)" % len(zh_names))
    print("  %d Chinese names (%d appdetails fallbacks)"
          % (len(zh_names), zh_fallbacks))

    records = []
    for appid, data in games.items():
        mc = mc_by_appid.get(appid)
        records.append(build_record(appid, data, zh_names.get(appid),
                                    chart_by_app.get(appid), featured, mc))
    print("  %d Steam records" % len(records))

    steam_by_key: dict[str, dict] = {}
    for rec in records:
        for raw in (rec["name"], rec["nameZh"]):
            key = dedupe_key(raw or "")
            if key:
                steam_by_key.setdefault(key, rec)
        for alias in rec["aliases"]:
            key = dedupe_key(alias)
            if key:
                steam_by_key.setdefault(key, rec)
    console_records = build_console_records(mc_unique, steam_by_key)
    records.extend(console_records)
    if console_records:
        sources.append("Metacritic-only catalogue (%d console/f2p titles)"
                       % len(console_records))
    print("  %d Metacritic-only records (no Steam appid)" % len(console_records))

    if args.no_ign:
        sources.append("IGN: skipped (--no-ign)")
    else:
        print("[5/6] IGN review scores (JSON-LD, one request per game)")
        # Console-only entries are looked up only when they are high profile,
        # to keep a cold build's request count bounded.
        ign_scope = [r for r in records
                     if not str(r["id"]).startswith("mc:") or (r["mc"] or 0) >= 88]
        hits, attempts = fetch_ign(ign_scope, refresh=args.refresh)
        with_ign = sum(1 for r in records if r["ign"] is not None)
        print("  %d IGN scores filled (%d requests attempted)" % (with_ign, attempts))
        if hits:
            sources.append("IGN review scores (%d)" % with_ign)
        else:
            sources.append("IGN: unavailable")

    mc_total = max((m.get("rank") or 0) for m in mc_by_appid.values()) if mc_by_appid else 0
    compute_popularity(records, featured, mc_total)
    localized = apply_chinese_names(records, chinese_names)
    print("  %d curated Chinese display names filled" % localized)
    sources.append("Steam appdetails l=english (%d)" % len(games))

    meta = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0)
        .isoformat().replace("+00:00", "Z"),
        "sources": sources,
        "count": len(records),
        "localization": localization_stats(records),
    }
    js = render_js(records, meta)
    _atomic_write(OUT_PATH, js)
    token = bump_cache_token(len(records), meta["generatedAt"])

    # ---- stats ---------------------------------------------------------- #
    print("[6/6] Wrote %s (%d games, %.1f KB) in %.0fs"
          % (os.path.relpath(OUT_PATH, ROOT), len(records),
             len(js.encode("utf-8")) / 1024.0, time.time() - started))
    print("  index.html cache token: v=%s" % (token or "unchanged (no script tag found)"))
    ids = [r["id"] for r in records]
    pops = [r["popularity"] for r in records]
    with_zh = sum(1 for r in records if r["nameZh"] and not r["nameZh"].isascii())
    with_zh_any = sum(1 for r in records if r["nameZh"])
    with_mc = sum(1 for r in records if r["mc"] is not None)
    with_cover = sum(1 for r in records if r["cover"])
    with_ign = sum(1 for r in records if r["ign"] is not None)
    total = len(records) or 1
    print("  games: %d  (unique ids: %d, duplicates: %d)"
          % (len(records), len(set(ids)), len(ids) - len(set(ids))))
    print("  nameZh: %.1f%% (%d non-ASCII, %d non-empty)"
          % (100.0 * with_zh_any / total, with_zh, with_zh_any))
    print("  mc:     %.1f%% (%d)" % (100.0 * with_mc / total, with_mc))
    print("  cover:  %.1f%% (%d)" % (100.0 * with_cover / total, with_cover))
    print("  ign:    %.1f%% (%d)" % (100.0 * with_ign / total, with_ign))
    print("  popularity min/max: %.4f / %.4f"
          % (min(pops) if pops else 0, max(pops) if pops else 0))
    print("  cache: %d http requests, %d cache hits, %d retries"
          % (_stats["http_requests"], _stats["cache_hits"], _stats["retries"]))
    print("  sources: " + " | ".join(sources))

    if fixture:
        present = [a for a in fixture if a in games]
        print("  fixture cross-check: %d/%d ids present" % (len(present), len(fixture)))
        for appid, old_name in sorted(fixture.items(), key=lambda kv: kv[1]):
            new = games.get(appid)
            if new and norm_name(old_name) != norm_name(new.get("name") or ""):
                print("    ~ %s: %r -> %r" % (appid, old_name, new.get("name")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
