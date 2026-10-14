/******************************************************
 * 鉄道の旅（tetsudo-no-tabi）フロントエンド  app.js
 * GitHub Pages / Vanilla JS SPA
 ******************************************************/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const APP_VERSION = CFG.APP_VERSION || '0.1.0';
  const POLL_MS = CFG.POLL_MS || 3000;
  const LS = { session: 'tnt_session', sound: 'tnt_sound', helpSeen: 'tnt_help_seen' };
  const NS = 'http://www.w3.org/2000/svg';
  // この画面が前提とするサーバー（GAS）の最低バージョン
  const MIN_SERVER_VERSION = '0.2.1';
  // 更新履歴（新しい順）。server はその版で必要になったサーバーのバージョン
  const CHANGELOG = [
    { ver: '0.2.3', date: '2026-10-15', server: '0.2.1', items: ['バージョン情報と更新履歴を見られるようにしました'] },
    { ver: '0.2.2', date: '2026-10-15', server: '0.2.1', items: ['遊び方の解説を追加しました（上部の「？」から開けます）'] },
    { ver: '0.2.1', date: '2026-10-15', server: '0.2.1', items: ['ナレーション音声の冒頭で、読み上げの指示文まで読まれてしまう不具合を直しました'] },
    { ver: '0.2.0', date: '2026-10-14', server: '0.2.0', items: ['1手の制限時間を追加しました（時間切れでCPUが代行）', '操作のない状態が続くとCPUが代わりに遊ぶ「代行」を追加しました'] },
    { ver: '0.1.0', date: '2026-10-14', server: '0.1.0', items: ['最初の公開版（オンライン対戦・CPU・会員登録・開通ナレーション）'] }
  ];
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CARD = {
    red: { name: '赤', hex: '#d23c3c' },
    orange: { name: '橙', hex: '#ee8a2a' },
    yellow: { name: '黄', hex: '#f0c330' },
    green: { name: '緑', hex: '#3f9a50' },
    blue: { name: '青', hex: '#2f6fd0' },
    purple: { name: '紫', hex: '#8b50bf' },
    black: { name: '黒', hex: '#30343b' },
    white: { name: '白', hex: '#f7f7f5' },
    loco: { name: '機関車', hex: '#888' },
    gray: { name: '灰（好きな1色）', hex: '#9aa3ab' }
  };
  const CARD_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white'];
  const HAND_ORDER = CARD_COLORS.concat(['loco']);
  const PIECE = { red: '#c62f2f', blue: '#2457b3', green: '#2b8a3e', yellow: '#e0a800', black: '#39404a' };
  const ROUTE_POINTS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 10, 6: 15 };
  const STATUS_LABEL = { waiting: '参加者募集中', setup: '目的地選び中', playing: '進行中', finalRound: '最終ラウンド', ended: '終了' };
  const TYPE_LABEL = { normal: '', tunnel: '海底トンネル', ferry: '航路' };
  const LABEL_POS = { TYO: 'right', KOB: 'above', OKY: 'left', MRK: 'right', SND: 'right', HKD: 'left', MTE: 'above', FUK: 'above', NGT: 'above', KNZ: 'above', KYO: 'above', NGN: 'above' };
  const ISLANDS = [['北海道', 690, 130], ['本州', 650, 470], ['四国', 250, 1080], ['九州', 40, 1190]];
  const BASE_VB = { x: 0, y: 0, w: 1000, h: 1200 };

  const S = {
    session: localStorage.getItem(LS.session) || '',
    user: null,
    map: null,
    cityIdx: {},
    routeIdx: {},
    game: null,
    gameId: null,
    version: null,
    lastEventSeq: null,
    pollTimer: null,
    polling: false,
    busy: false,
    view: null,
    prevView: 'lobby',
    pendingGame: null,
    boardBuilt: false,
    routeEls: {},
    cityEls: {},
    vb: Object.assign({}, BASE_VB),
    selectedRoute: null,
    payOpts: [],
    destKey: null,
    destPick: new Set(),
    resultShown: false,
    soundOn: localStorage.getItem(LS.sound) !== 'off',
    fx: { running: false, abort: false, waiters: [], source: null, typer: null },
    serverVersion: '',
    clockOffset: 0,
    clockTimer: null,
    turnText: '',
    turnMine: false
  };
  const TIMEOUT_CHOICES = [[60, '1分'], [90, '1分30秒'], [180, '3分'], [300, '5分'], [0, 'なし']];

  /* =========================================================
   * 小さなヘルパー
   * ========================================================= */
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sv(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function city(id) { return S.cityIdx[id]; }
  function route(id) { return S.routeIdx[id]; }
  function routeLabel(id) { const r = route(id); return r ? city(r.a).name + '–' + city(r.b).name : id; }
  function me() { return S.user ? S.user.userId : null; }
  function player(pid) { return S.game ? S.game.players.filter(function (p) { return p.playerId === pid; })[0] : null; }
  function playerName(pid) { const p = player(pid); return p ? p.name : 'プレイヤー'; }
  function inPlay() { return S.game && (S.game.status === 'playing' || S.game.status === 'finalRound'); }
  function isMyTurn() { return inPlay() && S.game.currentPlayerId === me(); }
  function handOf() { return S.game && S.game.me ? S.game.me.hand : null; }

  function ApiError(code, message) { this.code = code; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);

  /* =========================================================
   * 通信
   * ========================================================= */
  async function api(action, payload) {
    if (!CFG.GAS_URL || /XXXX/.test(CFG.GAS_URL)) throw new ApiError('NO_CONFIG', 'config.js の GAS_URL を設定してください');
    const body = Object.assign({ action: action }, payload || {});
    if (S.session) body.sessionToken = S.session;
    let res;
    try {
      res = await fetch(CFG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError('NETWORK', '通信できませんでした。電波の良い場所でもう一度お試しください');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json) throw new ApiError('BAD_RESPONSE', 'サーバーの応答を読み取れませんでした');
    if (json.appVersion && json.appVersion !== S.serverVersion) { S.serverVersion = json.appVersion; renderVersion(); }
    if (!json.ok) {
      const err = json.error || {};
      if (err.code === 'SESSION_EXPIRED' || err.code === 'NO_SESSION' || err.code === 'NO_USER') {
        clearSession();
        stopPolling();
        showView('auth');
      } else if (err.code === 'MUST_CHANGE_PASSWORD') {
        showChange(true);
      }
      throw new ApiError(err.code || 'ERROR', err.message || 'エラーが発生しました');
    }
    return json;
  }

  async function withBusy(fn) {
    if (S.busy) return;
    S.busy = true;
    document.body.classList.add('busy');
    try {
      await fn();
    } catch (e) {
      if (e && e.message) toast(e.message, 'error');
      if (e && !(e instanceof ApiError)) console.error(e);
    } finally {
      S.busy = false;
      document.body.classList.remove('busy');
      if (S.view === 'game') renderGame();
    }
  }

  function clearSession() {
    S.session = '';
    S.user = null;
    localStorage.removeItem(LS.session);
    $('#menuBtn').hidden = true;
  }

  /* =========================================================
   * 画面切り替え
   * ========================================================= */
  function showView(name) {
    if (S.view && S.view !== 'change') S.prevView = S.view;
    S.view = name;
    ['auth', 'change', 'lobby', 'room', 'game'].forEach(function (v) { $('#view-' + v).hidden = v !== name; });
    $('#turnBadge').hidden = name !== 'game';
    $('#menuBtn').hidden = !S.user || name === 'auth';
    if (name !== 'game') { closeSheet(); $('#destModal').hidden = true; $('#resultModal').hidden = true; }
    window.scrollTo(0, 0);
  }

  function cmpVer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function serverOutdated() {
    return !!S.serverVersion && cmpVer(S.serverVersion, MIN_SERVER_VERSION) < 0;
  }

  function renderVersion() {
    const t = '画面 v' + APP_VERSION + '／サーバー ' + (S.serverVersion ? 'v' + S.serverVersion : '確認中');
    const warn = serverOutdated();
    ['#ver', '#panelVer'].forEach(function (sel) {
      const el = $(sel);
      if (!el) return;
      el.textContent = t + (warn ? '　⚠ サーバーが古い版です' : '');
      el.classList.toggle('warn', warn);
    });
    $('#menuVer').textContent = t;
    if (!$('#versionModal').hidden) renderVersionModal();
  }

  function renderVersionModal() {
    const warn = serverOutdated();
    const latest = CHANGELOG[0];
    $('#versionBody').innerHTML =
      '<table class="help-table ver-table">' +
      '<tr><th>画面（GitHub Pages）</th><td>v' + esc(APP_VERSION) + '</td></tr>' +
      '<tr><th>サーバー（GAS）</th><td>' + (S.serverVersion ? 'v' + esc(S.serverVersion) : '確認できませんでした') + '</td></tr>' +
      '<tr><th>最終更新日</th><td>' + esc(latest.date) + '</td></tr>' +
      '</table>' +
      (warn
        ? '<p class="ver-warn">サーバーが v' + esc(S.serverVersion) + ' のままです。この画面には v' + MIN_SERVER_VERSION + ' 以上が必要です。GASを「新しいバージョン」で再デプロイしてください。</p>'
        : (S.serverVersion ? '<p class="note">画面とサーバーの組み合わせは正常です。</p>' : '')) +
      '<h3 class="ver-h">更新履歴</h3>' +
      '<ol class="changelog" reversed>' + CHANGELOG.map(function (c) {
        return '<li><div class="cl-head"><b>v' + esc(c.ver) + '</b><span>' + esc(c.date) + '</span></div>' +
          '<ul>' + c.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join('') + '</ul></li>';
      }).join('') + '</ol>' +
      '<div class="btn-row"><button class="btn small" data-act="reload-app">最新の状態に読み込み直す</button></div>';
  }

  async function openVersion() {
    closeMenu();
    S.versionReturn = document.activeElement;
    renderVersionModal();
    $('#versionModal').hidden = false;
    $('#versionClose').focus();
    try { await api('ping'); } catch (e) { /* 表示はそのまま */ }
    renderVersionModal();
  }

  function closeVersion() {
    $('#versionModal').hidden = true;
    if (S.versionReturn && S.versionReturn.focus) S.versionReturn.focus();
  }

  function renderSound() {
    $('#soundBtn').setAttribute('aria-pressed', S.soundOn ? 'true' : 'false');
    $('#soundBtn').setAttribute('aria-label', S.soundOn ? 'ナレーション音声：オン' : 'ナレーション音声：オフ');
  }

  /* =========================================================
   * トースト
   * ========================================================= */
  function toast(msg, kind) {
    const box = $('#toasts');
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, kind === 'error' ? 5000 : 3400);
  }

  /* =========================================================
   * 起動・認証
   * ========================================================= */
  async function init() {
    renderVersion();
    renderSound();
    bindEvents();
    S.pendingGame = new URLSearchParams(location.search).get('game');
    api('ping').catch(function () { renderVersion(); });
    if (!S.session) { showView('auth'); return; }
    try {
      const r = await api('me');
      S.user = r.data;
      if (S.user.mustChange) { showChange(true); return; }
      await afterLogin();
    } catch (e) {
      if (e.code !== 'SESSION_EXPIRED' && e.code !== 'NO_SESSION' && e.code !== 'MUST_CHANGE_PASSWORD') toast(e.message, 'error');
      if (S.view !== 'change') showView('auth');
    }
  }

  async function afterLogin() {
    $('#menuUser').textContent = S.user.nickname + ' さん（' + S.user.email + '）';
    $('#nickForm').nickname.value = S.user.nickname;
    await ensureMap();
    if (S.pendingGame) {
      const id = S.pendingGame;
      S.pendingGame = null;
      try {
        const r = await api('joinGame', { gameId: id });
        enterGame(r.state);
        return;
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    await showLobby();
  }

  async function ensureMap() {
    if (S.map) return;
    const r = await api('getMap');
    S.map = r.data.map;
    S.map.cities.forEach(function (c) { S.cityIdx[c.id] = c; });
    S.map.routes.forEach(function (rt) { S.routeIdx[rt.id] = rt; });
  }

  function showChange(forced) {
    showView('change');
    $('#changeNote').textContent = forced
      ? '仮パスワードでログインしました。続けるには新しいパスワードを設定してください。'
      : '新しいパスワードを設定します。';
    $('#cancelChange').hidden = !!forced;
    $('#changeForm').reset();
    $('#changeForm').dataset.forced = forced ? '1' : '';
  }

  async function onLogin(form) {
    const r = await api('login', { email: form.email.value, password: form.password.value });
    S.session = r.data.sessionToken;
    localStorage.setItem(LS.session, S.session);
    S.user = r.data.user;
    form.reset();
    if (S.user.mustChange) {
      showChange(true);
      $('#changeForm').currentPassword.value = '';
      return;
    }
    toast(S.user.nickname + 'さん、ようこそ');
    await afterLogin();
  }

  async function onRegister(form) {
    const r = await api('register', { email: form.email.value, nickname: form.nickname.value });
    const email = form.email.value;
    form.reset();
    toast(r.data.message);
    switchTab('login');
    $('#loginForm').email.value = email;
    $('#loginForm').password.focus();
  }

  async function onReset(form) {
    const r = await api('resetPassword', { email: form.email.value });
    const email = form.email.value;
    form.reset();
    toast(r.data.message);
    switchTab('login');
    $('#loginForm').email.value = email;
  }

  async function onChange(form) {
    if (form.newPassword.value !== form.confirm.value) throw new ApiError('MISMATCH', '確認用のパスワードが一致しません');
    const r = await api('changePassword', { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value });
    S.user = r.data.user;
    form.reset();
    toast('パスワードを変更しました');
    if (form.dataset.forced) await afterLogin();
    else backFromChange();
  }

  function backFromChange() {
    if (S.prevView === 'game' || S.prevView === 'room') showView(S.prevView);
    else showLobby();
  }

  async function onNickname(form) {
    const r = await api('updateNickname', { nickname: form.nickname.value });
    S.user = r.data;
    $('#menuUser').textContent = S.user.nickname + ' さん（' + S.user.email + '）';
    toast('ニックネームを保存しました（次に作る・参加する旅から反映されます）');
  }

  function switchTab(name) {
    $$('.tab').forEach(function (t) {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('[data-tabpanel]').forEach(function (p) { p.hidden = p.dataset.tabpanel !== name; });
  }

  async function logout() {
    try { await api('logout'); } catch (e) { /* セッション切れでも続行 */ }
    stopPolling();
    clearSession();
    S.game = null;
    S.gameId = null;
    history.replaceState(null, '', location.pathname);
    closeMenu();
    showView('auth');
  }

  /* =========================================================
   * ロビー
   * ========================================================= */
  async function showLobby() {
    stopPolling();
    stopFx();
    S.game = null;
    S.gameId = null;
    history.replaceState(null, '', location.pathname);
    showView('lobby');
    $('#lobbyLists').innerHTML = '<p class="empty">旅の一覧を読み込んでいます…</p>';
    try {
      const r = await api('listGames');
      renderLobby(r.data);
    } catch (e) {
      $('#lobbyLists').innerHTML = '<p class="empty">一覧を読み込めませんでした。</p>';
      toast(e.message, 'error');
    }
  }

  function gameRow(g, mine) {
    const names = g.players.map(function (p) { return esc(p.name); }).join('、');
    return '<div class="game-row">' +
      '<div class="game-row-main">' +
      '<div class="game-row-title"><span class="status-chip ' + esc(g.status) + '">' + esc(STATUS_LABEL[g.status] || g.status) + '</span>' + esc(g.title) + '</div>' +
      '<div class="game-row-sub">' + names + '（' + g.players.length + '人）</div>' +
      '</div>' +
      '<button class="btn small' + (mine ? '' : ' primary') + '" data-act="open-game" data-id="' + esc(g.gameId) + '">' + (mine ? '開く' : '参加する') + '</button>' +
      '</div>';
  }

  function renderLobby(data) {
    const mine = data.myGames || [];
    const open = data.openGames || [];
    $('#lobbyLists').innerHTML =
      '<h3 class="list-title">参加中の旅</h3>' +
      (mine.length ? mine.map(function (g) { return gameRow(g, true); }).join('') : '<p class="empty">まだありません。上の「旅をつくる」から始めましょう。</p>') +
      '<h3 class="list-title">参加者を募集中の旅</h3>' +
      (open.length ? open.map(function (g) { return gameRow(g, false); }).join('') : '<p class="empty">募集中の旅はありません。</p>') +
      '<div class="btn-row" style="margin-top:12px"><button class="btn small" data-act="refresh-lobby">一覧を更新</button></div>';
  }

  async function openGame(id) {
    const r = await api('joinGame', { gameId: id });
    enterGame(r.state);
  }

  /* =========================================================
   * ゲームへの出入り・同期
   * ========================================================= */
  function enterGame(state) {
    S.gameId = state.gameId;
    S.game = null;
    S.lastEventSeq = null;
    S.resultShown = false;
    S.destKey = null;
    history.replaceState(null, '', location.pathname + '?game=' + encodeURIComponent(state.gameId));
    applyState(state);
    startPolling();
  }

  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  async function poll() {
    if (!S.gameId || S.busy || S.polling || document.hidden) return;
    if (S.game && S.game.status === 'ended') return;
    S.polling = true;
    const gid = S.gameId;
    try {
      const r = await api('getState', { gameId: gid, clientVersion: S.version });
      if (gid !== S.gameId) return;
      if (r.state) applyState(r.state);
    } catch (e) {
      if (e.code === 'GAME_CLOSED' || e.code === 'NOT_IN_GAME') {
        toast(e.code === 'GAME_CLOSED' ? 'ホストが旅を解散しました' : 'この旅から外れました', 'warn');
        showLobby();
      }
    } finally {
      S.polling = false;
    }
  }

  function applyState(st) {
    if (!st) return;
    if (S.game && S.game.gameId === st.gameId && st.version < S.game.version) return;
    S.game = st;
    S.version = st.version;
    if (st.serverNow) S.clockOffset = st.serverNow - Date.now();
    handleEvents(st);
    if (st.status === 'waiting') {
      if (S.view !== 'room') showView('room');
      renderRoom();
    } else {
      if (S.view !== 'game') {
        showView('game');
        buildBoard();
        fitBoard(false);
        if (!localStorage.getItem(LS.helpSeen)) {
          openHelp();
          toast('遊び方は、いつでも上の「？」から見られます');
        }
      }
      renderGame();
    }
  }

  function handleEvents(st) {
    const events = st.events || [];
    const maxSeq = events.reduce(function (m, e) { return Math.max(m, e.seq); }, 0);
    if (S.lastEventSeq === null) { S.lastEventSeq = maxSeq; return; }
    const fresh = events.filter(function (e) { return e.seq > S.lastEventSeq; });
    S.lastEventSeq = Math.max(S.lastEventSeq, maxSeq);
    let turnToMe = false;
    fresh.forEach(function (e) {
      const mine = e.playerId === me();
      const who = playerName(e.playerId);
      switch (e.type) {
        case 'join': if (!mine) toast(who + 'が参加しました'); break;
        case 'leave': toast('参加者が1人退出しました'); break;
        case 'setup': toast('出発準備です。まず目的地を選びましょう'); break;
        case 'start': toast('出発進行！'); break;
        case 'claim':
          if (!mine) { toast(who + 'が ' + routeLabel(e.routeId) + ' を開通（+' + e.points + '点）'); flashRoute(e.routeId); }
          break;
        case 'destComplete': if (!mine) toast(who + 'が目的地を1つ達成しました'); break;
        case 'destDraw': if (!mine) toast(who + 'が目的地カードを' + e.kept + '枚追加しました'); break;
        case 'finalRound': toast(who + 'の列車コマが残りわずか。全員あと1手番ずつで終了です', 'warn'); break;
        case 'boardFull': toast('敷設できる路線がなくなりました'); break;
        case 'faceUpReset': toast('表の機関車が3枚そろったので、5枚を入れ替えました'); break;
        case 'turn': if (mine) turnToMe = true; break;
        case 'timeout':
          if (e.setup) { if (mine) toast('時間切れのため、目的地を自動で選びました', 'warn'); else toast(who + 'の目的地を自動で選びました'); break; }
          if (mine) toast(e.away ? '操作がない状態が続いたので、CPUが代わりに進めています。戻るときは「自分で操作に戻る」を押してください' : '時間切れのため、CPUが代わりに1手進めました', 'warn');
          else toast(who + 'の番は時間切れのため、自動で進めました');
          break;
        case 'resume': if (!mine) toast(who + 'が操作に戻りました'); break;
        case 'options': if (S.game.hostId !== me()) toast('1手の制限時間が「' + timeoutLabel(e.turnTimeoutSec) + '」になりました'); break;
      }
    });
    if (turnToMe && st.currentPlayerId === me()) {
      toast('あなたの番です', 'turn');
      if (navigator.vibrate) navigator.vibrate(80);
    }
  }

  /* =========================================================
   * 待合室
   * ========================================================= */
  function renderRoom() {
    const g = S.game;
    const host = g.hostId === me();
    const url = location.origin + location.pathname + '?game=' + encodeURIComponent(g.gameId);
    const rows = g.players.map(function (p) {
      const tags = [];
      if (p.playerId === g.hostId) tags.push('ホスト');
      if (p.isCpu) tags.push('CPU');
      if (p.playerId === me()) tags.push('あなた');
      const removable = host && p.playerId !== g.hostId;
      return '<li><span class="pdot" style="background:' + PIECE[p.color] + '"></span>' +
        '<span class="name">' + esc(p.name) + '</span><span class="tag">' + tags.join('・') + '</span>' +
        (removable ? '<button class="btn small ghost" data-act="remove-player" data-id="' + esc(p.playerId) + '">外す</button>' : '') +
        '</li>';
    }).join('');
    const full = g.players.length >= 5;
    $('#view-room').innerHTML =
      '<h2 class="view-title">' + esc(g.title) + '</h2>' +
      '<div class="card">' +
      '<p class="note">ゲームID（友だちに伝えると参加できます）</p>' +
      '<p class="room-id">' + esc(g.gameId) + '</p>' +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn small" data-act="share-room" data-url="' + esc(url) + '">招待リンクを送る</button>' +
      '<button class="btn small" data-act="copy-text" data-text="' + esc(g.gameId) + '">IDをコピー</button>' +
      '</div></div>' +
      '<div class="card">' +
      '<h3 class="list-title" style="margin-top:0">乗客（' + g.players.length + '／5人）</h3>' +
      '<ul class="room-players">' + rows + '</ul>' +
      '<div class="room-option">' +
      (host
        ? '<label>1手の制限時間<select data-change="set-timeout">' + TIMEOUT_CHOICES.map(function (c) {
            return '<option value="' + c[0] + '"' + (c[0] === g.turnTimeoutSec ? ' selected' : '') + '>' + c[1] + '</option>';
          }).join('') + '</select></label>'
        : '<p class="note">1手の制限時間：' + timeoutLabel(g.turnTimeoutSec) + '</p>') +
      '<p class="note">時間を過ぎるとCPUが代わりに1手進めます。2回続くと、戻るまでCPUが代行します。</p>' +
      '</div>' +
      (host
        ? '<div class="btn-row">' +
          '<button class="btn" data-act="add-cpu"' + (full ? ' disabled' : '') + '>CPUを追加</button>' +
          '<button class="btn primary" data-act="start-game"' + (g.players.length < 2 ? ' disabled' : '') + '>出発する</button>' +
          '</div>' +
          (g.players.length < 2 ? '<p class="note" style="margin-top:10px">2人以上（CPUを含む）で出発できます。</p>' : '')
        : '<p class="note">ホストが出発するのを待っています。</p>') +
      '</div>' +
      '<div class="btn-row">' +
      '<button class="btn ghost" data-act="go-lobby">ロビーへ戻る</button>' +
      (host
        ? '<button class="btn ghost danger" data-act="leave-room">この旅を解散する</button>'
        : '<button class="btn ghost danger" data-act="leave-room">この旅から抜ける</button>') +
      '</div>';
  }

  function timeoutLabel(sec) {
    const c = TIMEOUT_CHOICES.filter(function (x) { return x[0] === Number(sec); })[0];
    return c ? c[1] : 'なし';
  }

  /* =========================================================
   * 手番の残り時間
   * ========================================================= */
  function deadline() {
    const g = S.game;
    if (!g || !g.turnTimeoutSec || !g.turnStartedAt) return null;
    if (g.status === 'setup') {
      if (!g.me || g.me.setupDone) return null;
      return g.turnStartedAt + g.turnTimeoutSec * 1000 * (g.setupTimeoutFactor || 2);
    }
    if (!inPlay()) return null;
    const cur = player(g.currentPlayerId);
    if (!cur || cur.isCpu) return null;
    const someoneActive = g.players.some(function (p) { return !p.isCpu && !p.away; });
    if (cur.away && someoneActive) return null; // 代行中は即座にCPUが進める
    return g.turnStartedAt + g.turnTimeoutSec * 1000;
  }

  function fmtClock(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function renderClock() {
    if (S.view !== 'game' || !S.game) return;
    const b = $('#turnBadge');
    const dl = deadline();
    let clock = '';
    let hurry = false;
    if (dl) {
      const left = dl - (Date.now() + S.clockOffset);
      if (left > 0) {
        clock = '<span class="tb-label">残り</span>' + fmtClock(left);
        hurry = left <= 15000 && (S.turnMine || S.game.status === 'setup');
      } else {
        clock = '時間切れ';
        hurry = S.turnMine;
      }
    }
    const html = '<span class="tb-text">' + esc(S.turnText) + '</span>' + (clock ? '<span class="tb-clock">' + clock + '</span>' : '');
    if (b.innerHTML !== html) {
      b.innerHTML = html;
      b.setAttribute('aria-label', S.turnText + (clock ? '、' + clock.replace(/<[^>]+>/g, '') : ''));
    }
    b.classList.toggle('mine', S.turnMine);
    b.classList.toggle('hurry', hurry);
  }

  function startClock() {
    if (S.clockTimer) return;
    S.clockTimer = setInterval(renderClock, 1000);
  }

  /* =========================================================
   * 盤面（SVG）
   * ========================================================= */
  function buildBoard() {
    if (S.boardBuilt) return;
    const svg = $('#board');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', '0 0 1000 1200');

    const gIsl = sv('g', { 'aria-hidden': 'true' }, svg);
    ISLANDS.forEach(function (it) { sv('text', { x: it[1], y: it[2], class: 'island' }, gIsl).textContent = it[0]; });

    const gR = sv('g', { class: 'routes' }, svg);
    S.map.routes.forEach(function (r) {
      const A = city(r.a);
      const B = city(r.b);
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const L = Math.hypot(dx, dy);
      const ux = dx / L;
      const uy = dy / L;
      const off = r.double ? (r.id < r.double ? 8 : -8) : 0;
      const ox = -uy * off;
      const oy = ux * off;
      const pad = 18;
      const sx = A.x + ox + ux * pad;
      const sy = A.y + oy + uy * pad;
      const ex = B.x + ox - ux * pad;
      const ey = B.y + oy - uy * pad;
      const seg = (L - pad * 2) / r.length;
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const g = sv('g', {
        class: 'route t-' + r.type, 'data-id': r.id, 'data-color': r.color, tabindex: '0', role: 'button',
        'aria-label': A.name + '–' + B.name + '、' + CARD[r.color].name + '、' + r.length + '両'
      }, gR);
      g.style.setProperty('--c', CARD[r.color].hex);
      sv('line', { class: 'hit', x1: sx.toFixed(1), y1: sy.toFixed(1), x2: ex.toFixed(1), y2: ey.toFixed(1) }, g);
      for (let i = 0; i < r.length; i++) {
        const cx = sx + ux * seg * (i + 0.5);
        const cy = sy + uy * seg * (i + 0.5);
        sv('rect', {
          class: 'car', x: (-(seg - 5) / 2).toFixed(1), y: -7, width: (seg - 5).toFixed(1), height: 14, rx: 3,
          transform: 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')'
        }, g);
      }
      S.routeEls[r.id] = g;
    });

    const gC = sv('g', { class: 'cities' }, svg);
    S.map.cities.forEach(function (c) {
      const g = sv('g', { class: 'city', 'data-id': c.id }, gC);
      sv('circle', { class: 'ring', cx: c.x, cy: c.y, r: 18 }, g);
      sv('circle', { class: 'dot', cx: c.x, cy: c.y, r: 9 }, g);
      const w = c.name.length * 24 + 18;
      const h = 42;
      const pos = LABEL_POS[c.id] || 'below';
      let px = c.x;
      let py = c.y + 36;
      if (pos === 'above') py = c.y - 36;
      if (pos === 'left') { px = c.x - w / 2 - 18; py = c.y; }
      if (pos === 'right') { px = c.x + w / 2 + 18; py = c.y; }
      sv('rect', { class: 'plate', x: px - w / 2, y: py - h / 2, width: w, height: h, rx: 4 }, g);
      sv('text', { class: 'cname', x: px, y: py + 4 }, g).textContent = c.name;
      sv('line', { class: 'bar', x1: px - w / 2 + 6, x2: px + w / 2 - 6, y1: py + 9, y2: py + 9 }, g);
      sv('text', { class: 'ckana', x: px, y: py + 19 }, g).textContent = c.kana;
      S.cityEls[c.id] = g;
    });

    sv('g', { id: 'fxLayer' }, svg);
    setupPanZoom(svg);
    S.boardBuilt = true;
  }

  function updateBoard() {
    const g = S.game;
    const myDestCities = {};
    if (g.me) {
      g.me.destHeld.forEach(function (d) {
        if (g.me.destDone.indexOf(d.destId) < 0) { myDestCities[d.a] = true; myDestCities[d.b] = true; }
      });
    }
    S.map.routes.forEach(function (r) {
      const el = S.routeEls[r.id];
      const owner = g.routes[r.id];
      el.classList.toggle('claimed', !!owner);
      el.classList.toggle('mine', owner === me());
      el.classList.toggle('selected', S.selectedRoute === r.id);
      if (owner) {
        const p = player(owner);
        el.style.setProperty('--owner', PIECE[p ? p.color : 'black']);
      }
      const partner = r.double ? g.routes[r.double] : null;
      el.classList.toggle('locked', !owner && !!partner && g.players.length <= 3);
    });
    S.map.cities.forEach(function (c) { S.cityEls[c.id].classList.toggle('dest', !!myDestCities[c.id]); });
  }

  function flashRoute(id) {
    const el = S.routeEls[id];
    if (!el) return;
    el.classList.remove('flash');
    void el.getBBox();
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 3000);
  }

  function highlight(cityIds, routeIds, ms) {
    cityIds.forEach(function (id) { if (S.cityEls[id]) S.cityEls[id].classList.add('hl'); });
    (routeIds || []).forEach(function (id) { if (S.routeEls[id]) S.routeEls[id].classList.add('hl'); });
    setTimeout(function () {
      cityIds.forEach(function (id) { if (S.cityEls[id]) S.cityEls[id].classList.remove('hl'); });
      (routeIds || []).forEach(function (id) { if (S.routeEls[id]) S.routeEls[id].classList.remove('hl'); });
    }, ms || 3500);
  }

  function routesOnPath(path, pid) {
    const out = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const hit = S.map.routes.filter(function (r) {
        return ((r.a === a && r.b === b) || (r.a === b && r.b === a)) && S.game.routes[r.id] === pid;
      })[0];
      if (hit) out.push(hit.id);
    }
    return out;
  }

  /* ---------- パン・ズーム ---------- */
  function setVB(v) {
    S.vb = v;
    $('#board').setAttribute('viewBox', v.x.toFixed(1) + ' ' + v.y.toFixed(1) + ' ' + v.w.toFixed(1) + ' ' + v.h.toFixed(1));
  }
  function clampVB(v) {
    const w = Math.min(1200, Math.max(220, v.w));
    const h = w * 1.2;
    const x = Math.min(1000 - w * 0.3, Math.max(-w * 0.7, v.x));
    const y = Math.min(1200 - h * 0.3, Math.max(-h * 0.7, v.y));
    return { x: x, y: y, w: w, h: h };
  }
  function toSvg(clientX, clientY) {
    const svg = $('#board');
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 500, y: 600 };
  }
  function zoomAt(cx, cy, factor) {
    const v = S.vb;
    const nw = v.w * factor;
    const k = nw / v.w;
    setVB(clampVB({ x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: nw, h: nw * 1.2 }));
  }
  function zoomCenter(factor) {
    const v = S.vb;
    zoomAt(v.x + v.w / 2, v.y + v.h / 2, factor);
  }
  function fitBoard(animate) {
    const target = Object.assign({}, BASE_VB);
    if (animate) return animateVB(target, 500);
    setVB(target);
    return Promise.resolve();
  }

  function setupPanZoom(svg) {
    const pts = new Map();
    let start = null;
    let pinchDist = 0;
    S.dragMoved = false;

    svg.addEventListener('pointerdown', function (e) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; S.dragMoved = false; }
      if (pts.size === 2) {
        const a = Array.from(pts.values());
        pinchDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        S.dragMoved = true;
      }
    });
    window.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const m = svg.getScreenCTM();
      if (!m) return;
      if (pts.size === 1) {
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) S.dragMoved = true;
        if (!S.dragMoved) return;
        const v = S.vb;
        setVB(clampVB({ x: v.x - (e.clientX - prev.x) / m.a, y: v.y - (e.clientY - prev.y) / m.d, w: v.w, h: v.h }));
      } else if (pts.size === 2) {
        const a = Array.from(pts.values());
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinchDist > 0 && d > 0) {
          const c = toSvg((a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2);
          zoomAt(c.x, c.y, pinchDist / d);
        }
        pinchDist = d;
      }
    });
    const end = function (e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      const c = toSvg(e.clientX, e.clientY);
      zoomAt(c.x, c.y, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    svg.addEventListener('click', function (e) {
      if (S.dragMoved) return;
      const g = e.target.closest && e.target.closest('.route');
      if (g) openSheet(g.dataset.id);
    });
    svg.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const g = e.target.closest && e.target.closest('.route');
      if (g) { e.preventDefault(); openSheet(g.dataset.id); }
    });
  }

  function animateVB(target, ms) {
    return new Promise(function (resolve) {
      if (REDUCED || ms <= 0) { setVB(target); resolve(); return; }
      const from = Object.assign({}, S.vb);
      const t0 = performance.now();
      const step = function (now) {
        const t = Math.min(1, (now - t0) / ms);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setVB({
          x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k,
          w: from.w + (target.w - from.w) * k, h: from.h + (target.h - from.h) * k
        });
        if (t < 1 && !S.fx.abort) requestAnimationFrame(step);
        else { if (S.fx.abort) setVB(target); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  function vbAround(x, y, w) { return { x: x - w / 2, y: y - w * 0.6, w: w, h: w * 1.2 }; }

  /* =========================================================
   * ゲーム画面の描画
   * ========================================================= */
  function renderGame() {
    if (!S.game || S.view !== 'game') return;
    updateBoard();
    renderTurn();
    renderPlayers();
    renderMarket();
    renderHand();
    renderActions();
    renderDests();
    renderDestModal();
    renderResult();
    if (S.selectedRoute && !$('#routeSheet').hidden) renderSheet();
  }

  function renderTurn() {
    const g = S.game;
    let text = '';
    let mine = false;
    let hint = '';
    if (g.status === 'setup') {
      text = '目的地選び中';
      hint = g.me && g.me.setupDone ? '他の乗客が目的地を選ぶのを待っています。' : '';
    } else if (g.status === 'ended') {
      text = 'ゲーム終了';
    } else {
      const prefix = g.status === 'finalRound' ? '最終・' : '';
      if (isMyTurn()) {
        mine = true;
        if (g.phase === 'drawSecond') { text = prefix + 'あと1枚引けます'; hint = 'もう1枚カードを引いてください（表の機関車は取れません）。'; }
        else if (g.phase === 'chooseDest') { text = prefix + '目的地を選んでください'; }
        else { text = prefix + 'あなたの番'; hint = 'カードを2枚引く・路線をタップして敷く・目的地カードを引く、のどれか1つを選びます。'; }
      } else {
        text = prefix + playerName(g.currentPlayerId) + 'の番';
      }
    }
    S.turnText = text;
    S.turnMine = mine;
    renderClock();
    startClock();
    $('#hint').textContent = hint;
    const mp = player(me());
    $('#awayBanner').hidden = !(mp && mp.away && g.status !== 'ended');
  }

  function renderPlayers() {
    const g = S.game;
    $('#players').innerHTML = g.players.map(function (p) {
      const cur = g.currentPlayerId === p.playerId;
      return '<div class="pcard' + (cur ? ' current' : '') + '">' +
        '<div class="pcard-name"><span class="pdot" style="background:' + PIECE[p.color] + '"></span>' + esc(p.name) + (p.playerId === me() ? '（あなた）' : '') + '</div>' +
        '<div class="pcard-score">' + p.score + '<small>点</small></div>' +
        '<div class="pcard-meta">列車 ' + p.trainsLeft + '両・手札 ' + p.handCount + '枚</div>' +
        '<div class="pcard-meta">目的地 ' + p.destDoneCount + '／' + p.destCount + ' 達成</div>' +
        (p.away ? '<div class="pcard-away">CPUが代行中</div>' : '') +
        '</div>';
    }).join('');
  }

  function canDraw() {
    return isMyTurn() && (S.game.phase === 'start' || S.game.phase === 'drawSecond') && !S.busy;
  }

  function renderMarket() {
    const g = S.game;
    const can = canDraw();
    const deckLeft = g.deckCount + g.discardCount;
    let html = '<button class="tcard deck" data-act="draw-deck"' + (can && deckLeft ? '' : ' disabled') + ' aria-label="山札から引く（残り' + deckLeft + '枚）"><span>山札 ' + deckLeft + '</span></button>';
    g.faceUp.forEach(function (c, i) {
      if (!c) { html += '<button class="tcard empty" disabled aria-label="空き"></button>'; return; }
      const dis = !can || (c === 'loco' && g.phase === 'drawSecond');
      html += '<button class="tcard ' + c + '" style="--c:' + CARD[c].hex + '" data-act="draw-face" data-i="' + i + '"' + (dis ? ' disabled' : '') + ' aria-label="表の' + CARD[c].name + 'を取る"><span>' + CARD[c].name + '</span></button>';
    });
    $('#market').innerHTML = html;
  }

  function renderHand() {
    const h = handOf();
    if (!h) { $('#hand').innerHTML = ''; return; }
    $('#hand').innerHTML = HAND_ORDER.map(function (c) {
      return '<div class="hcard ' + c + (h[c] ? '' : ' zero') + '" style="--c:' + CARD[c].hex + '" aria-label="' + CARD[c].name + ' ' + h[c] + '枚">' +
        '<b>' + h[c] + '</b><small>' + CARD[c].name + '</small></div>';
    }).join('');
  }

  function renderActions() {
    const g = S.game;
    let html = '';
    if (isMyTurn() && g.phase === 'start') {
      html += '<button class="btn" data-act="draw-dest"' + (g.destDeckCount && !S.busy ? '' : ' disabled') + '>目的地カードを引く（残り' + g.destDeckCount + '）</button>';
      const nothing = g.deckCount + g.discardCount === 0 && !g.faceUp.some(function (c) { return !!c; });
      if (nothing) html += '<button class="btn" data-act="pass-turn">引けるカードがないのでパス</button>';
    }
    if (g.status === 'ended') html += '<button class="btn primary" data-act="show-result">結果を見る</button>';
    $('#actions').innerHTML = html;
  }

  function ticketHtml(d, opt) {
    opt = opt || {};
    const cls = ['ticket'];
    if (opt.done) cls.push('done');
    if (opt.failed) cls.push('failed');
    if (opt.picked) cls.push('picked');
    const stamp = opt.done ? '<span class="stamp">達成</span>' : (opt.failed ? '<span class="stamp fail">未達</span>' : '');
    return '<button class="' + cls.join(' ') + '" data-act="' + (opt.act || 'hl-dest') + '" data-id="' + esc(d.destId) + '"' +
      (opt.pick ? ' aria-pressed="' + (opt.picked ? 'true' : 'false') + '"' : '') + '>' +
      '<span class="t-route"><span>' + esc(d.aName) + '</span><span class="t-arrow">→</span><span>' + esc(d.bName) + '</span></span>' +
      '<span class="t-pts">' + d.points + '<small>点</small></span>' +
      '<span class="t-meta">鉄道の旅　普通乗車券</span>' + stamp +
      '</button>';
  }

  function renderDests() {
    const m = S.game.me;
    if (!m || !m.destHeld.length) {
      $('#dests').innerHTML = '<p class="empty">まだ目的地カードがありません。</p>';
      return;
    }
    const ended = S.game.status === 'ended';
    $('#dests').innerHTML = m.destHeld.map(function (d) {
      const done = m.destDone.indexOf(d.destId) >= 0;
      return ticketHtml(d, { done: done, failed: ended && !done });
    }).join('');
  }

  function renderDestModal() {
    const g = S.game;
    const m = g.me;
    const pend = m ? m.pendingDest : [];
    const need = pend.length > 0 && !(g.status === 'setup' && m.setupDone) && g.status !== 'ended';
    const modal = $('#destModal');
    if (!need) { modal.hidden = true; S.destKey = null; return; }
    const key = pend.map(function (d) { return d.destId; }).join(',');
    if (S.destKey !== key) { S.destKey = key; S.destPick = new Set(); }
    const min = g.status === 'setup' ? Math.min(2, pend.length) : 1;
    const n = S.destPick.size;
    $('#destModalBody').innerHTML =
      '<h2>目的地を選ぶ</h2>' +
      '<p class="note">' + min + '枚以上選んでください。ゲーム終了までに自分の線路でつなげば得点、つなげなければその分が減点です。</p>' +
      '<div class="tickets">' + pend.map(function (d) {
        return ticketHtml(d, { act: 'toggle-dest', pick: true, picked: S.destPick.has(d.destId) });
      }).join('') + '</div>' +
      '<button class="btn primary" data-act="keep-dest"' + (n < min || S.busy ? ' disabled' : '') + '>' +
      (n < min ? 'あと' + (min - n) + '枚選んでください' : n + '枚を持って出発') + '</button>';
    modal.hidden = false;
  }

  function renderResult() {
    const g = S.game;
    if (g.status !== 'ended' || !g.results || S.resultShown) return;
    S.resultShown = true;
    if (S.fx.running) { setTimeout(function () { S.resultShown = false; renderResult(); }, 1500); return; }
    showResult();
  }

  function showResult() {
    const g = S.game;
    if (!g.results) return;
    const rows = g.results.ranking.map(function (r) {
      const p = player(r.playerId) || {};
      const tickets = (p.destHeld || []).map(function (d) {
        return esc(d.aName) + '→' + esc(d.bName) + ((p.destDone || []).indexOf(d.destId) >= 0 ? '○' : '×');
      }).join('　');
      return '<li><span class="no">' + r.rank + '</span>' +
        '<span class="who"><span class="pdot" style="background:' + PIECE[p.color || 'black'] + '"></span>' + esc(r.name) + '</span>' +
        '<span class="pts">' + r.score + '点</span>' +
        '<span class="detail">目的地 ' + r.destDone + '達成・' + r.destFailed + '未達（−' + (r.penalty || 0) + '点）<br>' + tickets + '</span></li>';
    }).join('');
    const top = g.results.ranking[0];
    $('#resultBody').innerHTML =
      '<h2>終着駅に到着しました</h2>' +
      '<p class="note">' + (top ? esc(top.name) + 'の優勝です。' : '') + '</p>' +
      '<ol class="rank">' + rows + '</ol>' +
      '<div class="btn-row"><button class="btn primary" data-act="go-lobby">ロビーへ戻る</button>' +
      '<button class="btn" data-act="close-result">盤面を見る</button></div>';
    $('#resultModal').hidden = false;
  }

  /* ---------- 路線シート ---------- */
  function openSheet(id) {
    if (!S.game || !route(id)) return;
    S.selectedRoute = id;
    renderSheet();
    $('#routeSheet').hidden = false;
    updateBoard();
  }
  function closeSheet() {
    S.selectedRoute = null;
    const sh = $('#routeSheet');
    if (sh) sh.hidden = true;
    if (S.game && S.boardBuilt) updateBoard();
  }

  function claimBlockReason(r) {
    const g = S.game;
    const h = handOf();
    if (g.status === 'setup') return '全員が目的地を選び終えると始まります。';
    if (!inPlay()) return 'ゲームは終了しています。';
    if (!isMyTurn()) return playerName(g.currentPlayerId) + 'の番です。';
    if (g.phase !== 'start') return 'カードを引き始めたので、この番は敷設できません。';
    const owner = g.routes[r.id];
    if (owner) return playerName(owner) + 'が開通済みです。';
    if (r.double) {
      const partner = g.routes[r.double];
      if (partner === me()) return '並んでいるもう1本をすでに持っています。';
      if (partner && g.players.length <= 3) return '2〜3人の旅では、複線は片側しか使えません。';
    }
    if (g.me && g.players.filter(function (p) { return p.playerId === me(); })[0].trainsLeft < r.length) return '列車コマが足りません。';
    if (!h) return '';
    if (!payOptions(r, h).length) return '手札が足りません。' + (r.color === 'gray' ? '同じ色' : CARD[r.color].name) + 'のカード（機関車でも代用可）が' + r.length + '枚必要です。';
    return '';
  }

  function payOptions(r, h) {
    const len = r.length;
    const colors = r.color === 'gray' ? CARD_COLORS : [r.color];
    const out = [];
    let allLoco = false;
    colors.forEach(function (c) {
      for (let l = Math.max(0, len - h[c]); l <= Math.min(h.loco, len); l++) {
        const count = len - l;
        if (count === 0) {
          if (allLoco) continue;
          allLoco = true;
          out.push({ color: r.color === 'gray' ? 'red' : r.color, count: 0, loco: l });
        } else {
          out.push({ color: c, count: count, loco: l });
        }
      }
    });
    out.sort(function (a, b) { return a.loco - b.loco || b.count - a.count; });
    return out.slice(0, 8);
  }

  function renderSheet() {
    const r = route(S.selectedRoute);
    if (!r) return;
    const A = city(r.a);
    const B = city(r.b);
    const reason = claimBlockReason(r);
    let body = '';
    if (reason) {
      body = '<p class="reason">' + esc(reason) + '</p>';
      S.payOpts = [];
    } else {
      S.payOpts = payOptions(r, handOf());
      body = '<p class="note" style="margin:0 0 8px">支払うカードを選ぶと開通します。</p><div class="pay-list">' +
        S.payOpts.map(function (o, i) {
          let minis = '';
          for (let k = 0; k < o.count; k++) minis += '<span class="mini" style="--c:' + CARD[o.color].hex + '"></span>';
          for (let k = 0; k < o.loco; k++) minis += '<span class="mini loco"></span>';
          const label = (o.count ? CARD[o.color].name + '×' + o.count : '') + (o.count && o.loco ? '＋' : '') + (o.loco ? '機関車×' + o.loco : '');
          return '<button class="pay" data-act="claim" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '><span class="pay-cards">' + minis + '</span>' + label + 'で開通</button>';
        }).join('') + '</div>';
    }
    const typeLabel = TYPE_LABEL[r.type] ? '・' + TYPE_LABEL[r.type] : '';
    $('#routeSheetBody').innerHTML =
      '<div class="sheet-head"><h2 class="sheet-title" id="routeSheetTitle">' + esc(A.name) + '〜' + esc(B.name) + '</h2>' +
      '<button class="btn small ghost" data-act="close-sheet">閉じる</button></div>' +
      '<div class="sheet-meta">' +
      '<span><span class="swatch" style="background:' + CARD[r.color].hex + '"></span>' + CARD[r.color].name + '</span>' +
      '<span>' + r.length + '両' + typeLabel + '</span>' +
      '<span>開通で +' + ROUTE_POINTS[r.length] + '点</span>' +
      '</div>' + body;
  }

  /* =========================================================
   * ゲーム操作
   * ========================================================= */
  function drawCard(source, index) {
    return withBusy(async function () {
      const r = await api('drawCard', { gameId: S.gameId, source: source, index: index });
      applyState(r.state);
      const c = r.data.drawn;
      toast((source === 'deck' ? '山札から' : '') + CARD[c].name + 'のカードを引きました' + (r.data.turnEnded ? '' : '。もう1枚引けます'));
    });
  }

  function claim(i) {
    const opt = S.payOpts[i];
    const rid = S.selectedRoute;
    if (!opt || !rid) return;
    unlockAudio();
    return withBusy(async function () {
      const r = await api('claimRoute', { gameId: S.gameId, routeId: rid, payment: opt });
      closeSheet();
      applyState(r.state);
      playFx(r.data);
    });
  }

  function drawDestinations() {
    return withBusy(async function () {
      const r = await api('drawDestinations', { gameId: S.gameId });
      applyState(r.state);
    });
  }

  function keepDestinations() {
    const keep = Array.from(S.destPick);
    return withBusy(async function () {
      const r = await api('keepDestinations', { gameId: S.gameId, keep: keep });
      S.destKey = null;
      applyState(r.state);
      const done = r.data.newlyCompleted || [];
      if (done.length) toast('すでにつながっている目的地がありました（' + done.length + '枚達成）');
    });
  }

  function passTurn() {
    return withBusy(async function () {
      const r = await api('passTurn', { gameId: S.gameId });
      applyState(r.state);
    });
  }

  function hlDest(id) {
    const m = S.game && S.game.me;
    if (!m) return;
    const d = m.destHeld.filter(function (x) { return x.destId === id; })[0];
    if (!d) return;
    const done = m.destDone.indexOf(id) >= 0;
    if (S.view === 'game') {
      const a = city(d.a);
      const b = city(d.b);
      const w = Math.max(360, Math.abs(a.x - b.x) + 200, (Math.abs(a.y - b.y) + 200) / 1.2);
      animateVB(clampVB(vbAround((a.x + b.x) / 2, (a.y + b.y) / 2, w)), 450);
      if (done) {
        api('checkDestinations', { gameId: S.gameId }).then(function (r) {
          const hit = r.data.results.filter(function (x) { return x.destId === id; })[0];
          highlight([d.a, d.b], hit ? routesOnPath(hit.path, me()) : [], 4000);
        }).catch(function () { highlight([d.a, d.b], [], 3500); });
      } else {
        highlight([d.a, d.b], [], 3500);
      }
    }
  }

  /* =========================================================
   * 開通演出（フライト／カメラ演出＋ナレーション＋音声）
   * ========================================================= */
  let AC = null;
  function unlockAudio() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    if (!AC) {
      try {
        AC = new C();
        const b = AC.createBuffer(1, 1, 22050);
        const s = AC.createBufferSource();
        s.buffer = b;
        s.connect(AC.destination);
        s.start(0);
      } catch (e) { AC = null; }
    } else if (AC.state === 'suspended') {
      AC.resume();
    }
  }

  function fxWait(ms) {
    return new Promise(function (resolve) {
      if (S.fx.abort) { resolve(); return; }
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); S.fx.waiters = S.fx.waiters.filter(function (w) { return w !== done; }); resolve(); }
      S.fx.waiters.push(done);
    });
  }

  function playAudio(b64) {
    return new Promise(function (resolve) {
      if (!AC || !b64 || S.fx.abort) { resolve(false); return; }
      let bytes;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch (e) { resolve(false); return; }
      const ok = function (buf) {
        if (S.fx.abort) { resolve(false); return; }
        const src = AC.createBufferSource();
        src.buffer = buf;
        src.connect(AC.destination);
        S.fx.source = src;
        const done = function () {
          S.fx.waiters = S.fx.waiters.filter(function (w) { return w !== done; });
          S.fx.source = null;
          resolve(true);
        };
        src.onended = done;
        S.fx.waiters.push(function () { try { src.stop(); } catch (e) { /* noop */ } done(); });
        src.start(0);
      };
      try {
        const p = AC.decodeAudioData(bytes.buffer, ok, function () { resolve(false); });
        if (p && p.catch) p.catch(function () { resolve(false); });
      } catch (e) { resolve(false); }
    });
  }

  function typeCaption(text) {
    const el = $('#fxCaption');
    if (S.fx.typer) clearInterval(S.fx.typer);
    if (REDUCED) { el.textContent = text; return; }
    let i = 0;
    el.textContent = '';
    S.fx.typer = setInterval(function () {
      i++;
      el.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(S.fx.typer); S.fx.typer = null; }
    }, 45);
  }

  async function fetchNarration(key) {
    try {
      const r = await api('narrate', { key: key });
      return r.data;
    } catch (e) {
      return null;
    }
  }

  async function speak(n, fallback) {
    const text = n && n.text ? n.text : fallback;
    typeCaption(text);
    let played = false;
    if (S.soundOn && n && n.audioBase64) played = await playAudio(n.audioBase64);
    if (!played) await fxWait(Math.max(2600, text.length * 120));
    else await fxWait(600);
  }

  async function cameraFlight(fromId, toId, color) {
    const a = city(fromId);
    const b = city(toId);
    const layer = $('#fxLayer');
    layer.innerHTML = '';
    const trail = sv('path', { class: 'fx-trail', d: 'M' + a.x + ' ' + a.y + ' L' + a.x + ' ' + a.y }, layer);
    const train = sv('g', { class: 'fx-train' }, layer);
    sv('circle', { cx: 0, cy: 0, r: 15, fill: PIECE[color] || PIECE.black }, train);
    sv('rect', { x: -7, y: -5, width: 14, height: 8, rx: 2, fill: '#fff' }, train);
    train.setAttribute('transform', 'translate(' + a.x + ' ' + a.y + ')');

    await animateVB(clampVB(vbAround(a.x, a.y, 300)), 700);
    if (S.fx.abort) return;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const ms = REDUCED ? 0 : Math.min(3200, 1400 + dist * 6);
    const endVB = clampVB(vbAround(b.x, b.y, 300));
    const fromVB = Object.assign({}, S.vb);
    await new Promise(function (resolve) {
      if (!ms) { resolve(); return; }
      const t0 = performance.now();
      const step = function (now) {
        const t = Math.min(1, (now - t0) / ms);
        const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = a.x + (b.x - a.x) * k;
        const y = a.y + (b.y - a.y) * k;
        train.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')');
        trail.setAttribute('d', 'M' + a.x + ' ' + a.y + ' L' + x.toFixed(1) + ' ' + y.toFixed(1));
        const lift = Math.sin(Math.PI * t) * 160;
        setVB({
          x: fromVB.x + (endVB.x - fromVB.x) * k - lift / 2, y: fromVB.y + (endVB.y - fromVB.y) * k - lift * 0.6,
          w: fromVB.w + lift, h: (fromVB.w + lift) * 1.2
        });
        if (t < 1 && !S.fx.abort) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    train.setAttribute('transform', 'translate(' + b.x + ' ' + b.y + ')');
    trail.setAttribute('d', 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y);
  }

  async function playFx(data) {
    if (!data || !data.fx) return;
    if (S.fx.running) stopFx();
    const fx = data.fx;
    const mePlayer = player(me());
    const color = mePlayer ? mePlayer.color : 'black';
    const backVB = Object.assign({}, S.vb);
    S.fx.running = true;
    S.fx.abort = false;
    S.fx.waiters = [];
    $('#fx').hidden = false;
    document.body.classList.add('fx-on');
    $('#fxTitle').textContent = fx.from.name + '〜' + fx.to.name + '　開通　+' + data.points + '点';
    $('#fxCaption').textContent = '';

    const narr = fetchNarration(fx.narrateKey);
    if (fx.flight && fx.flight.previewUrl) {
      const box = $('#fxVideo');
      box.innerHTML = '<iframe src="' + esc(fx.flight.previewUrl) + '" allow="autoplay; fullscreen" title="' + esc(fx.from.name + 'から' + fx.to.name + 'へのフライト映像') + '"></iframe>';
      box.hidden = false;
    } else {
      await cameraFlight(fx.from.id, fx.to.id, color);
    }
    if (!S.fx.abort) {
      $('#fxCaption').textContent = 'ナレーションを準備しています…';
      await speak(await narr, fx.from.name + 'から' + fx.to.name + 'へ、新しいレールがつながりました。');
    }

    const dests = fx.destinations || [];
    for (let i = 0; i < dests.length && !S.fx.abort; i++) {
      const d = dests[i];
      const info = (data.newlyCompleted || []).filter(function (x) { return x.destId === d.destId; })[0];
      if (info) $('#fxTitle').textContent = '目的地達成　' + info.aName + ' → ' + info.bName + '　+' + info.points + '点';
      highlight(d.path, routesOnPath(d.path, me()), 6000);
      const pts = d.path.map(city);
      const xs = pts.map(function (c) { return c.x; });
      const ys = pts.map(function (c) { return c.y; });
      const w = Math.max(360, Math.max.apply(null, xs) - Math.min.apply(null, xs) + 220, (Math.max.apply(null, ys) - Math.min.apply(null, ys) + 220) / 1.2);
      const cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
      const cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
      animateVB(clampVB(vbAround(cx, cy, w)), 700);
      $('#fxCaption').textContent = 'ナレーションを準備しています…';
      const n = await fetchNarration(d.narrateKey);
      await speak(n, info ? info.aName + 'から' + info.bName + 'まで、線路が一本につながりました。' : '目的地に到着しました。');
    }

    if (!S.fx.abort && fx.flight && fx.flight.previewUrl) {
      $('#fxCaption').textContent += '　（映像を見終えたら「閉じる」を押してください）';
      return;
    }
    await fxWait(500);
    finishFx(backVB);
  }

  function finishFx(backVB) {
    $('#fx').hidden = true;
    document.body.classList.remove('fx-on');
    $('#fxVideo').hidden = true;
    $('#fxVideo').innerHTML = '';
    $('#fxLayer') && ($('#fxLayer').innerHTML = '');
    if (S.fx.typer) { clearInterval(S.fx.typer); S.fx.typer = null; }
    S.fx.running = false;
    S.fx.abort = false;
    if (backVB && S.view === 'game') animateVB(backVB, 600);
  }

  function stopFx() {
    if (!S.fx.running) return;
    S.fx.abort = true;
    const ws = S.fx.waiters.slice();
    S.fx.waiters = [];
    ws.forEach(function (w) { w(); });
    finishFx(null);
  }

  /* =========================================================
   * 遊び方
   * ========================================================= */
  function openHelp() {
    S.helpReturn = document.activeElement;
    $('#helpModal').hidden = false;
    $('#helpBody').scrollTop = 0;
    $('#helpClose').focus();
    localStorage.setItem(LS.helpSeen, '1');
  }
  function closeHelp() {
    $('#helpModal').hidden = true;
    if (S.helpReturn && S.helpReturn.focus) S.helpReturn.focus();
  }

  /* =========================================================
   * メニュー
   * ========================================================= */
  function openMenu() { $('#menu').hidden = false; }
  function closeMenu() { $('#menu').hidden = true; }

  /* =========================================================
   * イベント配線
   * ========================================================= */
  const ACTIONS = {
    'tab': function (el) { switchTab(el.dataset.tab); },
    'toggle-eye': function (el) {
      const input = el.parentNode.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.setAttribute('aria-pressed', show ? 'true' : 'false');
      el.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    },
    'toggle-sound': function () {
      S.soundOn = !S.soundOn;
      localStorage.setItem(LS.sound, S.soundOn ? 'on' : 'off');
      renderSound();
      if (S.soundOn) unlockAudio();
      else if (S.fx.source) { try { S.fx.source.stop(); } catch (e) { /* noop */ } }
      toast(S.soundOn ? 'ナレーション音声をオンにしました' : 'ナレーション音声をオフにしました');
    },
    'menu': openMenu,
    'close-menu': closeMenu,
    'logout': logout,
    'go-lobby': function () { closeMenu(); if (S.user && !S.user.mustChange) showLobby(); },
    'change-pw-open': function () { closeMenu(); showChange(false); },
    'cancel-change': backFromChange,
    'refresh-lobby': showLobby,
    'open-game': function (el) { return withBusy(function () { return openGame(el.dataset.id); }); },
    'add-cpu': function () {
      return withBusy(async function () { const r = await api('addCpu', { gameId: S.gameId }); applyState(r.state); });
    },
    'remove-player': function (el) {
      return withBusy(async function () { const r = await api('leaveGame', { gameId: S.gameId, targetPlayerId: el.dataset.id }); applyState(r.state); });
    },
    'leave-room': function () {
      const host = S.game && S.game.hostId === me();
      if (!window.confirm(host ? 'この旅を解散しますか？' : 'この旅から抜けますか？')) return;
      return withBusy(async function () { await api('leaveGame', { gameId: S.gameId }); await showLobby(); });
    },
    'start-game': function () {
      unlockAudio();
      return withBusy(async function () { const r = await api('startGame', { gameId: S.gameId }); applyState(r.state); });
    },
    'share-room': function (el) {
      const url = el.dataset.url;
      const text = '「鉄道の旅」で一緒に日本をつなぎませんか？';
      if (navigator.share) navigator.share({ title: '鉄道の旅', text: text, url: url }).catch(function () { /* キャンセル */ });
      else copyText(url, '招待リンクをコピーしました');
    },
    'copy-text': function (el) { copyText(el.dataset.text, 'コピーしました'); },
    'draw-deck': function () { unlockAudio(); if (canDraw()) drawCard('deck'); },
    'draw-face': function (el) { unlockAudio(); if (canDraw()) drawCard('faceUp', Number(el.dataset.i)); },
    'draw-dest': drawDestinations,
    'pass-turn': passTurn,
    'claim': function (el) { claim(Number(el.dataset.i)); },
    'close-sheet': closeSheet,
    'toggle-dest': function (el) {
      const id = el.dataset.id;
      if (S.destPick.has(id)) S.destPick.delete(id);
      else S.destPick.add(id);
      renderDestModal();
    },
    'keep-dest': keepDestinations,
    'hl-dest': function (el) { hlDest(el.dataset.id); },
    'zoom-in': function () { zoomCenter(1 / 1.3); },
    'zoom-out': function () { zoomCenter(1.3); },
    'zoom-fit': function () { fitBoard(true); },
    'fx-close': function () { stopFx(); fitBoard(true); },
    'show-result': showResult,
    'close-result': function () { $('#resultModal').hidden = true; },
    'open-help': function () { closeMenu(); openHelp(); },
    'open-version': openVersion,
    'close-version': closeVersion,
    'reload-app': function () { location.reload(); },
    'close-help': closeHelp,
    'help-jump': function (el) {
      const t = document.getElementById(el.dataset.to);
      if (t) t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    },
    'resume': function () {
      return withBusy(async function () {
        const r = await api('resume', { gameId: S.gameId });
        applyState(r.state);
        toast('自分で操作する設定に戻しました');
      });
    }
  };

  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () { window.prompt('コピーしてください', text); });
    } else {
      window.prompt('コピーしてください', text);
    }
  }

  const FORMS = {
    loginForm: onLogin,
    registerForm: onRegister,
    resetForm: onReset,
    changeForm: onChange,
    nickForm: onNickname,
    createForm: async function (form) {
      const r = await api('initGame', { title: form.title.value });
      form.reset();
      enterGame(r.state);
    },
    joinForm: async function (form) {
      const id = form.gameId.value.trim().toUpperCase();
      await openGame(id);
      form.reset();
    }
  };

  function bindEvents() {
    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = ACTIONS[el.dataset.act];
      if (fn) { e.preventDefault(); fn(el); }
    });
    document.addEventListener('change', function (e) {
      const el = e.target.closest('[data-change]');
      if (!el) return;
      if (el.dataset.change === 'set-timeout') {
        const sec = Number(el.value);
        withBusy(async function () {
          const r = await api('setOptions', { gameId: S.gameId, turnTimeoutSec: sec });
          applyState(r.state);
          toast('1手の制限時間を「' + timeoutLabel(sec) + '」にしました');
        });
      }
    });
    document.addEventListener('submit', function (e) {
      const fn = FORMS[e.target.id];
      if (!fn) return;
      e.preventDefault();
      withBusy(function () { return fn(e.target); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#versionModal').hidden) closeVersion();
      else if (!$('#helpModal').hidden) closeHelp();
      else if (!$('#menu').hidden) closeMenu();
      else if (!$('#routeSheet').hidden) closeSheet();
      else if (S.fx.running) stopFx();
    });
    $('#menu').addEventListener('click', function (e) { if (e.target.id === 'menu') closeMenu(); });
    $('#helpModal').addEventListener('click', function (e) { if (e.target.id === 'helpModal') closeHelp(); });
    $('#versionModal').addEventListener('click', function (e) { if (e.target.id === 'versionModal') closeVersion(); });
    document.addEventListener('pointerdown', unlockAudio, { passive: true, once: true });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
