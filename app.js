/* GameRank — UI logic.
 * Plain global script (no modules, no build). Reads window.GAMES / window.GAMES_META
 * provided by data/games.js. Works from file:// and from http(s).
 */
(function () {
  'use strict';

  var STORAGE = {
    saves: 'gamerank.saves.v1',          // local save slots (ranking + customs each)
    savesRemote: 'gamerank.realtime.v2', // same-site board cache; local archives stay untouched
    ranking: 'gamerank.ranking.v1',      // legacy single-slot key, migrated once
    custom: 'gamerank.custom.v1',        // legacy single-slot key, migrated once
    theme: 'gamerank.theme.v1',
    nameOrder: 'gamerank.nameOrder.v1',
    view: 'gamerank.view.v1',
    remoteActive: 'gamerank.remoteActive.v1',
    key: 'gamerank.key.v1',
    owner: 'gamerank.owner.v2',
    pending: 'gamerank.pending.v2',
    imports: 'gamerank.imports.v2'
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
    els.nameOrderZh = document.getElementById('nameOrderZh');
    els.nameOrderEn = document.getElementById('nameOrderEn');
    els.viewListBtn = document.getElementById('viewListBtn');
    els.viewGridBtn = document.getElementById('viewGridBtn');
    els.readonlyBanner = document.getElementById('readonlyBanner');
    els.readonlyName = document.getElementById('readonlyName');
    els.cloneBoardBtn = document.getElementById('cloneBoardBtn');
    els.empty = document.getElementById('emptyState');
    els.emptyTitle = els.empty ? els.empty.querySelector('.empty__title') : null;
    els.emptyHint = els.empty ? els.empty.querySelector('.empty__hint') : null;
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
    els.boardSelect = document.getElementById('boardSelect');
    els.newBoardBtn = document.getElementById('newBoardBtn');
    els.renameBoardBtn = document.getElementById('renameBoardBtn');
    els.syncStatus = document.getElementById('syncStatus');
    els.syncRetryBtn = document.getElementById('syncRetryBtn');
    els.syncConflicts = document.getElementById('syncConflicts');
    els.roomHint = document.getElementById('roomHint');
    els.roomCount = document.getElementById('roomCount');
    els.footText = document.getElementById('footText');
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
    nameOrder: 'zh',
    view: 'list',
    builtinCount: 0,
    customCount: 0,
    saves: [],          // [{ id, name, createdAt, updatedAt, ranking, customs }]
    activeSaveId: '',   // id of the slot currently shown
    remoteOn: false,    // retain the shared workspace while temporarily offline
    connected: false,
    live: false,
    connecting: false,
    userId: '',         // public owner id returned by the server
    browserKey: '',     // private editing credential, never put in a board or URL
    readOnly: false,    // viewing someone else's board
    selecting: 0
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

  function gameNames(game) {
    if (!game) return { primary: '未知游戏', secondary: '' };
    if (game.missing) return { primary: '未知游戏 #' + game.key, secondary: '' };
    var english = str(game.name).trim();
    var chinese = str(game.nameZh).trim();
    var primary = state.nameOrder === 'en' ? english || chinese : chinese || english;
    var secondary = state.nameOrder === 'en' ? chinese : english;
    if (secondary === primary) secondary = '';
    return { primary: primary || '游戏 #' + game.key, secondary: secondary };
  }

  function gameLabel(game) {
    return gameNames(game).primary;
  }

  function initials(game) {
    var source = gameLabel(game).trim();
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
      nameZhType: str(raw.nameZhType).trim(),
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
      customs: Array.isArray(raw.customs) ? raw.customs : [],
      remote: raw.remote === true,
      owner: str(raw.owner),
      revision: Number(raw.revision) || 0,
      serverRevision: Number(raw.serverRevision) || Number(raw.revision) || 0,
      loaded: raw.loaded === true,
      count: typeof raw.count === 'number' ? raw.count : (Array.isArray(raw.ranking) ? raw.ranking.length : 0),
      importSourceId: str(raw.importSourceId)
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

  function savesKey() {
    return state.remoteOn ? STORAGE.savesRemote : STORAGE.saves;
  }

  function readSaves(key) {
    var raw = store.get(key || savesKey());
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
    if (!store.set(savesKey(), payload)) warnStorageOnce();
  }

  function currentSave() {
    for (var i = 0; i < state.saves.length; i++) {
      if (state.saves[i].id === state.activeSaveId) return state.saves[i];
    }
    return null;
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

  /* ------------------------------------------------------------ shared board */

  var pendingWrites = Object.create(null);
  var inFlight = Object.create(null);
  var writeTimers = Object.create(null);
  var importedSaves = Object.create(null);
  var eventStream = null;
  var connectPromise = null;
  var retryTimer = 0;
  var refreshPromise = null;
  var refreshAgain = false;
  var queueSequence = 0;
  var mutationVersion = 0;

  function copyData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function boardPayload(save) {
    return {
      name: save.name,
      ranking: normalizeRanking(save.ranking).map(function (item) {
        return item.custom ? { key: item.key, custom: true } : { key: item.key };
      }),
      customs: copyData(save.customs || [])
    };
  }

  function sameBoardContent(a, b) {
    return JSON.stringify(boardPayload(a)) === JSON.stringify(boardPayload(b));
  }

  function ensureBrowserKey() {
    var existing = store.get(STORAGE.key);
    if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return '';
    var bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    var key = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    if (!store.set(STORAGE.key, key)) warnStorageOnce();
    return key;
  }

  function restoreSharedWorkspace() {
    try {
      var imported = JSON.parse(store.get(STORAGE.imports) || '{}');
      if (imported && typeof imported === 'object' && !Array.isArray(imported)) {
        Object.keys(imported).forEach(function (id) { importedSaves[id] = imported[id]; });
      }
    } catch (err) { /* A damaged import index does not change the original archives. */ }
    try {
      var queued = JSON.parse(store.get(STORAGE.pending) || '[]');
      if (Array.isArray(queued)) queued.forEach(function (entry) {
        if (!entry || typeof entry.id !== 'string' || !entry.payload || !entry.payload.name) return;
        entry.seq = ++queueSequence;
        pendingWrites[entry.id] = entry;
      });
    } catch (err) { /* The cached boards still retain their most recent local content. */ }
    var raw = store.get(STORAGE.savesRemote);
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.saves) || !data.saves.length) return;
      var cached = data.saves.map(normalizeSave).filter(Boolean);
      if (!cached.length) return;
      state.remoteOn = true;
      state.userId = store.get(STORAGE.owner) || '';
      state.saves = cached;
      state.activeSaveId = cached.some(function (save) { return save.id === data.activeId; })
        ? data.activeId : cached[0].id;
      Object.keys(pendingWrites).forEach(function (id) {
        var entry = pendingWrites[id];
        var save = saveById(id);
        if (!save) {
          save = normalizeSave(Object.assign({ id: id, remote: true, owner: state.userId, loaded: true }, entry.payload));
          state.saves.push(save);
        }
        Object.assign(save, copyData(entry.payload));
        save.count = save.ranking.length;
      });
    } catch (err) { /* Fall back to the separate local archives. */ }
  }

  function persistPending() {
    if (!store.set(STORAGE.pending, JSON.stringify(Object.keys(pendingWrites).map(function (id) {
      return pendingWrites[id];
    })))) warnStorageOnce();
    writeSaves();
  }

  function apiJson(path, options) {
    var opts = options || {};
    var headers = {};
    if (state.browserKey) headers['X-GameRank-Key'] = state.browserKey;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 12000) : 0;
    return fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (body) {
        var data;
        try { data = JSON.parse(body); } catch (err) {
          var invalid = new Error('这个网址暂时没有连接共享服务');
          invalid.status = res.status;
          throw invalid;
        }
        if (!res.ok) {
          var error = new Error(str(data && data.error) || '暂时无法保存');
          error.status = res.status;
          error.data = data;
          throw error;
        }
        if (!data || typeof data !== 'object') throw new Error('共享服务返回了无效内容');
        return data;
      });
    }).finally(function () { clearTimeout(timeout); });
  }

  function renderBoardChoices() {
    if (!els.boardSelect) return;
    var options = document.createDocumentFragment();
    var groups = [
      { title: state.remoteOn ? '我的榜单' : '本机榜单', mine: true },
      { title: '其他人的榜单', mine: false }
    ];
    groups.forEach(function (group) {
      var saves = state.saves.filter(function (save) { return (!isReadOnlySave(save)) === group.mine; });
      if (!saves.length) return;
      var optgroup = document.createElement('optgroup');
      optgroup.label = group.title;
      saves.forEach(function (save) {
        var option = document.createElement('option');
        option.value = save.id;
        option.textContent = save.name + ' · ' + (group.mine ? (state.remoteOn ? '我的' : '本机') : '其他人的') +
          ' · ' + (save.count || 0) + ' 款' +
          (pendingWrites[save.id] ? ' · 待保存' : '');
        optgroup.appendChild(option);
      });
      options.appendChild(optgroup);
    });
    els.boardSelect.replaceChildren(options);
    els.boardSelect.value = state.activeSaveId;
    var owners = new Set(state.saves.filter(function (save) { return save.owner; }).map(function (save) { return save.owner; }));
    if (els.roomCount) els.roomCount.textContent = state.saves.length + ' 份榜单' +
      (state.remoteOn ? ' · ' + owners.size + ' 位玩家' : '');
    if (els.renameBoardBtn) els.renameBoardBtn.hidden = state.readOnly || !currentSave();
  }

  function updateSyncStatus() {
    var ids = Object.keys(pendingWrites);
    var conflicts = ids.filter(function (id) { return !!pendingWrites[id].conflict; });
    var text;
    if (!state.remoteOn) text = state.connecting ? '正在连接大家的榜单…' : '本地模式 · 服务器未连接';
    else if (conflicts.length) text = conflicts.length + ' 份改动需要确认 · 已保留在本机';
    else if (ids.length) text = state.connected ? '正在保存 · ' + ids.length + ' 份榜单' : '离线重试 · 改动已保留在本机';
    else if (!state.connected) text = '离线重试 · 显示上次保存的榜单';
    else if (!state.live) text = '正在恢复实时连接…';
    else text = '已同步 · 实时更新';
    if (els.syncStatus) {
      els.syncStatus.textContent = text;
      els.syncStatus.dataset.state = conflicts.length ? 'conflict' :
        (!state.connected || (state.remoteOn && !state.live) ? 'offline' : (ids.length ? 'saving' : 'synced'));
    }
    if (els.syncRetryBtn) els.syncRetryBtn.hidden = state.connected && state.live || state.connecting;
    if (els.roomHint) els.roomHint.textContent = state.remoteOn
      ? '其他人打开同一个网址，就能看到这里的榜单。给你的榜单起个容易认出的名字。'
      : '当前只保存在本机。连接共享服务后，你的榜单会自动上传到这个网址。';
    if (els.footText) els.footText.textContent = state.remoteOn
      ? '榜单在这个网址公开可见。此浏览器保管你的编辑权限，改动会自动保存。'
      : '本地模式：改动保存在这个浏览器中，其他人暂时无法看到。';
    renderConflicts();
    renderBoardChoices();
  }

  function renderConflicts() {
    if (!els.syncConflicts) return;
    els.syncConflicts.textContent = '';
    Object.keys(pendingWrites).forEach(function (id) {
      var entry = pendingWrites[id];
      if (!entry.conflict) return;
      var row = textEl('div', 'sync-conflict');
      row.appendChild(textEl('p', '', '「' + entry.payload.name + '」' +
        (entry.conflict.kind === 'revision' ? '在另一处也有修改。你的改动已保留。' : '暂时无法保存，改动已保留。')));
      var actions = textEl('div', 'sync-conflict__actions');
      actions.appendChild(saveTool('将我的改动另存为新榜', function () { resolveConflict(id, true); }));
      if (entry.conflict.board) actions.appendChild(saveTool('采用已同步版本', function () { resolveConflict(id, false); }));
      row.appendChild(actions);
      els.syncConflicts.appendChild(row);
    });
    els.syncConflicts.hidden = !els.syncConflicts.children.length;
  }

  function resolveConflict(id, keepCopy) {
    var entry = pendingWrites[id];
    if (!entry || !entry.conflict) return;
    var payload = copyData(entry.payload);
    var serverBoard = entry.conflict.board;
    delete pendingWrites[id];
    if (serverBoard) {
      var existing = saveById(id);
      if (existing) existing.serverRevision = serverBoard.revision;
      mergeRemoteBoard(serverBoard);
    }
    else state.saves = state.saves.filter(function (save) { return save.id !== id; });
    if (keepCopy) {
      createSharedDraft((payload.name + '（本机副本）').slice(0, 40), payload.ranking, payload.customs, true);
    } else if (state.activeSaveId === id) refreshFromSave();
    persistPending();
    renderSaveList();
    updateSyncStatus();
    flushPending();
    refreshRemoteList();
  }

  function mergeRemoteBoard(board) {
    if (!board || typeof board.id !== 'string') throw new Error('无法读取这份榜单');
    var save = saveById(board.id);
    if (!save) {
      save = normalizeSave(Object.assign({}, board, { remote: true, loaded: true }));
      state.saves.push(save);
    }
    if (!pendingWrites[board.id] && !inFlight[board.id] && Number(board.revision) >= save.revision &&
        Number(board.revision) >= save.serverRevision) {
      Object.assign(save, {
        name: str(board.name), ranking: copyData(board.ranking || []), customs: copyData(board.customs || []),
        count: (board.ranking || []).length, revision: Number(board.revision) || 0,
        serverRevision: Number(board.revision) || 0, updatedAt: board.updatedAt, loaded: true
      });
    }
    save.owner = str(board.owner);
    save.remote = true;
    return save;
  }

  function applyRemoteBoards(boards) {
    var previous = Object.create(null);
    state.saves.forEach(function (save) { previous[save.id] = save; });
    var next = boards.map(function (meta) {
      var save = previous[meta.id] || normalizeSave(Object.assign({}, meta, { remote: true }));
      delete previous[meta.id];
      save.remote = true;
      save.owner = str(meta.owner);
      save.serverRevision = Number(meta.revision) || 0;
      if (!pendingWrites[save.id] && !inFlight[save.id]) {
        save.name = str(meta.name);
        save.count = Number(meta.count) || 0;
        save.updatedAt = meta.updatedAt;
      }
      return save;
    });
    Object.keys(previous).forEach(function (id) {
      if (pendingWrites[id] || inFlight[id]) next.push(previous[id]);
    });
    state.saves = next;
    writeSaves();
  }

  function fetchBoard(id) {
    return apiJson('/boards/' + encodeURIComponent(id)).then(function (data) {
      var save = mergeRemoteBoard(data.board);
      writeSaves();
      return save;
    });
  }

  function remoteOpen(id) {
    var selection = ++state.selecting;
    if (drag.active) onDragCancel();
    hideToast();
    closeList();
    if (els.customDialog && els.customDialog.open) closeDialog(els.customDialog);
    state.activeSaveId = id;
    store.set(STORAGE.remoteActive, id);
    writeSaves();
    refreshFromSave();
    var save = saveById(id);
    if (!state.connected || pendingWrites[id] || (save && save.loaded && save.serverRevision === save.revision)) {
      return Promise.resolve(save);
    }
    return fetchBoard(id).then(function (loaded) {
      if (selection === state.selecting && state.activeSaveId === id) refreshFromSave();
      return loaded;
    });
  }

  function refreshRemoteList() {
    if (!state.connected) return Promise.resolve();
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshAgain = false;
    var activeId = state.activeSaveId;
    var selection = state.selecting;
    var version = mutationVersion;
    refreshPromise = apiJson('/boards').then(function (data) {
      if (!Array.isArray(data.boards)) throw new Error('无法读取大家的榜单');
      if (version !== mutationVersion) { refreshAgain = true; return; }
      applyRemoteBoards(data.boards);
      var active = saveById(activeId);
      if (!active && state.activeSaveId === activeId) {
        var fallback = state.saves.find(function (save) { return !isReadOnlySave(save); }) || state.saves[0];
        if (fallback) return remoteOpen(fallback.id);
        createSharedDraft(defaultBoardName(), [], [], true);
        return;
      }
      if (active && !pendingWrites[activeId] && !inFlight[activeId] &&
          (!active.loaded || active.serverRevision !== active.revision) && !drag.active) {
        return fetchBoard(activeId).then(function () {
          if (state.activeSaveId === activeId && state.selecting === selection) refreshFromSave();
        });
      }
    }).then(function () {
      renderSaveButton();
      renderSaveList();
      updateSyncStatus();
    }).catch(function () { markDisconnected(); }).finally(function () {
      refreshPromise = null;
      if (refreshAgain && state.connected) refreshRemoteList();
    });
    return refreshPromise;
  }

  function scheduleRemotePush(save) {
    var target = save || currentSave();
    if (!state.remoteOn || !target || isReadOnlySave(target)) { updateSyncStatus(); return; }
    var previous = pendingWrites[target.id];
    pendingWrites[target.id] = {
      id: target.id, create: previous ? previous.create : false,
      clientId: previous ? previous.clientId : '',
      revision: previous ? previous.revision : target.revision,
      payload: boardPayload(target), seq: ++queueSequence,
      conflict: previous ? previous.conflict : null,
      importSourceId: target.importSourceId || ''
    };
    target.count = target.ranking.length;
    persistPending();
    clearTimeout(writeTimers[target.id]);
    writeTimers[target.id] = setTimeout(function () { flushBoard(target.id); }, 450);
    updateSyncStatus();
  }

  function flushPending() {
    Object.keys(pendingWrites).forEach(function (id) {
      clearTimeout(writeTimers[id]);
      flushBoard(id);
    });
  }

  function flushBoard(id) {
    var entry = pendingWrites[id];
    if (!state.connected || !entry || entry.conflict || inFlight[id]) return Promise.resolve();
    var sent = copyData(entry);
    var body = copyData(sent.payload);
    if (sent.create) body.clientId = sent.clientId || id;
    else body.revision = sent.revision;
    inFlight[id] = true;
    updateSyncStatus();
    return apiJson(sent.create ? '/boards' : '/boards/' + encodeURIComponent(id), {
      method: sent.create ? 'POST' : 'PUT', body: body
    }).then(function (data) {
      var board = data && data.board;
      if (!board || !board.id || !Array.isArray(board.ranking)) throw new Error('保存结果无效');
      mutationVersion++;
      var latest = pendingWrites[id];
      if (!latest) return;
      var save = saveById(id);
      if (sent.create && board.id !== id) {
        state.saves = state.saves.filter(function (item) { return item.id !== board.id || item === save; });
        if (save) { save.id = board.id; save.revision = board.revision; save.serverRevision = board.revision; }
        delete pendingWrites[id];
        latest.id = board.id;
        latest.create = false;
        pendingWrites[board.id] = latest;
        if (state.activeSaveId === id) {
          state.activeSaveId = board.id;
          store.set(STORAGE.remoteActive, board.id);
        }
      }
      if (sent.importSourceId) {
        importedSaves[sent.importSourceId] = board.id;
        store.set(STORAGE.imports, JSON.stringify(importedSaves));
      }
      if (sent.create && !sameBoardContent(sent.payload, board)) {
        latest.conflict = { kind: 'revision', board: board };
      } else if (latest.seq === sent.seq) {
        delete pendingWrites[board.id];
        delete inFlight[id];
        mergeRemoteBoard(board);
      } else {
        latest.revision = board.revision;
        if (save) {
          save.revision = board.revision;
          save.serverRevision = board.revision;
          save.owner = board.owner;
        }
      }
      if (save) { save.owner = board.owner; save.remote = true; save.loaded = true; }
      persistPending();
      renderSaveButton();
      renderSaveList();
    }).catch(function (error) {
      var latest = pendingWrites[id];
      var returned = error.data && error.data.board;
      if (latest && error.status === 409 && returned &&
          (sameBoardContent(latest.payload, returned) || sameBoardContent(sent.payload, returned))) {
        // The write may have committed before its response was lost during reload.
        if (sameBoardContent(latest.payload, returned)) delete pendingWrites[id];
        else latest.revision = returned.revision;
        var saved = saveById(id);
        if (saved) {
          saved.revision = returned.revision;
          saved.serverRevision = Math.max(saved.serverRevision, returned.revision);
          saved.updatedAt = returned.updatedAt;
        }
        mutationVersion++;
        persistPending();
        renderSaveButton();
        renderSaveList();
        return;
      }
      if (latest && (error.status === 409 || error.status === 403 || error.status === 404 || error.status === 400)) {
        latest.conflict = { kind: error.status === 409 ? 'revision' : 'unavailable',
          board: error.data && error.data.board || null };
        persistPending();
      } else markDisconnected();
    }).finally(function () {
      delete inFlight[id];
      updateSyncStatus();
      var nextId = sent.create && saveById(id) === null
        ? Object.keys(pendingWrites).find(function (key) { return pendingWrites[key].clientId === sent.clientId; }) : id;
      if (nextId && state.connected && pendingWrites[nextId] && !pendingWrites[nextId].conflict) flushBoard(nextId);
    });
  }

  function defaultBoardName() {
    return '玩家' + state.userId.slice(-6).toUpperCase() + '的排行';
  }

  function createSharedDraft(name, ranking, customs, select, importSourceId) {
    var id = importSourceId ? 'import_' + importSourceId : 'draft_' + uuid();
    var existing = saveById(id);
    if (existing) return existing;
    var save = normalizeSave({ id: id, name: name, ranking: copyData(ranking || []),
      customs: copyData(customs || []), owner: state.userId, remote: true, loaded: true,
      importSourceId: importSourceId || '' });
    state.saves.push(save);
    pendingWrites[id] = { id: id, create: true, clientId: importSourceId ? 'local:' + importSourceId : id,
      revision: 0, payload: boardPayload(save), seq: ++queueSequence, conflict: null,
      importSourceId: importSourceId || '' };
    if (select) { state.activeSaveId = id; state.selecting++; refreshFromSave(); }
    persistPending();
    renderSaveList();
    updateSyncStatus();
    flushBoard(id);
    return save;
  }

  function importLocalArchives() {
    var local = readSaves(STORAGE.saves);
    local.saves.forEach(function (save) {
      if (importedSaves[save.id] || (!save.ranking.length && !save.customs.length)) return;
      createSharedDraft(save.name === '我的排行' ? defaultBoardName() : save.name,
        save.ranking, save.customs, false, save.id);
    });
  }

  function markDisconnected() {
    state.connected = false;
    state.live = false;
    if (eventStream) {
      var retired = eventStream;
      eventStream = null;
      retired.close();
    }
    updateSyncStatus();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (retryTimer || !/^https?:$/.test(location.protocol)) return;
    retryTimer = setTimeout(function () { retryTimer = 0; connectSameOrigin(); }, 4000);
  }

  function startEvents() {
    if (eventStream || typeof EventSource !== 'function') return;
    var stream = new EventSource('/api/events');
    eventStream = stream;
    stream.onopen = function () {
      if (eventStream !== stream) return;
      state.connected = true;
      state.live = true;
      clearTimeout(retryTimer);
      retryTimer = 0;
      updateSyncStatus();
      flushPending();
      refreshRemoteList();
    };
    stream.addEventListener('boards', function () {
      if (eventStream === stream) refreshRemoteList();
    });
    stream.onerror = function () {
      if (eventStream === stream) markDisconnected();
    };
  }

  function connectSameOrigin() {
    if (connectPromise) return connectPromise;
    if (!/^https?:$/.test(location.protocol) || !state.browserKey) {
      updateSyncStatus();
      return Promise.resolve(false);
    }
    clearTimeout(retryTimer);
    retryTimer = 0;
    state.connecting = true;
    updateSyncStatus();
    connectPromise = apiJson('/health').then(function (health) {
      if (health.ok !== true || health.open !== true || health.realtime !== true) throw new Error('共享服务尚未连接');
      return apiJson('/me');
    }).then(function (data) {
      if (!data.user || typeof data.user.id !== 'string') throw new Error('无法恢复编辑权限');
      state.userId = data.user.id;
      store.set(STORAGE.owner, state.userId);
      return apiJson('/boards');
    }).then(function (data) {
      if (!Array.isArray(data.boards)) throw new Error('无法读取大家的榜单');
      if (!state.remoteOn) { state.saves = []; state.activeSaveId = ''; }
      state.remoteOn = true;
      state.connected = true;
      applyRemoteBoards(data.boards);
      importLocalArchives();
      var mine = state.saves.find(function (save) { return !isReadOnlySave(save); });
      if (!mine) mine = createSharedDraft(defaultBoardName(), [], [], false);
      var wanted = saveById(state.activeSaveId) || saveById(store.get(STORAGE.remoteActive)) || mine || state.saves[0];
      startEvents();
      flushPending();
      return remoteOpen(wanted.id).then(function () { return true; });
    }).catch(function () {
      markDisconnected();
      return false;
    }).finally(function () {
      state.connecting = false;
      connectPromise = null;
      updateSyncStatus();
    });
    return connectPromise;
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
    if (!save || isReadOnlySave(save)) return;
    save.ranking = state.ranking.map(function (item) {
      return item.custom ? { key: item.key, custom: true } : { key: item.key };
    });
    save.updatedAt = nowIso();
    save.count = save.ranking.length;
    writeSaves();
    scheduleRemotePush();
  }

  function persistCustoms() {
    var save = currentSave();
    if (!save || isReadOnlySave(save)) return;
    save.customs = state.customs;
    save.updatedAt = nowIso();
    writeSaves();
    scheduleRemotePush();
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
    var chip = textEl('span', 'ign-score');
    chip.appendChild(textEl('span', 'ign-score__value', String(value)));
    chip.appendChild(textEl('span', 'ign-score__label', 'IGN'));
    chip.title = 'IGN ' + value + '/10';
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', chip.title);
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
    // Cached images are complete before the listener can fire; mark them loaded
    // now so reusing a row never flashes an empty cover.
    if (img.complete && img.naturalWidth > 0) box.classList.add('thumb--loaded');
    return box;
  }

  function updateNamesBlock(names, game) {
    var labels = gameNames(game);
    var primary = names.querySelector('.names__primary');
    var secondary = names.querySelector('.names__secondary');
    if (primary.textContent !== labels.primary) primary.textContent = labels.primary;
    if (secondary.textContent !== labels.secondary) secondary.textContent = labels.secondary;
    secondary.hidden = !labels.secondary;
    if (game && game.nameZhType === 'reference') {
      names.title = '中文参考译名：' + str(game.nameZh).trim() + '\n英文原名：' + str(game.name).trim();
    } else {
      names.title = labels.primary + (labels.secondary ? '\n' + labels.secondary : '');
    }
  }

  function namesBlock(game, primaryClass, secondaryClass) {
    var names = textEl('span', 'names');
    names.dataset.gameKey = game.key;
    names.appendChild(textEl('span', 'names__primary ' + primaryClass));
    names.appendChild(textEl('span', 'names__secondary ' + secondaryClass));
    updateNamesBlock(names, game);
    return names;
  }

  function applyDisplayControls() {
    if (els.nameOrderZh) els.nameOrderZh.setAttribute('aria-pressed', String(state.nameOrder === 'zh'));
    if (els.nameOrderEn) els.nameOrderEn.setAttribute('aria-pressed', String(state.nameOrder === 'en'));
    if (els.viewListBtn) els.viewListBtn.setAttribute('aria-pressed', String(state.view === 'list'));
    if (els.viewGridBtn) els.viewGridBtn.setAttribute('aria-pressed', String(state.view === 'grid'));
    if (els.listRanking) els.listRanking.classList.toggle('is-grid', state.view === 'grid');
  }

  function setNameOrder(order) {
    if (state.nameOrder === order) return;
    if (drag.active) onDragCancel();
    state.nameOrder = order;
    if (!store.set(STORAGE.nameOrder, order)) warnStorageOnce();
    applyDisplayControls();
    document.querySelectorAll('.names[data-game-key]').forEach(function (names) {
      var game = entryFor(names.dataset.gameKey);
      updateNamesBlock(names, game);
      var row = names.closest('.rank-row, .sug, .brow');
      var fallback = row ? row.querySelector('.thumb__initials') : null;
      if (fallback) fallback.textContent = initials(game);
      if (row && row.classList.contains('brow')) row.setAttribute('aria-label', '添加「' + gameLabel(game) + '」');
    });
    if (els.listRanking) Array.prototype.forEach.call(els.listRanking.children, function (row, index) {
      if (state.ranking[index]) updateRowState(row, state.ranking[index], index);
    });
    if (els.hotChips) els.hotChips.querySelectorAll('.chip--add').forEach(function (chip) {
      var game = entryFor(chip.dataset.key);
      var label = chip.querySelector('.chip__text');
      if (label) label.textContent = gameLabel(game);
      chip.setAttribute('aria-label', '添加「' + gameLabel(game) + '」');
      var fallback = chip.querySelector('.thumb__initials');
      if (fallback) fallback.textContent = initials(game);
    });
    if (els.exportDialog && els.exportDialog.open && els.exportText) els.exportText.value = buildExportText();
    hideToast();
  }

  function setRankingView(view) {
    if (state.view === view) return;
    if (drag.active) onDragCancel();
    state.view = view;
    if (!store.set(STORAGE.view, view)) warnStorageOnce();
    applyDisplayControls();
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
    body.appendChild(namesBlock(game, 'sug__name', 'sug__secondary'));

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
    if (state.readOnly) { toast('这是其他人的榜，只读；先点「复制到我的榜」'); return; }
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
    if (state.readOnly) return;
    var undoSaveId = state.activeSaveId;
    var item = state.ranking[index];
    if (!item) return;
    var game = entryFor(item.key);
    state.ranking.splice(index, 1);
    persistRanking();
    renderRanking();
    toast('已移除「' + gameLabel(game) + '」', {
      label: '撤销',
      run: function () {
        if (state.readOnly || state.activeSaveId !== undoSaveId) return;
        state.ranking.splice(Math.min(index, state.ranking.length), 0, item);
        persistRanking();
        renderRanking();
      }
    });
  }

  function moveBy(index, direction) {
    if (state.readOnly) return;
    var to = index + direction;
    if (to < 0 || to >= state.ranking.length) return;
    var moved = state.ranking.splice(index, 1)[0];
    state.ranking.splice(to, 0, moved);
    persistRanking();
    pendingFocus = { key: moved.key, act: direction < 0 ? 'up' : 'down' };
    renderRanking();
  }

  function clearRanking() {
    if (state.readOnly) { toast('这是其他人的榜，只读'); return; }
    if (!state.ranking.length) { toast('榜单已经是空的'); return; }
    if (!window.confirm('确定清空整个排行？共 ' + state.ranking.length + ' 款游戏。')) return;
    var previous = state.ranking.slice();
    var undoSaveId = state.activeSaveId;
    state.ranking = [];
    persistRanking();
    renderRanking();
    toast('已清空榜单', {
      label: '撤销',
      run: function () {
        if (state.readOnly || state.activeSaveId !== undoSaveId) return;
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
    nameLine.appendChild(namesBlock(game, 'rank-row__primary', 'rank-row__secondary'));
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

  function updateRowState(li, item, index) {
    li.dataset.index = String(index);
    var game = entryFor(item.key);
    var names = li.querySelector('.names');
    if (names) updateNamesBlock(names, game);
    var fallback = li.querySelector('.thumb__initials');
    if (fallback) fallback.textContent = initials(game);
    ['up', 'down', 'remove'].forEach(function (action) {
      var button = li.querySelector('button[data-act="' + action + '"]');
      if (!button) return;
      var label = (action === 'up' ? '上移「' : (action === 'down' ? '下移「' : '从榜单移除「')) + gameLabel(game) + '」';
      button.setAttribute('aria-label', label);
      button.title = label;
    });
    var pos = li.querySelector('.rank-row__pos');
    if (pos) pos.textContent = String(index + 1);
    var up = li.querySelector('button[data-act="up"]');
    var down = li.querySelector('button[data-act="down"]');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === state.ranking.length - 1;
  }

  function renderRanking() {
    if (!els.listRanking) return;
    els.listRanking.classList.toggle('is-grid', state.view === 'grid');

    var existing = new Map();
    var kids = els.listRanking.children;
    for (var c = 0; c < kids.length; c++) {
      var el = kids[c];
      if (el.dataset && el.dataset.key) existing.set(el.dataset.key, el);
    }

    var ordered = [];
    for (var i = 0; i < state.ranking.length; i++) {
      var item = state.ranking[i];
      var li = existing.get(item.key);
      if (li) {
        existing.delete(item.key);
        // A previous drag may have left a transform behind.
        li.classList.remove('is-dragging', 'is-shifted');
        li.style.transform = '';
      } else {
        li = rankRow(item, i);
      }
      updateRowState(li, item, i);
      ordered.push(li);
    }

    existing.forEach(function (node) {
      node.remove();
    });

    // Only move rows whose slot actually changed. Untouched rows keep their
    // <img> elements, so covers are never re-decoded (that was the flicker).
    for (var k = 0; k < ordered.length; k++) {
      var node = ordered[k];
      var at = els.listRanking.children[k];
      if (at !== node) els.listRanking.insertBefore(node, at || null);
    }

    var count = state.ranking.length;
    if (els.countPill) els.countPill.textContent = String(count);
    if (els.countSr) els.countSr.textContent = '共 ' + count + ' 款游戏';
    if (els.empty) els.empty.hidden = count > 0;
    els.listRanking.hidden = count === 0;
    if (els.shareBtn) els.shareBtn.disabled = count === 0;
    if (els.exportBtn) els.exportBtn.disabled = count === 0;
    if (els.clearRankBtn) els.clearRankBtn.disabled = state.readOnly || count === 0;

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
      chip.setAttribute('aria-label', '添加「' + gameLabel(game) + '」');
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
    if (state.readOnly) { toast('复制到我的榜后，就能添加游戏'); return; }
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
    if (state.readOnly) return;
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
    toast('已添加自定义游戏「' + gameLabel(entryFor(custom.id)) + '」');
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
      var name = gameLabel(game);
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
    row.setAttribute('aria-label', '添加「' + gameLabel(game) + '」');
    row.appendChild(thumbBlock(game, 'thumb--brow'));

    var body = textEl('div', 'brow__body');
    body.appendChild(namesBlock(game, 'brow__name', 'brow__secondary'));
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
    if (els.saveList.querySelector('.save-row__rename')) return;
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
      var nameLine = textEl('span', 'save-row__name', save.name);
      var foreign = isReadOnlySave(save);
      if (state.remoteOn) {
        nameLine.appendChild(textEl('span', 'save-row__tag',
          foreign ? '其他人的' : '我的'));
      }
      body.appendChild(nameLine);
      var total = save.count === undefined || save.count === null ? save.ranking.length : save.count;
      body.appendChild(textEl('span', 'save-row__meta',
        total + ' 款 · 更新 ' + formatSaveTime(save.updatedAt) +
        (save.id === active ? ' · 当前' : '')));
      pick.appendChild(body);
      pick.addEventListener('click', function () { setActiveSave(save.id); });
      row.appendChild(pick);

      var tools = textEl('div', 'save-row__tools');
      if (!foreign) tools.appendChild(saveTool('重命名', function () { startRename(row, save); }));
      tools.appendChild(saveTool('复制', function () { duplicateSave(save.id); }));
      if (!foreign) tools.appendChild(saveTool('删除', function () { deleteSave(save.id); }, true));
      row.appendChild(tools);

      els.saveList.appendChild(row);
    });
  }

  function startRename(row, save) {
    if (isReadOnlySave(save) || row.querySelector('.save-row__rename')) return;
    if (save.remote && !save.loaded) {
      if (!state.connected) { toast('恢复连接、读取这份榜单后才能重命名'); return; }
      fetchBoard(save.id).then(function (full) {
        renderSaveList();
        var rows = els.saveList.querySelectorAll('.save-row');
        for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === full.id) { startRename(rows[i], full); break; }
      }).catch(function () { markDisconnected(); });
      return;
    }
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
      input.classList.remove('save-row__rename');
      var next = input.value.trim();
      if (keep && next && next !== save.name) {
        save.name = next.slice(0, 40);
        save.updatedAt = nowIso();
        writeSaves();
        scheduleRemotePush(save);
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

  function isReadOnlySave(save) {
    return !!(save && save.remote && (!state.userId || save.owner !== state.userId));
  }

  function applyReadOnly() {
    var save = currentSave();
    var foreign = isReadOnlySave(save);
    var loading = !!(save && save.remote && !save.loaded);
    state.readOnly = !save || foreign || loading;
    if (els.listRanking) els.listRanking.classList.toggle('is-readonly', state.readOnly);
    if (els.readonlyBanner) els.readonlyBanner.hidden = !save || !foreign;
    if (els.readonlyName) els.readonlyName.textContent = save ? save.name : '';
    if (els.input) {
      els.input.disabled = state.readOnly;
      els.input.placeholder = state.readOnly ? '复制到我的榜后，就能搜索和添加游戏' : '搜索游戏（中/英文）';
    }
    if (els.hotChips) els.hotChips.hidden = state.readOnly;
    if (els.clearRankBtn) els.clearRankBtn.disabled = state.readOnly || !state.ranking.length;
    if (els.emptyTitle) els.emptyTitle.textContent = loading ? '正在读取榜单…' : '榜单还空着';
    if (els.emptyHint) els.emptyHint.textContent = loading ? '连接恢复后会自动显示这份榜单的内容。' :
      (foreign ? '这是其他人的空榜单。你也可以新建一份自己的排行。' : '从下面的热门游戏快速添加，或者在上方搜索。');
    renderBoardChoices();
  }

  function cloneBoard() {
    var save = currentSave();
    if (!save) return;
    duplicateSave(save.id);
  }

  function refreshFromSave() {
    state.customs = readCustomsRaw();
    buildLibrary();
    state.ranking = readRanking();
    applyReadOnly();
    renderRanking();
    renderMeta();
    renderSaveButton();
    renderSaveList();
    updateSyncStatus();
    if (els.browseDialog && els.browseDialog.open) renderBrowse(true);
  }

  function setActiveSave(id) {
    if (id === state.activeSaveId || !saveById(id)) return;
    if (state.remoteOn) {
      remoteOpen(id).catch(function () {
        markDisconnected();
        toast('暂时无法加载，显示本机保留的内容');
      });
      return;
    }
    hideToast();
    if (drag.active) onDragCancel();
    state.activeSaveId = id;
    writeSaves();
    refreshFromSave();
  }

  function createSave(name) {
    if (state.remoteOn) {
      var draft = createSharedDraft(name, [], [], true);
      toast('已新建「' + draft.name + '」，改动会自动保存');
      return draft;
    }
    var save = normalizeSave({ id: newSaveId(), name: name, ranking: [], customs: [] });
    state.saves.push(save);
    state.activeSaveId = save.id;
    writeSaves();
    refreshFromSave();
    toast('已新建「' + save.name + '」');
    return save;
  }

  function duplicateSave(id) {
    var src = saveById(id);
    if (!src) return;
    var load = state.remoteOn && !src.loaded
      ? (state.connected ? fetchBoard(id) : Promise.reject(new Error('这份榜单还没有下载，请恢复连接后再复制')))
      : Promise.resolve(src);
    load.then(function (full) {
      var name = (full.name + ' 副本').slice(0, 40);
      if (state.remoteOn) createSharedDraft(name, full.ranking, full.customs, true);
      else {
        var copy = normalizeSave({ id: newSaveId(), name: name,
          ranking: copyData(full.ranking), customs: copyData(full.customs) });
        state.saves.push(copy);
        state.activeSaveId = copy.id;
        writeSaves();
        refreshFromSave();
      }
      toast('已复制到我的榜「' + name + '」');
    }).catch(function (error) { toast(error.message || '暂时无法复制这份榜单'); });
  }

  function deleteSave(id) {
    var save = saveById(id);
    if (!save || isReadOnlySave(save)) return;
    if (state.saves.length <= 1) { toast('至少要保留一份榜单'); return; }
    if (inFlight[id]) { toast('这份榜单正在保存，请稍后再删除'); return; }
    if (state.remoteOn && pendingWrites[id] && !pendingWrites[id].create) {
      toast('请先同步这份榜单，或处理需要确认的改动');
      return;
    }
    if (state.remoteOn && !state.connected && !pendingWrites[id]) { toast('恢复连接后才能删除已同步的榜单'); return; }
    if (!window.confirm('删除榜单「' + save.name + '」？其中的排行无法恢复。')) return;
    var remove = function () {
      mutationVersion++;
      clearTimeout(writeTimers[id]);
      delete pendingWrites[id];
      state.saves = state.saves.filter(function (item) { return item.id !== id; });
      if (state.activeSaveId === id) {
        var next = state.saves.find(function (item) { return !isReadOnlySave(item); }) || state.saves[0];
        state.activeSaveId = next ? next.id : '';
        state.selecting++;
      }
      persistPending();
      refreshFromSave();
      if (state.remoteOn && state.activeSaveId) remoteOpen(state.activeSaveId).catch(function () { markDisconnected(); });
      toast('已删除「' + save.name + '」');
    };
    if (state.remoteOn && !pendingWrites[id]) {
      apiJson('/boards/' + encodeURIComponent(id), { method: 'DELETE' }).then(remove).catch(function () {
        markDisconnected();
        toast('暂时无法删除，榜单已保留');
      });
    } else remove();
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
    grid: false,
    startDocX: 0,
    startDocY: 0,
    lastClientX: 0,
    lastClientY: 0,
    rows: [],
    geo: [],
    handle: null,
    pointerId: null,
    moved: false,
    li: null
  };
  var autoScrollRaf = 0;

  function startDrag(event, row, handle) {
    if (state.readOnly) return;
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
    var scrollLeft = window.scrollX;
    var geo = rows.map(function (el) {
      var rect = el.getBoundingClientRect();
      return { el: el, left: rect.left + scrollLeft, top: rect.top + scrollTop,
        width: rect.width, height: rect.height };
    });

    drag.active = true;
    drag.index = index;
    drag.target = index;
    drag.grid = state.view === 'grid';
    drag.startDocX = event.clientX + scrollLeft;
    drag.startDocY = event.clientY + scrollTop;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    drag.rows = rows;
    drag.geo = geo;
    drag.handle = handle;
    drag.pointerId = event.pointerId;
    drag.moved = false;
    drag.li = row;

    row.classList.add('is-dragging');
    row.style.transform = 'translate3d(0, 0, 0)';
    document.body.classList.add('is-dragging');

    try { handle.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragCancel);
    handle.addEventListener('lostpointercapture', onDragCancel);
    startAutoScroll();
  }

  function dragTarget(geometry, from, centerX, centerY, grid) {
    if (grid) {
      var nearest = from;
      var distance = Infinity;
      geometry.forEach(function (item, index) {
        var dx = item.left + item.width / 2 - centerX;
        var dy = item.top + item.height / 2 - centerY;
        var candidate = dx * dx + dy * dy;
        if (candidate < distance) { distance = candidate; nearest = index; }
      });
      return nearest;
    }
    var target = 0;
    for (var i = 0; i < geometry.length; i++) {
      if (i !== from && geometry[i].top + geometry[i].height / 2 < centerY) target++;
    }
    return Math.max(0, Math.min(geometry.length - 1, target));
  }

  function applyDrag(clientX, clientY) {
    var deltaX = drag.grid ? clientX + window.scrollX - drag.startDocX : 0;
    var deltaY = clientY + window.scrollY - drag.startDocY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true;
    drag.li.style.transform = 'translate3d(' + deltaX + 'px, ' + deltaY + 'px, 0)';

    var dragged = drag.geo[drag.index];
    drag.target = dragTarget(drag.geo, drag.index,
      dragged.left + dragged.width / 2 + deltaX, dragged.top + dragged.height / 2 + deltaY, drag.grid);

    var listGap = drag.geo.length > 1 ? Math.max(0, drag.geo[1].top - drag.geo[0].top - drag.geo[0].height) : 0;
    for (var k = 0; k < drag.geo.length; k++) {
      if (k === drag.index) continue;
      var slot = k;
      if (drag.index < drag.target && k > drag.index && k <= drag.target) slot = k - 1;
      else if (drag.target < drag.index && k >= drag.target && k < drag.index) slot = k + 1;
      var dx = drag.geo[slot].left - drag.geo[k].left;
      var dy = drag.geo[slot].top - drag.geo[k].top;
      if (!drag.grid && slot !== k) {
        dx = 0;
        dy = (slot < k ? -1 : 1) * (dragged.height + listGap);
      }
      drag.geo[k].el.style.transform = slot !== k ? 'translate3d(' + dx + 'px, ' + dy + 'px, 0)' : '';
      drag.geo[k].el.classList.toggle('is-shifted', slot !== k);
    }
  }

  function onDragMove(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    applyDrag(event.clientX, event.clientY);
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
        applyDrag(drag.lastClientX, drag.lastClientY);
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
      drag.handle.removeEventListener('lostpointercapture', onDragCancel);
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

  function onDragEnd(event) {
    if (!drag.active || (event && event.pointerId !== drag.pointerId)) return;
    var from = drag.index;
    var to = drag.target;
    var moved = drag.moved;
    var key = drag.li.dataset.key;

    cleanupDrag();

    if (from !== to && !state.readOnly) {
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
    if (els.nameOrderZh) els.nameOrderZh.addEventListener('click', function () { setNameOrder('zh'); });
    if (els.nameOrderEn) els.nameOrderEn.addEventListener('click', function () { setNameOrder('en'); });
    if (els.viewListBtn) els.viewListBtn.addEventListener('click', function () { setRankingView('list'); });
    if (els.viewGridBtn) els.viewGridBtn.addEventListener('click', function () { setRankingView('grid'); });
    window.addEventListener('resize', function () { if (drag.active) onDragCancel(); });

    if (els.saveBtn) els.saveBtn.addEventListener('click', openSaveDialog);
    if (els.saveForm) els.saveForm.addEventListener('submit', submitSaveName);
    if (els.boardSelect) els.boardSelect.addEventListener('change', function () { setActiveSave(els.boardSelect.value); });
    if (els.newBoardBtn) els.newBoardBtn.addEventListener('click', openSaveDialog);
    if (els.renameBoardBtn) els.renameBoardBtn.addEventListener('click', function () {
      var save = currentSave();
      if (!save || isReadOnlySave(save)) return;
      openSaveDialog();
      var rows = els.saveList.querySelectorAll('.save-row');
      for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === save.id) { startRename(rows[i], save); break; }
    });
    if (els.syncRetryBtn) els.syncRetryBtn.addEventListener('click', function () { connectSameOrigin(); });
    window.addEventListener('online', function () { connectSameOrigin(); });
    window.addEventListener('offline', markDisconnected);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (state.connected) { flushPending(); refreshRemoteList(); }
      else connectSameOrigin();
    });
    if (els.cloneBoardBtn) els.cloneBoardBtn.addEventListener('click', cloneBoard);
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

    state.browserKey = ensureBrowserKey();
    state.nameOrder = store.get(STORAGE.nameOrder) === 'en' ? 'en' : 'zh';
    state.view = store.get(STORAGE.view) === 'grid' ? 'grid' : 'list';
    applyDisplayControls();
    loadSaveSlots();
    restoreSharedWorkspace();
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

    refreshFromSave();
    connectSameOrigin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
