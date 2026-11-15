/* GameRank — UI logic.
 * Plain global script (no modules, no build). Reads window.GAMES / window.GAMES_META
 * provided by data/games.js. Works from file:// and from http(s).
 */
(function () {
  'use strict';

  var STORAGE = {
    saves: 'gamerank.saves.v1',          // named save slots (ranking + customs each)
    ranking: 'gamerank.ranking.v1',      // legacy single-slot key, migrated once
    custom: 'gamerank.custom.v1',        // legacy single-slot key, migrated once
    theme: 'gamerank.theme.v1'
  };
  var HOT_SUGGESTIONS = 12;   // rows shown for an empty query
  var MAX_SUGGESTIONS = 50;   // hard cap for query results
  var BROWSE_CHUNK = 60;      // rows appended per "load more" in the browse dialog
  var QUICK_CHIPS = 6;        // quick-add chips in the empty state
  var SEARCH_DEBOUNCE = 60;

  /* ---------------------------------------------------------------- storage */

  var storageBroken = false;
  var storageWarned = false;

  var store = {
    get: function (key) {
      try { return window.localStorage.getItem(key); } catch (err) { return null; }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (err) {
        storageBroken = true;
        return false;
      }
    }
  };

  /* -------------------------------------------------------------------- dom */

  var els = {};

  function cacheDom() {
    els.input = document.getElementById('gameInput');
    els.clearInput = document.getElementById('clearInputBtn');
    els.combo = els.input ? els.input.closest('.combo') : null;
    els.list = document.getElementById('suggestions');
    els.status = document.getElementById('comboStatus');
    els.provenance = document.getElementById('provenance');
    els.warning = document.getElementById('dataWarning');
    els.listRanking = document.getElementById('rankingList');
    els.empty = document.getElementById('emptyState');
    els.hotChips = document.getElementById('hotChips');
    els.countPill = document.getElementById('countPill');
    els.countSr = document.getElementById('countSr');
    els.shareBtn = document.getElementById('shareBtn');
    els.exportBtn = document.getElementById('exportBtn');
    els.clearRankBtn = document.getElementById('clearRankBtn');
    els.themeBtn = document.getElementById('themeBtn');
    els.saveBtn = document.getElementById('saveBtn');
    els.saveBtnName = document.getElementById('saveBtnName');
    els.saveDialog = document.getElementById('saveDialog');
    els.saveList = document.getElementById('saveList');
    els.saveForm = document.getElementById('saveForm');
    els.saveNameInput = document.getElementById('saveNameInput');
    els.saveNameErr = document.getElementById('saveNameErr');
    els.boardSaveName = document.getElementById('boardSaveName');
    els.customDialog = document.getElementById('customDialog');
    els.customForm = document.getElementById('customForm');
    els.cName = document.getElementById('cName');
    els.cZh = document.getElementById('cZh');
    els.cScore = document.getElementById('cScore');
    els.cYear = document.getElementById('cYear');
    els.exportDialog = document.getElementById('exportDialog');
    els.exportText = document.getElementById('exportText');
    els.copyExportBtn = document.getElementById('copyExportBtn');
    els.browseDialog = document.getElementById('browseDialog');
    els.browseSearch = document.getElementById('browseSearch');
    els.browseList = document.getElementById('browseList');
    els.browseCount = document.getElementById('browseCount');
    els.browseMoreBtn = document.getElementById('browseMoreBtn');
    els.toast = document.getElementById('toast');
  }

  /* ------------------------------------------------------------------ state */

  var state = {
    library: [],      // normalized entries, sorted by popularity desc
    index: new Map(), // key -> entry
    ranking: [],      // [{ key, custom }]
    customs: [],      // raw custom objects, as persisted
    suggestions: [],  // [{ type:'game', game } | { type:'create', query }]
    active: -1,
    open: false,
    composing: false,
    theme: 'light',
    builtinCount: 0,
    customCount: 0,
    saves: [],          // [{ id, name, createdAt, updatedAt, ranking, customs }]
    activeSaveId: ''    // id of the slot currently shown
  };

  var pendingFocus = null;
  var searchTimer = 0;

  /* ------------------------------------------------------------------ utils */

  function num(value) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(n) ? n : null;
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      try { return window.crypto.randomUUID(); } catch (err) { /* fall through */ }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  function hasCjk(text) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
  }

  function gameLabel(game) {
    if (!game) return '未知游戏';
    if (game.missing) return '未知游戏 #' + game.key;
    return game.nameZh || game.name || ('游戏 #' + game.key);
  }

  function initials(game) {
    var source = (game.nameZh && hasCjk(game.nameZh) ? game.nameZh : (game.name || game.nameZh || '')).trim();
    if (!source) return '?';
    if (hasCjk(source)) return source.slice(0, 2);
    var parts = source.split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase() || '?';
  }

  /* ------------------------------------------------------------- normalizing */

  function stripBrackets(value) {
    return String(value || '')
      .replace(/^《\s*/, '')
      .replace(/\s*》$/, '')
      .trim();
  }

  function toEntry(raw, forcedCustom) {
    if (!raw || typeof raw !== 'object') return null;
    var rawId = raw.id;
    if (rawId === undefined || rawId === null || rawId === '') return null;

    var isCustom = forcedCustom === true ||
      raw.custom === true ||
      (typeof rawId === 'string' && rawId.indexOf('custom:') === 0);
    var key = String(rawId);
    if (isCustom && key.indexOf('custom:') !== 0) key = 'custom:' + key;

    var name = str(raw.name).trim();
    var nameZh = stripBrackets(str(raw.nameZh));
    if (!name && !nameZh) return null;

    var aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter(function (a) { return typeof a === 'string' && a.trim() !== ''; }).map(function (a) { return a.trim(); })
      : [];

    var mc = num(raw.mc);
    if (mc !== null) mc = Math.max(0, Math.min(100, Math.round(mc)));

    var ignRaw = num(raw.ign);
    var ign = ignRaw === null ? null : Math.max(0, Math.min(10, Math.round(ignRaw * 10) / 10));

    var year = num(raw.year);
    year = year === null ? null : Math.round(year);

    var platforms = Array.isArray(raw.platforms)
      ? raw.platforms.filter(function (p) { return typeof p === 'string' && p !== ''; })
      : [];

    var genres = Array.isArray(raw.genres)
      ? raw.genres.filter(function (g) { return typeof g === 'string' && g !== ''; })
      : [];

    var popularity = num(raw.popularity);
    popularity = popularity === null ? 0 : Math.max(0, Math.min(1, popularity));

    var cover = str(raw.cover).trim();
    if (cover.indexOf('http') !== 0) cover = '';

    return {
      key: key,
      id: raw.id,
      name: name || nameZh,
      nameZh: nameZh,
      aliases: aliases,
      mc: mc,
      ign: ign,
      year: year,
      platforms: platforms,
      genres: genres,
      cover: cover,
      coverPortrait: raw.coverPortrait === true,
      popularity: popularity,
      custom: isCustom,
      missing: false,
      nameL: (name || nameZh).toLowerCase(),
      nameZhL: nameZh.toLowerCase(),
      aliasL: aliases.map(function (a) { return a.toLowerCase(); })
    };
  }

  function ghostEntry(key) {
    return {
      key: key,
      name: '',
      nameZh: '',
      aliases: [],
      mc: null,
      ign: null,
      year: null,
      platforms: [],
      genres: [],
      cover: '',
      coverPortrait: false,
      popularity: 0,
      custom: key.indexOf('custom:') === 0,
      missing: true,
      nameL: '',
      nameZhL: '',
      aliasL: []
    };
  }

  function entryFor(key) {
    return state.index.get(key) || ghostEntry(key);
  }

  function readCustomsRaw() {
    var save = currentSave();
    if (!save || !Array.isArray(save.customs)) return [];
    return save.customs.filter(function (item) { return item && typeof item === 'object'; });
  }

  /* -------------------------------------------------------------- save slots */

  var saveSeq = 0;

  function newSaveId() {
    saveSeq += 1;
    return 's_' + Date.now().toString(36) + saveSeq.toString(36);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeSave(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    var name = str(raw.name).trim() || '未命名存档';
    return {
      id: raw.id,
      name: name.slice(0, 40),
      createdAt: str(raw.createdAt) || nowIso(),
      updatedAt: str(raw.updatedAt) || str(raw.createdAt) || nowIso(),
      ranking: Array.isArray(raw.ranking) ? raw.ranking : [],
      customs: Array.isArray(raw.customs) ? raw.customs : []
    };
  }

  function migrateLegacySaves() {
    var ranking = [];
    var customs = [];
    try { ranking = JSON.parse(store.get(STORAGE.ranking) || '[]'); } catch (err) { ranking = []; }
    try { customs = JSON.parse(store.get(STORAGE.custom) || '[]'); } catch (err) { customs = []; }
    if (!Array.isArray(ranking)) ranking = [];
    if (!Array.isArray(customs)) customs = [];
    var save = normalizeSave({
      id: newSaveId(),
      name: '我的排行',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ranking: ranking,
      customs: customs
    });
    return { saves: [save], activeId: save.id };
  }

  function readSaves() {
    var raw = store.get(STORAGE.saves);
    var data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch (err) { data = null; }
    }
    if (data && Array.isArray(data.saves)) {
      var saves = [];
      for (var i = 0; i < data.saves.length; i++) {
        var save = normalizeSave(data.saves[i]);
        if (save) saves.push(save);
      }
      if (saves.length) {
        var active = null;
        for (var j = 0; j < saves.length; j++) {
          if (saves[j].id === data.activeId) { active = saves[j].id; break; }
        }
        return { saves: saves, activeId: active || saves[0].id };
      }
    }
    return migrateLegacySaves();
  }

  function writeSaves() {
    var payload = JSON.stringify({
      version: 1,
      activeId: state.activeSaveId,
      saves: state.saves
    });
    if (!store.set(STORAGE.saves, payload)) warnStorageOnce();
  }

  function currentSave() {
    for (var i = 0; i < state.saves.length; i++) {
      if (state.saves[i].id === state.activeSaveId) return state.saves[i];
    }
    return state.saves.length ? state.saves[0] : null;
  }

  function saveById(id) {
    for (var i = 0; i < state.saves.length; i++) {
      if (state.saves[i].id === id) return state.saves[i];
    }
    return null;
  }

  function loadSaveSlots() {
    var loaded = readSaves();
    state.saves = loaded.saves;
    state.activeSaveId = loaded.activeId;
    // Always persist so the migrated slot becomes the canonical store.
    writeSaves();
  }

  function buildLibrary() {
    var list = [];
    var source = Array.isArray(window.GAMES) ? window.GAMES : [];
    var builtin = 0;
    var i;

    for (i = 0; i < source.length; i++) {
      var entry = toEntry(source[i], false);
      if (entry) { list.push(entry); builtin++; }
    }
    var custom = 0;
    for (i = 0; i < state.customs.length; i++) {
      var cEntry = toEntry(state.customs[i], true);
      if (cEntry) { list.push(cEntry); custom++; }
    }

    list.sort(function (a, b) {
      if (b.popularity !== a.popularity) return b.popularity - a.popularity;
      return a.name.localeCompare(b.name);
    });

    var index = new Map();
    for (i = 0; i < list.length; i++) {
      if (!index.has(list[i].key)) index.set(list[i].key, list[i]);
    }

    state.library = list;
    state.index = index;
    state.builtinCount = builtin;
    state.customCount = custom;
  }

  function normalizeRanking(parsed) {
    if (!Array.isArray(parsed)) return [];

    var out = [];
    var seen = new Set();
    for (var i = 0; i < parsed.length; i++) {
      var item = parsed[i];
      var key = null;
      if (typeof item === 'string' || typeof item === 'number') {
        key = String(item);
      } else if (item && typeof item === 'object' && item.key !== undefined && item.key !== null) {
        key = String(item.key);
      }
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key: key, custom: !!(item && item.custom) || key.indexOf('custom:') === 0 });
    }
    return out;
  }

  function readRanking() {
    var save = currentSave();
    return save ? normalizeRanking(save.ranking) : [];
  }

  function persistRanking() {
    var save = currentSave();
    if (!save) return;
    save.ranking = state.ranking.map(function (item) {
      return item.custom ? { key: item.key, custom: true } : { key: item.key };
    });
    save.updatedAt = nowIso();
    writeSaves();
  }

  function persistCustoms() {
    var save = currentSave();
    if (!save) return;
    save.customs = state.customs;
    save.updatedAt = nowIso();
    writeSaves();
  }

  function warnStorageOnce() {
    if (storageWarned) return;
    storageWarned = true;
    toast('浏览器禁止访问本地存储，本次改动不会被保存');
  }

  /* ---------------------------------------------------------------- search */

  function fieldScore(haystack, token) {
    if (!haystack) return 0;
    var at = haystack.indexOf(token);
    if (at < 0) return 0;
    if (at === 0) return haystack.length === token.length ? 3 : 2;
    return 1;
  }

  function gameScore(game, tokens) {
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var best = fieldScore(game.nameL, token);
      if (best < 3) best = Math.max(best, fieldScore(game.nameZhL, token));
      for (var k = 0; k < game.aliasL.length && best < 3; k++) {
        best = Math.max(best, fieldScore(game.aliasL[k], token));
      }
      if (best === 0) return 0;
      total += best;
    }
    return total;
  }

  function buildSuggestions(rawQuery) {
    var query = rawQuery.trim();

    if (!query) {
      return state.library.slice(0, HOT_SUGGESTIONS).map(function (game) {
        return { type: 'game', game: game };
      });
    }

    var tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    var hits = [];
    for (var i = 0; i < state.library.length; i++) {
      var game = state.library[i];
      var score = gameScore(game, tokens);
      if (score > 0) hits.push({ game: game, score: score });
    }
    hits.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.game.popularity !== a.game.popularity) return b.game.popularity - a.game.popularity;
      return a.game.name.localeCompare(b.game.name);
    });

    if (!hits.length) {
      return [{ type: 'create', query: query }];
    }
    return hits.slice(0, MAX_SUGGESTIONS).map(function (hit) {
      return { type: 'game', game: hit.game };
    });
  }

  /* -------------------------------------------------------------- UI pieces */

  var ICONS = {
    grip: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>',
    up: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    down: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l.9 12.2h9.2L17.5 7"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>'
  };

  function icon(name) {
    var wrap = document.createElement('span');
    wrap.className = 'icon-slot';
    wrap.innerHTML = ICONS[name] || '';   // static markup only, never user data
    return wrap.firstElementChild || wrap;
  }

  function textEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function srText(text) {
    return textEl('span', 'sr-only', text);
  }

  function scoreTile(value, small) {
    var score = Math.round(value);
    var tile = textEl('span', 'score-tile' + (small ? ' score-tile--sm' : ''), String(score));
    tile.classList.add(score >= 75 ? 'score-tile--good' : (score >= 50 ? 'score-tile--mixed' : 'score-tile--bad'));
    tile.title = 'Metascore ' + score;
    return tile;
  }

  function scoreBlock(value, small) {
    var block = textEl('span', 'score-block');
    block.setAttribute('aria-hidden', 'true');
    block.appendChild(textEl('span', 'score-block__label', 'Metascore'));
    block.appendChild(scoreTile(value, small));
    return block;
  }

  function ignChip(value) {
    var chip = textEl('span', 'chip chip--ign', 'IGN ' + (value % 1 === 0 ? String(value) : value.toFixed(1)));
    chip.title = 'IGN ' + value + '/10';
    return chip;
  }

  function platformChip(label) {
    return textEl('span', 'chip chip--plat', label);
  }

  function genreChip(label) {
    return textEl('span', 'chip chip--genre', label);
  }

  function thumbBlock(game, modifier) {
    var box = textEl('div', 'thumb' + (modifier ? ' ' + modifier : ''));
    if (game.coverPortrait) box.classList.add('thumb--portrait');
    box.appendChild(textEl('span', 'thumb__initials', initials(game)));
    if (!game.cover) {
      box.classList.add('thumb--fallback');
      return box;
    }
    var img = new Image();
    img.className = 'thumb__img';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', function () { box.classList.add('thumb--loaded'); }, { once: true });
    img.addEventListener('error', function () {
      img.remove();
      box.classList.remove('thumb--loaded');
      box.classList.add('thumb--fallback');
    }, { once: true });
    img.src = game.cover;
    box.appendChild(img);
    return box;
  }

  function namesBlock(game, enClass, zhClass) {
    var names = textEl('span', 'names');
    names.appendChild(textEl('span', enClass, game.missing ? '已下架/未知游戏' : game.name));
    if (game.nameZh && game.nameZh !== game.name) {
      names.appendChild(textEl('span', zhClass, game.nameZh));
    }
    return names;
  }

  /* --------------------------------------------------------- suggestion list */

  function optionId(index) {
    return 'sug-opt-' + index;
  }

  function suggestionRow(item, index) {
    var row = document.createElement('div');
    row.className = 'sug';
    row.id = optionId(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.index = String(index);

    if (item.type === 'create') {
      row.classList.add('sug--create');
      var addThumb = textEl('div', 'thumb thumb--add');
      addThumb.appendChild(icon('plus'));
      row.appendChild(addThumb);
      var createBody = textEl('div', 'sug__body');
      createBody.appendChild(textEl('span', 'sug__name', '没有找到「' + item.query + '」· 添加为自定义游戏'));
      createBody.appendChild(textEl('span', 'sug__meta', '手动填写名称、评分与年份'));
      row.appendChild(createBody);
      return row;
    }

    var game = item.game;
    row.appendChild(thumbBlock(game, 'thumb--sug'));

    var body = textEl('div', 'sug__body');
    body.appendChild(namesBlock(game, 'sug__name', 'sug__zh'));

    var meta = textEl('div', 'sug__meta');
    if (game.year) meta.appendChild(textEl('span', 'meta-item', game.year + ' 年'));

    var platforms = game.platforms.slice(0, 3);
    for (var i = 0; i < platforms.length; i++) meta.appendChild(platformChip(platforms[i]));
    if (game.platforms.length > 3) meta.appendChild(textEl('span', 'meta-item', '+' + (game.platforms.length - 3)));

    if (game.genres.length) {
      var genreList = game.genres.slice(0, 2);
      for (var g = 0; g < genreList.length; g++) meta.appendChild(genreChip(genreList[g]));
    }

    if (!meta.childNodes.length) {
      meta.appendChild(textEl('span', 'meta-item', game.custom ? '自定义游戏' : '暂无详细信息'));
    }
    body.appendChild(meta);
    row.appendChild(body);

    var scores = textEl('div', 'sug__scores');
    if (game.mc !== null) {
      scores.appendChild(scoreBlock(game.mc, true));
      scores.appendChild(srText('Metascore ' + game.mc));
    }
    if (game.ign !== null) scores.appendChild(ignChip(game.ign));
    if (state.ranking.some(function (entry) { return entry.key === game.key; })) {
      scores.appendChild(textEl('span', 'badge', '已加入'));
    }
    if (scores.childNodes.length) row.appendChild(scores);
    return row;
  }

  function setStatus(message) {
    if (els.status) els.status.textContent = message;
  }

  function openList() {
    if (state.open) return;
    state.open = true;
    if (els.list) els.list.hidden = false;
    els.input.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('combo-open');
  }

  function closeList() {
    if (!state.open) return;
    state.open = false;
    state.active = -1;
    if (els.list) els.list.hidden = true;
    els.input.setAttribute('aria-expanded', 'false');
    els.input.removeAttribute('aria-activedescendant');
    document.documentElement.classList.remove('combo-open');
  }

  function comboHead() {
    var head = textEl('div', 'combo__head');
    head.setAttribute('role', 'presentation');
    head.appendChild(textEl('span', 'combo__head-title',
      '热门 Top ' + Math.min(HOT_SUGGESTIONS, state.library.length)));
    head.appendChild(textEl('span', 'combo__head-count', '库内共 ' + state.library.length + ' 款'));
    return head;
  }

  function comboFooter() {
    var foot = textEl('div', 'combo__foot');
    foot.setAttribute('role', 'presentation');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'combo__more';
    button.textContent = '浏览全部 ' + state.library.length + ' 款游戏';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
      openBrowse();
    });
    foot.appendChild(button);
    return foot;
  }

  function renderSuggestions() {
    if (!els.list) return;
    var items = buildSuggestions(els.input.value);
    state.suggestions = items;
    state.active = -1;
    els.list.textContent = '';
    els.list.scrollTop = 0;
    els.input.removeAttribute('aria-activedescendant');

    if (!items.length) {
      openList();
      els.list.appendChild(textEl('div', 'combo__hint', '游戏库为空，输入名称即可添加自定义游戏。'));
      setStatus('没有可选游戏');
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) frag.appendChild(suggestionRow(items[i], i));
    var emptyQuery = els.input.value.trim() === '';
    if (emptyQuery) els.list.appendChild(comboHead());
    els.list.appendChild(frag);
    if (emptyQuery) els.list.appendChild(comboFooter());
    openList();

    var games = items.filter(function (item) { return item.type === 'game'; }).length;
    setStatus(games ? games + ' 个结果' : '没有找到匹配，可按回车添加自定义游戏');
  }

  function setActive(index) {
    var rows = els.list ? els.list.querySelectorAll('[role="option"]') : [];
    if (!rows.length) {
      state.active = -1;
      els.input.removeAttribute('aria-activedescendant');
      return;
    }
    if (index < 0) index = rows.length - 1;
    if (index >= rows.length) index = 0;
    state.active = index;
    for (var i = 0; i < rows.length; i++) {
      var on = i === index;
      rows[i].classList.toggle('is-active', on);
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    els.input.setAttribute('aria-activedescendant', rows[index].id);
    var row = rows[index];
    var top = row.offsetTop;
    var bottom = top + row.offsetHeight;
    if (top < els.list.scrollTop) els.list.scrollTop = top;
    else if (bottom > els.list.scrollTop + els.list.clientHeight) els.list.scrollTop = bottom - els.list.clientHeight;
  }

  function activate(index) {
    var item = state.suggestions[index];
    if (!item) return;
    if (item.type === 'create') {
      closeList();
      openCustomDialog(item.query);
      return;
    }
    addGame(item.game);
  }

  function scheduleSearch(immediate) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (state.composing) return;
      renderSuggestions();
    }, immediate ? 0 : SEARCH_DEBOUNCE);
  }

  function syncClearButton() {
    if (!els.clearInput) return;
    els.clearInput.hidden = els.input.value === '';
  }

  /* ------------------------------------------------------------- ranking ops */

  function addGame(game) {
    var existing = -1;
    for (var i = 0; i < state.ranking.length; i++) {
      if (state.ranking[i].key === game.key) { existing = i; break; }
    }
    if (existing >= 0) {
      toast('「' + gameLabel(game) + '」已在榜单中');
      flashRow(game.key);
      closeList();
      els.input.value = '';
      syncClearButton();
      return;
    }
    state.ranking.push({ key: game.key, custom: !!game.custom });
    persistRanking();
    renderRanking();
    closeList();
    els.input.value = '';
    syncClearButton();
    toast('已添加「' + gameLabel(game) + '」· 第 ' + state.ranking.length + ' 位');
  }

  function flashRow(key) {
    var rows = els.listRanking ? els.listRanking.children : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.key !== key) continue;
      var row = rows[i];
      row.classList.add('is-flash');
      if (typeof row.scrollIntoView === 'function') {
        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { row.scrollIntoView(); }
      }
      setTimeout(function () { row.classList.remove('is-flash'); }, 900);
      return;
    }
  }

  function removeAt(index) {
    var item = state.ranking[index];
    if (!item) return;
    var game = entryFor(item.key);
    state.ranking.splice(index, 1);
    persistRanking();
    renderRanking();
    toast('已移除「' + gameLabel(game) + '」', {
      label: '撤销',
      run: function () {
        state.ranking.splice(Math.min(index, state.ranking.length), 0, item);
        persistRanking();
        renderRanking();
      }
    });
  }

  function moveBy(index, direction) {
    var to = index + direction;
    if (to < 0 || to >= state.ranking.length) return;
    var moved = state.ranking.splice(index, 1)[0];
    state.ranking.splice(to, 0, moved);
    persistRanking();
    pendingFocus = { key: moved.key, act: direction < 0 ? 'up' : 'down' };
    renderRanking();
  }

  function clearRanking() {
    if (!state.ranking.length) { toast('榜单已经是空的'); return; }
    if (!window.confirm('确定清空整个排行？共 ' + state.ranking.length + ' 款游戏。')) return;
    var previous = state.ranking.slice();
    state.ranking = [];
    persistRanking();
    renderRanking();
    toast('已清空榜单', {
      label: '撤销',
      run: function () {
        state.ranking = previous;
        persistRanking();
        renderRanking();
      }
    });
  }

  /* ---------------------------------------------------------------- ranking */

  function actionButton(act, label, iconName, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn' + (act === 'remove' ? ' icon-btn--danger' : '');
    button.dataset.act = act;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = !!disabled;
    button.appendChild(icon(iconName));
    return button;
  }

  function rankRow(item, index) {
    var game = entryFor(item.key);
    var label = gameLabel(game);
    var last = state.ranking.length - 1;

    var li = document.createElement('li');
    li.className = 'rank-row' + (game.missing ? ' is-missing' : '');
    li.dataset.key = item.key;
    li.dataset.index = String(index);
    li.tabIndex = -1;

    var handle = textEl('span', 'rank-row__handle');
    handle.setAttribute('aria-hidden', 'true');
    handle.title = '拖动调整顺序';
    handle.appendChild(icon('grip'));
    li.appendChild(handle);

    li.appendChild(textEl('span', 'rank-row__pos', String(index + 1)));

    var art = thumbBlock(game, 'thumb--row');
    li.appendChild(art);

    var body = textEl('div', 'rank-row__body');
    var nameLine = textEl('p', 'rank-row__name');
    nameLine.appendChild(namesBlock(game, 'rank-row__en', 'rank-row__zh'));
    body.appendChild(nameLine);

    var meta = textEl('div', 'rank-row__meta');
    if (game.year) meta.appendChild(textEl('span', 'meta-item', game.year + ' 年'));
    var maxPlatforms = 3;
    for (var p = 0; p < Math.min(game.platforms.length, maxPlatforms); p++) meta.appendChild(platformChip(game.platforms[p]));
    if (game.platforms.length > maxPlatforms) {
      meta.appendChild(textEl('span', 'meta-item', '+' + (game.platforms.length - maxPlatforms)));
    }
    if (game.genres.length) {
      var genreList = game.genres.slice(0, 2);
      for (var g = 0; g < genreList.length; g++) meta.appendChild(genreChip(genreList[g]));
    }
    if (game.custom) meta.appendChild(textEl('span', 'badge badge--custom', '自定义'));
    if (game.missing) meta.appendChild(textEl('span', 'badge badge--warn', '已从游戏库移除'));
    body.appendChild(meta);
    li.appendChild(body);

    var scores = textEl('div', 'rank-row__scores');
    if (game.mc !== null) {
      scores.appendChild(scoreBlock(game.mc, false));
      scores.appendChild(srText('Metascore ' + game.mc));
      if (game.ign !== null) scores.appendChild(ignChip(game.ign));
    } else if (game.ign !== null) {
      scores.appendChild(ignChip(game.ign));
    } else {
      scores.classList.add('is-empty');
      scores.appendChild(srText('暂无评分'));
    }
    li.appendChild(scores);

    var actions = textEl('div', 'rank-row__actions');
    actions.appendChild(actionButton('up', '上移「' + label + '」', 'up', index === 0));
    actions.appendChild(actionButton('down', '下移「' + label + '」', 'down', index === last));
    actions.appendChild(actionButton('remove', '从榜单移除「' + label + '」', 'trash', false));
    li.appendChild(actions);

    return li;
  }

  function restoreFocus() {
    var target = pendingFocus;
    pendingFocus = null;
    if (!target || !els.listRanking) return;
    var rows = els.listRanking.children;
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.key === target.key) { row = rows[i]; break; }
    }
    if (!row) return;
    var order = [target.act, target.act === 'up' ? 'down' : 'up', 'remove'];
    for (var k = 0; k < order.length; k++) {
      var button = row.querySelector('button[data-act="' + order[k] + '"]');
      if (button && !button.disabled) { button.focus(); return; }
    }
    row.focus();
  }

  function renderRanking() {
    if (!els.listRanking) return;
    els.listRanking.textContent = '';

    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.ranking.length; i++) {
      frag.appendChild(rankRow(state.ranking[i], i));
    }
    els.listRanking.appendChild(frag);

    var count = state.ranking.length;
    if (els.countPill) els.countPill.textContent = String(count);
    if (els.countSr) els.countSr.textContent = '共 ' + count + ' 款游戏';
    if (els.empty) els.empty.hidden = count > 0;
    els.listRanking.hidden = count === 0;
    if (els.shareBtn) els.shareBtn.disabled = count === 0;
    if (els.exportBtn) els.exportBtn.disabled = count === 0;
    if (els.clearRankBtn) els.clearRankBtn.disabled = count === 0;

    renderHotChips();
    restoreFocus();
    if (state.open) renderSuggestions();
  }

  function renderHotChips() {
    if (!els.hotChips) return;
    els.hotChips.textContent = '';
    var ranked = new Set(state.ranking.map(function (item) { return item.key; }));
    var picks = state.library.filter(function (game) { return !ranked.has(game.key); }).slice(0, QUICK_CHIPS);

    if (!picks.length) {
      els.hotChips.appendChild(textEl('p', 'chips__empty', '暂时没有可快速添加的游戏，试试上面的搜索。'));
      return;
    }
    picks.forEach(function (game) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--add';
      chip.dataset.key = game.key;
      chip.appendChild(thumbBlock(game, 'thumb--chip'));
      chip.appendChild(textEl('span', 'chip__text', gameLabel(game)));
      chip.appendChild(textEl('span', 'chip__plus', '+'));
      els.hotChips.appendChild(chip);
    });
  }

  /* ------------------------------------------------------------------- meta */

  var SOURCE_LABELS = {
    'Steam Most Played': 'Steam 热玩榜',
    'Steam Store': 'Steam 商店',
    'Steam': 'Steam',
    'Metacritic': 'Metacritic',
    'IGN': 'IGN'
  };

  function sourceFamily(source) {
    if (/steam/i.test(source)) return 'Steam';
    if (/metacritic/i.test(source)) return 'Metacritic';
    if (/\bign\b/i.test(source)) return 'IGN';
    return SOURCE_LABELS[source] || source;
  }

  function renderMeta() {
    if (!els.provenance) return;
    var meta = (window.GAMES_META && typeof window.GAMES_META === 'object') ? window.GAMES_META : {};
    var sources = Array.isArray(meta.sources) ? meta.sources.filter(function (s) { return typeof s === 'string'; }) : [];
    var families = [];
    for (var i = 0; i < sources.length; i++) {
      var family = sourceFamily(sources[i]);
      if (families.indexOf(family) < 0) families.push(family);
    }
    var parts = [];

    parts.push('数据源: ' + (families.length
      ? families.join(' · ') + (sources.length > families.length ? '（共 ' + sources.length + ' 项）' : '')
      : '本地游戏库'));

    var total = state.library.length;
    parts.push('可用游戏 ' + total + ' 款' + (state.customCount ? '（含自定义 ' + state.customCount + '）' : ''));

    var generated = str(meta.generatedAt);
    var dateMatch = generated.match(/^\d{4}-\d{2}-\d{2}/);
    if (dateMatch) parts.push('更新于 ' + dateMatch[0]);

    els.provenance.textContent = parts.join(' · ');
    els.provenance.title = sources.length ? sources.join('\n') : '';

    if (els.warning) {
      var empty = state.builtinCount === 0 && state.customCount === 0;
      els.warning.hidden = !empty;
      if (empty) {
        els.warning.textContent = '未能读取 data/games.js，游戏库为空。你仍然可以搜索并添加自定义游戏。';
      }
    }

    renderSaveButton();
  }

  /* ------------------------------------------------------------------ toast */

  var toastTimer = 0;

  function hideToast() {
    clearTimeout(toastTimer);
    if (els.toast) els.toast.classList.remove('is-visible');
  }

  function toast(message, action) {
    if (!els.toast) return;
    els.toast.textContent = '';
    els.toast.appendChild(textEl('span', 'toast__text', message));
    if (action) {
      var button = textEl('button', 'toast__action', action.label);
      button.type = 'button';
      button.addEventListener('click', function () {
        hideToast();
        action.run();
      });
      els.toast.appendChild(button);
    }
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 2600);
  }

  /* ---------------------------------------------------------------- dialogs */

  function focusableWithin(root) {
    var selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(selector), function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function trapFocus(dialog) {
    dialog.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog(dialog);
        return;
      }
      if (event.key !== 'Tab') return;
      var items = focusableWithin(dialog);
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function setFieldError(input, errorEl, message) {
    if (!errorEl) return;
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.classList.add('is-invalid');
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
      input.removeAttribute('aria-invalid');
      input.classList.remove('is-invalid');
    }
  }

  function clearCustomErrors() {
    setFieldError(els.cName, document.getElementById('cNameErr'), '');
    setFieldError(els.cZh, document.getElementById('cZhErr'), '');
    setFieldError(els.cScore, document.getElementById('cScoreErr'), '');
    setFieldError(els.cYear, document.getElementById('cYearErr'), '');
  }

  function openCustomDialog(prefill) {
    if (!els.customDialog || !els.cName) return;
    els.cName.value = prefill || '';
    els.cZh.value = '';
    els.cScore.value = '';
    els.cYear.value = '';
    clearCustomErrors();
    openDialog(els.customDialog);
    els.cName.focus();
    try { els.cName.setSelectionRange(els.cName.value.length, els.cName.value.length); } catch (err) { /* ignore */ }
  }

  function submitCustom(event) {
    event.preventDefault();
    clearCustomErrors();

    var name = els.cName.value.trim();
    var nameZh = els.cZh.value.trim();
    var scoreRaw = els.cScore.value.trim();
    var yearRaw = els.cYear.value.trim();
    var problems = [];

    if (!name) {
      setFieldError(els.cName, document.getElementById('cNameErr'), '请填写游戏名称');
      problems.push(els.cName);
    } else if (name.length > 80) {
      setFieldError(els.cName, document.getElementById('cNameErr'), '名称最多 80 个字符');
      problems.push(els.cName);
    }

    var score = null;
    if (scoreRaw !== '') {
      if (!/^\d{1,3}$/.test(scoreRaw) || Number(scoreRaw) > 100) {
        setFieldError(els.cScore, document.getElementById('cScoreErr'), '评分需为 0-100 之间的整数');
        problems.push(els.cScore);
      } else {
        score = Number(scoreRaw);
      }
    }

    var year = null;
    if (yearRaw !== '') {
      if (!/^\d{4}$/.test(yearRaw) || Number(yearRaw) < 1900 || Number(yearRaw) > 2100) {
        setFieldError(els.cYear, document.getElementById('cYearErr'), '年份需为 1900-2100 之间的四位数字');
        problems.push(els.cYear);
      } else {
        year = Number(yearRaw);
      }
    }

    if (problems.length) {
      problems[0].focus();
      return;
    }

    var custom = {
      id: 'custom:' + uuid(),
      name: name,
      nameZh: nameZh,
      aliases: [],
      mc: score,
      ign: null,
      year: year,
      platforms: [],
      genres: [],
      cover: '',
      popularity: 0,
      popDetail: null,
      custom: true,
      createdAt: new Date().toISOString()
    };

    state.customs.push(custom);
    persistCustoms();
    buildLibrary();
    renderMeta();

    state.ranking.push({ key: custom.id, custom: true });
    persistRanking();
    renderRanking();
    closeDialog(els.customDialog);
    toast('已添加自定义游戏「' + (custom.nameZh || custom.name) + '」');
    if (els.input) els.input.focus();
  }

  /* --------------------------------------------------------------- clipboard */

  function copyText(text) {
    var attempt = function () {
      return new Promise(function (resolve) {
        if (!navigator.clipboard || !window.isSecureContext) { resolve(false); return; }
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(false); });
      });
    };
    return attempt().then(function (ok) {
      if (ok) return true;
      try {
        if (typeof document.execCommand !== 'function') return false;
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-2000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, area.value.length);
        var copied = document.execCommand('copy');
        area.remove();
        return copied;
      } catch (err) {
        return false;
      }
    });
  }

  function buildExportText() {
    var save = currentSave();
    var lines = state.ranking.map(function (item, index) {
      var game = entryFor(item.key);
      var name = game.nameZh || game.name || gameLabel(game);
      var score = game.mc === null ? '' : ' ' + game.mc;
      return (index + 1) + '. ' + name + score;
    });
    if (save) lines.unshift('【' + save.name + '】');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ browse */

  var browse = { hits: [], shown: 0 };

  function isInRanking(key) {
    return state.ranking.some(function (entry) { return entry.key === key; });
  }

  function browseMatches(query) {
    var q = query.trim();
    if (!q) return state.library;
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.library.filter(function (game) { return gameScore(game, tokens) > 0; });
  }

  function browseRow(game) {
    var row = document.createElement('div');
    row.className = 'brow';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.key = game.key;
    row.appendChild(thumbBlock(game, 'thumb--brow'));

    var body = textEl('div', 'brow__body');
    body.appendChild(namesBlock(game, 'brow__name', 'brow__zh'));
    var meta = textEl('div', 'brow__meta');
    if (game.year) meta.appendChild(textEl('span', 'meta-item', game.year + ' 年'));
    for (var p = 0; p < Math.min(game.platforms.length, 3); p++) {
      meta.appendChild(platformChip(game.platforms[p]));
    }
    if (game.genres.length) meta.appendChild(genreChip(game.genres[0]));
    if (!meta.childNodes.length) {
      meta.appendChild(textEl('span', 'meta-item', game.custom ? '自定义游戏' : '暂无详细信息'));
    }
    body.appendChild(meta);
    row.appendChild(body);

    var scores = textEl('div', 'brow__scores');
    if (game.mc !== null) scores.appendChild(scoreBlock(game.mc, false));
    if (game.ign !== null) scores.appendChild(ignChip(game.ign));
    var badge = textEl('span', 'brow__badge', '已加入');
    badge.hidden = !isInRanking(game.key);
    scores.appendChild(badge);
    row.appendChild(scores);

    row.classList.toggle('is-added', isInRanking(game.key));
    row.addEventListener('click', function () {
      addGame(game);
      refreshBrowseBadges();
    });
    row.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      row.click();
    });
    return row;
  }

  function refreshBrowseBadges() {
    if (!els.browseList) return;
    var rows = els.browseList.querySelectorAll('.brow');
    for (var i = 0; i < rows.length; i++) {
      var added = isInRanking(rows[i].dataset.key);
      rows[i].classList.toggle('is-added', added);
      var badge = rows[i].querySelector('.brow__badge');
      if (badge) badge.hidden = !added;
    }
  }

  function appendBrowse() {
    var total = browse.hits.length;
    var end = Math.min(total, browse.shown + BROWSE_CHUNK);
    var frag = document.createDocumentFragment();
    for (var i = browse.shown; i < end; i++) frag.appendChild(browseRow(browse.hits[i]));
    els.browseList.appendChild(frag);
    browse.shown = end;

    if (els.browseCount) {
      els.browseCount.textContent = '共 ' + total + ' 款' +
        (end < total ? ' · 已显示 ' + end : '');
    }
    if (els.browseMoreBtn) {
      els.browseMoreBtn.hidden = end >= total;
      els.browseMoreBtn.textContent = '加载更多（还有 ' + (total - end) + ' 款）';
    }
  }

  function renderBrowse(reset) {
    if (!els.browseList) return;
    if (reset) {
      browse.hits = browseMatches(els.browseSearch ? els.browseSearch.value : '');
      browse.shown = 0;
      els.browseList.textContent = '';
      els.browseList.scrollTop = 0;
    }
    appendBrowse();
  }

  function openBrowse() {
    if (!els.browseDialog) return;
    if (els.browseSearch) els.browseSearch.value = '';
    renderBrowse(true);
    openDialog(els.browseDialog);
    if (els.browseSearch) els.browseSearch.focus();
  }

  /* -------------------------------------------------------------- save slots */

  function formatSaveTime(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var d = new Date(t);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderSaveButton() {
    var save = currentSave();
    var name = save ? save.name : '未命名';
    if (els.saveBtnName) els.saveBtnName.textContent = name;
    if (els.boardSaveName) els.boardSaveName.textContent = name;
    if (els.saveBtn) els.saveBtn.title = save ? '当前存档：' + save.name + '（点击切换）' : '存档';
  }

  function saveTool(label, onClick, danger) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'save-tool' + (danger ? ' save-tool--danger' : '');
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderSaveList() {
    if (!els.saveList) return;
    els.saveList.textContent = '';
    var active = state.activeSaveId;

    state.saves.forEach(function (save) {
      var row = textEl('div', 'save-row' + (save.id === active ? ' is-active' : ''));
      row.dataset.id = save.id;

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'save-row__main';
      pick.setAttribute('aria-pressed', save.id === active ? 'true' : 'false');
      var body = textEl('span', 'save-row__body');
      body.appendChild(textEl('span', 'save-row__name', save.name));
      body.appendChild(textEl('span', 'save-row__meta',
        save.ranking.length + ' 款 · 更新 ' + formatSaveTime(save.updatedAt) +
        (save.id === active ? ' · 当前' : '')));
      pick.appendChild(body);
      pick.addEventListener('click', function () { setActiveSave(save.id); });
      row.appendChild(pick);

      var tools = textEl('div', 'save-row__tools');
      tools.appendChild(saveTool('重命名', function () { startRename(row, save); }));
      tools.appendChild(saveTool('复制', function () { duplicateSave(save.id); }));
      tools.appendChild(saveTool('删除', function () { deleteSave(save.id); }, true));
      row.appendChild(tools);

      els.saveList.appendChild(row);
    });
  }

  function startRename(row, save) {
    if (row.querySelector('.save-row__rename')) return;
    var body = row.querySelector('.save-row__body');
    var input = document.createElement('input');
    input.className = 'input save-row__rename';
    input.type = 'text';
    input.maxLength = 40;
    input.value = save.name;
    input.setAttribute('aria-label', '存档名称');
    body.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(keep) {
      if (done) return;
      done = true;
      var next = input.value.trim();
      if (keep && next && next !== save.name) {
        save.name = next.slice(0, 40);
        save.updatedAt = nowIso();
        writeSaves();
        toast('已重命名为「' + save.name + '」');
      }
      renderSaveList();
      renderSaveButton();
      if (keep) {
        var again = els.saveList.querySelector('.save-row[data-id="' + save.id + '"] .save-row__main');
        if (again) again.focus();
      }
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commit(true); }
      else if (event.key === 'Escape') { event.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  function refreshFromSave() {
    state.customs = readCustomsRaw();
    buildLibrary();
    state.ranking = readRanking();
    renderRanking();
    renderMeta();
    renderSaveButton();
    renderSaveList();
    if (els.browseDialog && els.browseDialog.open) renderBrowse(true);
  }

  function setActiveSave(id) {
    if (id === state.activeSaveId || !saveById(id)) return;
    state.activeSaveId = id;
    writeSaves();
    refreshFromSave();
    toast('已切换到存档「' + currentSave().name + '」');
  }

  function createSave(name) {
    var save = normalizeSave({ id: newSaveId(), name: name, ranking: [], customs: [] });
    state.saves.push(save);
    state.activeSaveId = save.id;
    writeSaves();
    refreshFromSave();
    toast('已新建存档「' + save.name + '」');
    return save;
  }

  function duplicateSave(id) {
    var src = saveById(id);
    if (!src) return;
    var copy = normalizeSave({
      id: newSaveId(),
      name: (src.name + ' 副本').slice(0, 40),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ranking: JSON.parse(JSON.stringify(src.ranking)),
      customs: JSON.parse(JSON.stringify(src.customs))
    });
    state.saves.push(copy);
    writeSaves();
    renderSaveList();
    toast('已复制为「' + copy.name + '」');
  }

  function deleteSave(id) {
    if (state.saves.length <= 1) { toast('至少要保留一个存档'); return; }
    var save = saveById(id);
    if (!save) return;
    if (!window.confirm('删除存档「' + save.name + '」？其中的排行无法恢复。')) return;

    var wasActive = id === state.activeSaveId;
    state.saves = state.saves.filter(function (item) { return item.id !== id; });
    if (wasActive) state.activeSaveId = state.saves[0].id;
    writeSaves();
    if (wasActive) refreshFromSave();
    else { renderSaveButton(); renderSaveList(); }
    toast('已删除存档「' + save.name + '」');
  }

  function openSaveDialog() {
    if (!els.saveDialog) return;
    renderSaveList();
    if (els.saveNameInput) els.saveNameInput.value = '';
    setFieldError(els.saveNameInput, els.saveNameErr, '');
    openDialog(els.saveDialog);
    if (els.saveNameInput) els.saveNameInput.focus();
  }

  function submitSaveName(event) {
    event.preventDefault();
    var name = els.saveNameInput ? els.saveNameInput.value.trim() : '';
    if (!name) {
      setFieldError(els.saveNameInput, els.saveNameErr, '给存档起个名字，方便区分');
      return;
    }
    if (state.saves.some(function (item) { return item.name === name; })) {
      setFieldError(els.saveNameInput, els.saveNameErr, '已有同名存档，换个名字');
      return;
    }
    setFieldError(els.saveNameInput, els.saveNameErr, '');
    createSave(name.slice(0, 40));
    els.saveNameInput.value = '';
    els.saveNameInput.focus();
  }

  function openExport(text) {
    if (!els.exportDialog || !els.exportText) return;
    els.exportText.value = text;
    openDialog(els.exportDialog);
    els.exportText.focus();
    try { els.exportText.select(); } catch (err) { /* ignore */ }
  }

  function onShare() {
    if (!state.ranking.length) { toast('榜单还是空的，先加几个游戏吧'); return; }
    var text = buildExportText();
    copyText(text).then(function (ok) {
      if (ok) {
        toast('已复制到剪贴板 · 共 ' + state.ranking.length + ' 款');
      } else {
        openExport(text);
        toast('自动复制被浏览器拦截，请手动复制');
      }
    });
  }

  /* ------------------------------------------------------------------ theme */

  function applyTheme(mode, persist) {
    var theme = mode === 'dark' ? 'dark' : 'light';
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (els.themeBtn) {
      els.themeBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      els.themeBtn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      els.themeBtn.title = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    }
    if (persist) store.set(STORAGE.theme, theme);
  }

  function initTheme() {
    var stored = store.get(STORAGE.theme);
    if (stored !== 'light' && stored !== 'dark') {
      var dark = false;
      try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (err) { dark = false; }
      stored = dark ? 'dark' : 'light';
    }
    applyTheme(stored, false);

    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', function (event) {
          var saved = store.get(STORAGE.theme);
          if (saved === 'light' || saved === 'dark') return;
          applyTheme(event.matches ? 'dark' : 'light', false);
        });
      }
    } catch (err) { /* ignore */ }
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
  }

  /* ------------------------------------------------------------------ drag */

  var drag = {
    active: false,
    index: -1,
    target: -1,
    startDocY: 0,
    lastClientY: 0,
    height: 0,
    rows: [],
    geo: [],
    handle: null,
    pointerId: null,
    moved: false,
    li: null
  };
  var autoScrollRaf = 0;

  function startDrag(event, row, handle) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.isPrimary === false) return;

    var rows = Array.prototype.filter.call(els.listRanking.children, function (el) {
      return el.classList && el.classList.contains('rank-row');
    });
    if (rows.length < 2) return;

    var index = rows.indexOf(row);
    if (index < 0) return;

    event.preventDefault();

    var scrollTop = window.scrollY;
    var geo = rows.map(function (el) {
      var rect = el.getBoundingClientRect();
      return { el: el, top: rect.top + scrollTop, height: rect.height };
    });

    drag.active = true;
    drag.index = index;
    drag.target = index;
    drag.startDocY = event.clientY + scrollTop;
    drag.lastClientY = event.clientY;
    drag.height = geo[index].height;
    drag.rows = rows;
    drag.geo = geo;
    drag.handle = handle;
    drag.pointerId = event.pointerId;
    drag.moved = false;
    drag.li = row;

    row.classList.add('is-dragging');
    row.style.transform = 'translateY(0px)';
    document.body.classList.add('is-dragging');

    try { handle.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragCancel);
    startAutoScroll();
  }

  function applyDrag(clientY) {
    var docY = clientY + window.scrollY;
    var delta = docY - drag.startDocY;
    if (Math.abs(delta) > 3) drag.moved = true;
    drag.li.style.transform = 'translateY(' + delta + 'px)';

    var dragged = drag.geo[drag.index];
    var center = dragged.top + drag.height / 2 + delta;
    var target = 0;
    for (var i = 0; i < drag.geo.length; i++) {
      if (i === drag.index) continue;
      var item = drag.geo[i];
      if (item.top + item.height / 2 < center) target++;
    }
    drag.target = Math.max(0, Math.min(drag.geo.length - 1, target));

    for (var k = 0; k < drag.geo.length; k++) {
      if (k === drag.index) continue;
      var shift = 0;
      if (drag.index < drag.target && k > drag.index && k <= drag.target) shift = -drag.height;
      else if (drag.target < drag.index && k >= drag.target && k < drag.index) shift = drag.height;
      drag.geo[k].el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      drag.geo[k].el.classList.toggle('is-shifted', shift !== 0);
    }
  }

  function onDragMove(event) {
    if (!drag.active) return;
    drag.lastClientY = event.clientY;
    applyDrag(event.clientY);
  }

  function startAutoScroll() {
    if (autoScrollRaf) return;
    var step = function () {
      if (!drag.active) { autoScrollRaf = 0; return; }
      autoScrollRaf = window.requestAnimationFrame(step);
      var edge = 96;
      var y = drag.lastClientY;
      var delta = 0;
      if (y < edge) delta = -Math.min(22, (edge - y) * 0.35);
      else if (y > window.innerHeight - edge) delta = Math.min(22, (y - (window.innerHeight - edge)) * 0.35);
      if (delta) {
        window.scrollBy(0, delta);
        applyDrag(drag.lastClientY);
      }
    };
    autoScrollRaf = window.requestAnimationFrame(step);
  }

  function stopAutoScroll() {
    if (autoScrollRaf) {
      window.cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = 0;
    }
  }

  function cleanupDrag() {
    stopAutoScroll();
    drag.geo.forEach(function (item) {
      item.el.classList.remove('is-shifted');
      item.el.style.transform = '';
    });
    if (drag.li) {
      drag.li.classList.remove('is-dragging');
      drag.li.style.transform = '';
    }
    if (drag.handle) {
      drag.handle.removeEventListener('pointermove', onDragMove);
      drag.handle.removeEventListener('pointerup', onDragEnd);
      drag.handle.removeEventListener('pointercancel', onDragCancel);
      try {
        if (drag.pointerId !== null && drag.handle.hasPointerCapture(drag.pointerId)) {
          drag.handle.releasePointerCapture(drag.pointerId);
        }
      } catch (err) { /* ignore */ }
    }
    document.body.classList.remove('is-dragging');
    drag.active = false;
    drag.handle = null;
    drag.rows = [];
    drag.geo = [];
    drag.li = null;
    drag.pointerId = null;
  }

  function onDragEnd() {
    if (!drag.active) return;
    var from = drag.index;
    var to = drag.target;
    var moved = drag.moved;
    var key = drag.li.dataset.key;

    cleanupDrag();

    if (from !== to) {
      var item = state.ranking.splice(from, 1)[0];
      state.ranking.splice(to, 0, item);
      persistRanking();
      renderRanking();
      toast('「' + gameLabel(entryFor(key)) + '」移到第 ' + (to + 1) + ' 位');
    } else if (moved) {
      renderRanking();
    }
  }

  function onDragCancel() {
    if (!drag.active) return;
    cleanupDrag();
    renderRanking();
  }

  /* ------------------------------------------------------------------ events */

  function bindEvents() {
    els.input.addEventListener('compositionstart', function () {
      state.composing = true;
    });

    els.input.addEventListener('compositionend', function () {
      state.composing = false;
      syncClearButton();
      scheduleSearch(true);   // let the committed text settle, then search
    });

    els.input.addEventListener('input', function (event) {
      syncClearButton();
      if (state.composing || event.isComposing) return;
      scheduleSearch(false);
    });

    els.input.addEventListener('focus', function () {
      if (!state.open && state.library.length) renderSuggestions();
    });

    els.input.addEventListener('keydown', onInputKeyDown);

    els.clearInput.addEventListener('click', function () {
      els.input.value = '';
      syncClearButton();
      els.input.focus();
      renderSuggestions();
    });

    els.list.addEventListener('pointerdown', function (event) {
      if (event.target.closest('.sug')) event.preventDefault();   // keep focus in the input
    });

    els.list.addEventListener('click', function (event) {
      var row = event.target.closest('.sug');
      if (!row) return;
      var index = Number(row.dataset.index);
      if (!isNaN(index)) activate(index);
    });

    els.list.addEventListener('pointermove', function (event) {
      var row = event.target.closest('.sug');
      if (!row) return;
      var index = Number(row.dataset.index);
      if (!isNaN(index) && index !== state.active) setActive(index);
    });

    document.addEventListener('pointerdown', function (event) {
      if (!state.open) return;
      if (els.combo && els.combo.contains(event.target)) return;
      closeList();
    }, true);

    els.listRanking.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-act]');
      if (!button) return;
      var row = button.closest('.rank-row');
      if (!row) return;
      var key = row.dataset.key;
      var index = -1;
      for (var i = 0; i < state.ranking.length; i++) {
        if (state.ranking[i].key === key) { index = i; break; }
      }
      if (index < 0) return;
      if (button.dataset.act === 'remove') removeAt(index);
      else if (button.dataset.act === 'up') moveBy(index, -1);
      else if (button.dataset.act === 'down') moveBy(index, 1);
    });

    els.listRanking.addEventListener('pointerdown', function (event) {
      var handle = event.target.closest('.rank-row__handle');
      if (!handle) return;
      var row = handle.closest('.rank-row');
      if (!row) return;
      startDrag(event, row, handle);
    });

    els.listRanking.addEventListener('dragstart', function (event) {
      event.preventDefault();   // HTML5 drag-and-drop would fight the pointer drag
    });

    els.hotChips.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip--add');
      if (!chip) return;
      var game = state.index.get(chip.dataset.key);
      if (game) addGame(game);
    });

    els.shareBtn.addEventListener('click', onShare);
    els.exportBtn.addEventListener('click', function () {
      if (!state.ranking.length) { toast('榜单还是空的'); return; }
      openExport(buildExportText());
    });
    els.copyExportBtn.addEventListener('click', function () {
      copyText(els.exportText.value).then(function (ok) {
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本');
      });
    });

    if (els.browseSearch) {
      els.browseSearch.addEventListener('input', function () { renderBrowse(true); });
    }
    if (els.browseMoreBtn) {
      els.browseMoreBtn.addEventListener('click', appendBrowse);
    }
    if (els.browseList) {
      els.browseList.addEventListener('scroll', function () {
        if (browse.shown >= browse.hits.length) return;
        var el = els.browseList;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) appendBrowse();
      });
    }
    els.clearRankBtn.addEventListener('click', clearRanking);
    els.themeBtn.addEventListener('click', toggleTheme);

    if (els.saveBtn) els.saveBtn.addEventListener('click', openSaveDialog);
    if (els.saveForm) els.saveForm.addEventListener('submit', submitSaveName);
    if (els.saveNameInput) {
      els.saveNameInput.addEventListener('input', function () {
        setFieldError(els.saveNameInput, els.saveNameErr, '');
      });
    }

    els.customForm.addEventListener('submit', submitCustom);
    [els.cName, els.cZh, els.cScore, els.cYear].forEach(function (input) {
      input.addEventListener('input', function () {
        var errorEl = document.getElementById(input.id + 'Err');
        setFieldError(input, errorEl, '');
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (button) {
      button.addEventListener('click', function () {
        closeDialog(document.getElementById(button.dataset.close));
      });
    });

    [els.customDialog, els.exportDialog, els.browseDialog, els.saveDialog].forEach(function (dialog) {
      if (!dialog) return;
      trapFocus(dialog);
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) closeDialog(dialog);   // backdrop click
      });
      dialog.addEventListener('cancel', function () { clearCustomErrors(); });
      dialog.addEventListener('close', function () { clearCustomErrors(); });
    });

    var touchLike = null;
    try { touchLike = window.matchMedia('(hover: none)'); } catch (err) { touchLike = null; }
    if (touchLike && typeof touchLike.addEventListener === 'function') {
      touchLike.addEventListener('change', function (event) {
        document.documentElement.classList.toggle('no-hover', event.matches);
      });
    }
  }

  function onInputKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;

    var key = event.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!state.open) {
        if (!state.library.length) return;
        renderSuggestions();
      }
      if (!state.suggestions.length) return;
      var total = els.list.querySelectorAll('[role="option"]').length;
      if (!total) return;
      if (state.active < 0) setActive(key === 'ArrowDown' ? 0 : total - 1);
      else setActive(state.active + (key === 'ArrowDown' ? 1 : -1));
      return;
    }

    if (key === 'Home' || key === 'End') {
      if (!state.open || event.ctrlKey || event.metaKey || !els.list) return;
      event.preventDefault();
      setActive(key === 'Home' ? 0 : els.list.querySelectorAll('[role="option"]').length - 1);
      return;
    }

    if (key === 'Enter') {
      if (state.open && state.suggestions.length) {
        event.preventDefault();
        var index = state.active;
        if (index < 0) {
          index = state.suggestions.findIndex(function (item) { return item.type === 'game'; });
          if (index < 0) index = 0;
        }
        activate(index);
      }
      return;
    }

    if (key === 'Escape') {
      if (state.open) {
        event.preventDefault();
        closeList();
        return;
      }
      if (els.input.value !== '') {
        event.preventDefault();
        els.input.value = '';
        syncClearButton();
        setStatus('已清空搜索');
      }
      return;
    }

    if (key === 'Tab') {
      closeList();
    }
  }

  /* -------------------------------------------------------------------- init */

  function init() {
    if (window.__gamerankUiReady) return;
    window.__gamerankUiReady = true;

    cacheDom();
    if (!els.input || !els.list || !els.listRanking) return;

    loadSaveSlots();
    state.customs = readCustomsRaw();
    buildLibrary();
    state.ranking = readRanking();

    try {
      if (window.matchMedia('(hover: none)').matches) document.documentElement.classList.add('no-hover');
    } catch (err) { /* ignore */ }

    initTheme();
    bindEvents();
    renderMeta();
    renderRanking();
    syncClearButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
