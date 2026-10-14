/******************************************************
 * 鉄道の旅（tetsudo-no-tabi）GAS バックエンド  Code.gs
 * ・オンライン対戦＋CPU混在 / 会員認証 / Gemini ナレーション＋TTS
 * ・デプロイ：ウェブアプリ（実行ユーザー：自分 / アクセス：全員）
 *   ※コード変更後は「デプロイを管理」→ 新しいバージョンで再デプロイ
 ******************************************************/
const APP_VERSION = '0.2.1';

const SHEETS = {
  Users: ['userId', 'email', 'nickname', 'salt', 'hash', 'mustChange', 'failCount', 'lockedUntil', 'createdAt', 'updatedAt'],
  Games: ['gameId', 'status', 'hostId', 'stateVersion', 'stateJson', 'createdAt', 'updatedAt'],
  Log: ['ts', 'gameId', 'userId', 'action', 'detailJson'],
  NarrationCache: ['key', 'text', 'audioFileId', 'createdAt']
};

const CARD_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white'];
const PIECE_COLORS = ['red', 'blue', 'green', 'yellow', 'black'];
const CPU_NAMES = ['CPUつばめ', 'CPUはやぶさ', 'CPUこまち', 'CPUのぞみ'];
const ROUTE_POINTS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 10, 6: 15 };
const RULES = {
  trainsByPlayers: { 2: 35, 3: 30, 4: 25, 5: 22 }, // 盤面容量（約116〜133コマ）に合わせて人数別に調整
  handInit: 4, faceUpCount: 5, cardsPerColor: 12, locoCount: 14,
  destInitDraw: 3, destInitKeep: 2, destDraw: 3, destKeep: 1,
  finalTrigger: 2, minPlayers: 2, maxPlayers: 5,
  lockLimit: 5, lockMinutes: 30, sessionSec: 21600, maxEvents: 30,
  turnTimeoutDefault: 90,                 // 1手の制限時間（秒）。0 は無制限
  timeoutChoices: [0, 60, 90, 180, 300],  // ホストが選べる制限時間
  setupTimeoutFactor: 2,                  // 目的地選び（開始時）は制限時間の2倍
  awayAfter: 2                            // 連続この回数の時間切れで「代行モード」へ
};
const SESSION_PREFIX = 'sess_';
const NARRATION_SYSTEM = [
  'あなたは日本の鉄道旅番組のナレーターです。落ち着いた語り口で、旅情を誘う車窓の情景を描写してください。',
  '制約：',
  '- 日本語60〜100文字、1〜2文',
  '- 季節・地形（海/山/平野）・土地の名物のいずれかを1つ以上織り込む',
  '- 年号・統計・実在人物など、検証できない具体的事実は書かない',
  '- 出力はJSONのみ：{"narration":"...","mood":"calm|bright|nostalgic"}'
].join('\n');
// 音声キャッシュの版。読み上げ方法を変えたら上げると、古い音声を使わず作り直す
const NARRATION_CACHE_VER = 'v2';

/* =========================================================
 * エントリーポイント
 * ========================================================= */
function doGet() {
  return out_({ ok: true, app: 'tetsudo-no-tabi', appVersion: APP_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return out_({ ok: false, appVersion: APP_VERSION, error: { code: 'BAD_REQUEST', message: 'リクエストJSONが不正です' } });
  }
  try {
    const res = dispatch_(req) || {};
    res.ok = true;
    res.appVersion = APP_VERSION;
    return out_(res);
  } catch (err) {
    const code = err.code || 'SERVER_ERROR';
    if (code === 'SERVER_ERROR') console.error(err && err.stack ? err.stack : err);
    return out_({ ok: false, appVersion: APP_VERSION, error: { code: code, message: err.message || String(err) } });
  }
}

function dispatch_(req) {
  const action = String(req.action || '');
  switch (action) {
    case 'ping': return { data: { appVersion: APP_VERSION } };
    case 'getMap': return { data: getMapData_() };
    case 'register': return withLock_(function () { return apiRegister_(req); });
    case 'login': return withLock_(function () { return apiLogin_(req); });
    case 'resetPassword': return withLock_(function () { return apiResetPassword_(req); });
  }

  const user = authenticate_(req.sessionToken);
  if (action === 'logout') {
    CacheService.getScriptCache().remove(SESSION_PREFIX + req.sessionToken);
    return { data: {} };
  }
  if (action === 'me') return { data: publicUser_(user) };
  if (action === 'changePassword') return withLock_(function () { return apiChangePassword_(user, req); });
  if (user.mustChange === true || user.mustChange === 'TRUE') {
    fail_('MUST_CHANGE_PASSWORD', '初回ログインのため、パスワードを変更してください');
  }

  switch (action) {
    case 'updateNickname': return withLock_(function () { return apiUpdateNickname_(user, req); });
    case 'listGames': return { data: apiListGames_(user) };
    case 'initGame': return withLock_(function () { return apiInitGame_(user, req); });
    case 'joinGame': return withLock_(function () { return apiJoinGame_(user, req); });
    case 'addCpu': return withLock_(function () { return apiAddCpu_(user, req); });
    case 'leaveGame': return withLock_(function () { return apiLeaveGame_(user, req); });
    case 'startGame': return withLock_(function () { return apiStartGame_(user, req); });
    case 'setOptions': return withLock_(function () { return apiSetOptions_(user, req); });
    case 'resume': return withLock_(function () { return apiResume_(user, req); });
    case 'getState': return apiGetState_(user, req);
    case 'drawCard': return gameAction_(user, req, actDrawCard_, true);
    case 'claimRoute': return gameAction_(user, req, actClaimRoute_, true);
    case 'drawDestinations': return gameAction_(user, req, actDrawDestinations_, true);
    case 'keepDestinations': return gameAction_(user, req, actKeepDestinations_, false);
    case 'passTurn': return gameAction_(user, req, actPassTurn_, true);
    case 'checkDestinations': return apiCheckDestinations_(user, req);
    case 'narrate': return { data: apiNarrate_(req) };
    default: fail_('UNKNOWN_ACTION', '不明なactionです: ' + action);
  }
}

/* =========================================================
 * 会員認証
 * ========================================================= */
function apiRegister_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません');
  if (!nickname || nickname.length > 20) fail_('INVALID_NICKNAME', 'ニックネームは1〜20文字で入力してください');
  if (findUser_('email', email)) fail_('EMAIL_EXISTS', 'このメールアドレスは登録済みです');

  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  const now = nowIso_();
  const user = {
    userId: 'U' + shortId_(), email: email, nickname: safeCell_(nickname), salt: salt,
    hash: hashPw_(temp, salt), mustChange: true, failCount: 0, lockedUntil: '', createdAt: now, updatedAt: now
  };
  sendTempPasswordMail_(email, nickname, temp, false);
  sheet_('Users').appendRow(SHEETS.Users.map(function (k) { return user[k]; }));
  return { data: { message: '仮パスワードをメールで送信しました。ログイン後にパスワードを変更してください。' } };
}

function apiLogin_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const u = findUser_('email', email);
  if (!u) fail_('LOGIN_FAILED', 'メールアドレスまたはパスワードが違います');

  const now = Date.now();
  const lockedUntil = Number(u.lockedUntil || 0);
  if (lockedUntil > now) {
    fail_('ACCOUNT_LOCKED', 'ログイン失敗が続いたためロック中です（約' + Math.ceil((lockedUntil - now) / 60000) + '分後に再試行してください）');
  }
  if (hashPw_(pw, u.salt) !== u.hash) {
    u.failCount = Number(u.failCount || 0) + 1;
    let msg = 'メールアドレスまたはパスワードが違います（' + u.failCount + '/' + RULES.lockLimit + '）';
    if (u.failCount >= RULES.lockLimit) {
      u.failCount = 0;
      u.lockedUntil = now + RULES.lockMinutes * 60000;
      msg = RULES.lockLimit + '回失敗したため、' + RULES.lockMinutes + '分間ロックしました';
    }
    u.updatedAt = nowIso_();
    saveUser_(u);
    fail_('LOGIN_FAILED', msg);
  }
  u.failCount = 0;
  u.lockedUntil = '';
  u.updatedAt = nowIso_();
  saveUser_(u);

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(SESSION_PREFIX + token, u.userId, RULES.sessionSec);
  return { data: { sessionToken: token, user: publicUser_(u) } };
}

function apiChangePassword_(user, req) {
  const cur = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hashPw_(cur, user.salt) !== user.hash) fail_('WRONG_PASSWORD', '現在のパスワードが違います');
  if (next.length < 8 || next.length > 64 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) {
    fail_('WEAK_PASSWORD', 'パスワードは英字と数字を含む8〜64文字にしてください');
  }
  if (next === cur) fail_('SAME_PASSWORD', '現在と異なるパスワードを設定してください');
  user.salt = Utilities.getUuid();
  user.hash = hashPw_(next, user.salt);
  user.mustChange = false;
  user.updatedAt = nowIso_();
  saveUser_(user);
  return { data: { message: 'パスワードを変更しました', user: publicUser_(user) } };
}

function apiResetPassword_(req) {
  const email = normEmail_(req.email);
  const u = findUser_('email', email);
  if (u) {
    const temp = tempPassword_();
    sendTempPasswordMail_(email, u.nickname, temp, true);
    u.salt = Utilities.getUuid();
    u.hash = hashPw_(temp, u.salt);
    u.mustChange = true;
    u.failCount = 0;
    u.lockedUntil = '';
    u.updatedAt = nowIso_();
    saveUser_(u);
  }
  // 登録有無を推測されないよう、常に同じ応答を返す
  return { data: { message: '登録済みのアドレスであれば、仮パスワードを送信しました' } };
}

function apiUpdateNickname_(user, req) {
  const nickname = String(req.nickname || '').trim();
  if (!nickname || nickname.length > 20) fail_('INVALID_NICKNAME', 'ニックネームは1〜20文字で入力してください');
  user.nickname = safeCell_(nickname);
  user.updatedAt = nowIso_();
  saveUser_(user);
  return { data: publicUser_(user) };
}

function authenticate_(token) {
  if (!token) fail_('NO_SESSION', 'ログインしてください');
  const cache = CacheService.getScriptCache();
  const uid = cache.get(SESSION_PREFIX + token);
  if (!uid) fail_('SESSION_EXPIRED', 'セッションの有効期限が切れました。再ログインしてください');
  cache.put(SESSION_PREFIX + token, uid, RULES.sessionSec);
  const u = findUser_('userId', uid);
  if (!u) fail_('NO_USER', 'ユーザーが見つかりません');
  return u;
}

function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: unsafeCell_(u.nickname), mustChange: u.mustChange === true || u.mustChange === 'TRUE' };
}

function hashPw_(pw, salt) {
  const pepper = prop_('PEPPER', '');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw + '|' + pepper, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  while (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    pw = '';
    for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pw;
}

function sendTempPasswordMail_(email, nickname, temp, isReset) {
  const appUrl = prop_('APP_URL', 'https://kenken6291.github.io/tetsudo-no-tabi/');
  const subject = isReset ? '【鉄道の旅】パスワード再発行のお知らせ' : '【鉄道の旅】会員登録ありがとうございます';
  const body = [
    nickname + ' さん',
    '',
    isReset ? 'パスワードを再発行しました。' : '鉄道の旅へのご登録ありがとうございます。',
    '以下の仮パスワードでログインし、新しいパスワードに変更してください。',
    '',
    '仮パスワード：' + temp,
    '',
    appUrl,
    '',
    '※このメールに心当たりがない場合は破棄してください。'
  ].join('\n');
  MailApp.sendEmail({ to: email, subject: subject, body: body, name: '鉄道の旅' });
}

function findUser_(field, value) {
  const vals = sheet_('Users').getDataRange().getValues();
  const head = vals[0];
  const idx = head.indexOf(field);
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][idx]) === String(value)) {
      const o = { _row: i + 1 };
      head.forEach(function (k, j) { o[k] = vals[i][j]; });
      return o;
    }
  }
  return null;
}

function saveUser_(u) {
  const head = SHEETS.Users;
  sheet_('Users').getRange(u._row, 1, 1, head.length).setValues([head.map(function (k) { return u[k]; })]);
}

/* =========================================================
 * ロビー（作成・参加・CPU追加・開始）
 * ========================================================= */
function apiListGames_(user) {
  const sh = sheet_('Games');
  const last = sh.getLastRow();
  if (last < 2) return { myGames: [], openGames: [] };
  const start = Math.max(2, last - 99);
  const vals = sh.getRange(start, 1, last - start + 1, SHEETS.Games.length).getValues();
  const myGames = [];
  const openGames = [];
  for (let i = vals.length - 1; i >= 0; i--) {
    const status = vals[i][1];
    if (status === 'closed') continue;
    let g;
    try { g = JSON.parse(vals[i][4]); } catch (err) { continue; }
    const isMine = g.players.some(function (p) { return p.playerId === user.userId; });
    const summary = {
      gameId: g.gameId, title: g.title, status: g.status, hostId: g.hostId,
      players: g.players.map(function (p) { return { name: p.name, isCpu: p.isCpu, color: p.color }; }),
      updatedAt: vals[i][6]
    };
    if (isMine) myGames.push(summary);
    else if (g.status === 'waiting' && g.players.length < RULES.maxPlayers) openGames.push(summary);
  }
  return { myGames: myGames.slice(0, 20), openGames: openGames.slice(0, 20) };
}

function apiInitGame_(user, req) {
  const name = unsafeCell_(user.nickname);
  const g = newGameState_(user.userId, name, String(req.title || '').trim().slice(0, 30));
  saveGame_(g, true);
  log_(g.gameId, user.userId, 'initGame', {});
  return { stateVersion: g.version, data: { gameId: g.gameId }, state: view_(g, user.userId) };
}

function apiJoinGame_(user, req) {
  const g = loadGame_(req.gameId);
  const already = findPlayer_(g, user.userId);
  if (!already) {
    if (g.status !== 'waiting') fail_('ALREADY_STARTED', 'このゲームはすでに開始しています');
    if (g.players.length >= RULES.maxPlayers) fail_('GAME_FULL', '定員（' + RULES.maxPlayers + '人）に達しています');
    g.players.push(newPlayer_(user.userId, unsafeCell_(user.nickname), nextPieceColor_(g), false));
    addEvent_(g, { type: 'join', playerId: user.userId });
    saveGame_(g);
    log_(g.gameId, user.userId, 'joinGame', {});
  }
  return { stateVersion: g.version, data: { gameId: g.gameId }, state: view_(g, user.userId) };
}

function apiAddCpu_(user, req) {
  const g = loadGame_(req.gameId);
  requireHost_(g, user.userId);
  if (g.status !== 'waiting') fail_('ALREADY_STARTED', '開始後はCPUを追加できません');
  if (g.players.length >= RULES.maxPlayers) fail_('GAME_FULL', '定員（' + RULES.maxPlayers + '人）に達しています');
  let n = 1;
  while (findPlayer_(g, 'CPU' + n)) n++;
  const cpu = newPlayer_('CPU' + n, CPU_NAMES[(n - 1) % CPU_NAMES.length], nextPieceColor_(g), true);
  g.players.push(cpu);
  addEvent_(g, { type: 'join', playerId: cpu.playerId });
  saveGame_(g);
  log_(g.gameId, user.userId, 'addCpu', { cpu: cpu.playerId });
  return { stateVersion: g.version, data: { playerId: cpu.playerId }, state: view_(g, user.userId) };
}

function apiLeaveGame_(user, req) {
  const g = loadGame_(req.gameId);
  if (g.status !== 'waiting') fail_('ALREADY_STARTED', '開始後は退出できません');
  const target = String(req.targetPlayerId || user.userId);
  if (target !== user.userId) requireHost_(g, user.userId);
  if (!findPlayer_(g, target)) fail_('NOT_IN_GAME', '対象のプレイヤーがいません');
  if (target === g.hostId) {
    g.status = 'closed';
  } else {
    g.players = g.players.filter(function (p) { return p.playerId !== target; });
    addEvent_(g, { type: 'leave', playerId: target });
  }
  saveGame_(g);
  log_(g.gameId, user.userId, 'leaveGame', { target: target });
  return { stateVersion: g.version, data: { closed: g.status === 'closed' }, state: view_(g, user.userId) };
}

function apiStartGame_(user, req) {
  const g = loadGame_(req.gameId);
  requireHost_(g, user.userId);
  if (g.status !== 'waiting') fail_('ALREADY_STARTED', 'すでに開始しています');
  if (g.players.length < RULES.minPlayers) fail_('NOT_ENOUGH_PLAYERS', '2人以上（CPU含む）必要です');
  startGameCore_(g);
  saveGame_(g);
  log_(g.gameId, user.userId, 'startGame', { players: g.players.length });
  return { stateVersion: g.version, data: {}, state: view_(g, user.userId) };
}

function newGameState_(hostId, hostName, title) {
  return {
    gameId: 'G' + shortId_(), mapId: MAP.mapId, title: title || (hostName + 'の旅'),
    status: 'waiting', hostId: hostId, createdAt: nowIso_(), version: 1,
    players: [newPlayer_(hostId, hostName, PIECE_COLORS[0], false)],
    currentIdx: 0, turn: { phase: 'start' },
    deck: [], discard: [], faceUp: [], destDeck: [], routes: {},
    finalTurnsLeft: null, passStreak: 0, events: [], eventSeq: 0, results: null,
    turnTimeoutSec: RULES.turnTimeoutDefault, turnStartedAt: null
  };
}

function newPlayer_(id, name, color, isCpu) {
  return {
    playerId: id, name: name, color: color, isCpu: isCpu, hand: emptyHand_(),
    trainsLeft: RULES.trainsByPlayers[2], score: 0, destHeld: [], destDone: [], pendingDest: [], setupDone: false,
    away: false, timeouts: 0
  };
}

function nextPieceColor_(g) {
  const used = g.players.map(function (p) { return p.color; });
  return PIECE_COLORS.filter(function (c) { return used.indexOf(c) < 0; })[0];
}

/** 山札・手札・目的地を配って setup フェーズへ（CPUは目的地を即選択） */
function startGameCore_(g) {
  g.players = shuffle_(g.players);
  g.deck = buildDeck_();
  g.discard = [];
  const trains = RULES.trainsByPlayers[g.players.length];
  g.players.forEach(function (p) {
    p.trainsLeft = trains;
    p.hand = emptyHand_();
    for (let i = 0; i < RULES.handInit; i++) p.hand[drawFromDeck_(g)]++;
  });
  g.faceUp = [];
  refillFaceUp_(g);
  g.destDeck = shuffle_(MAP.destinations.map(function (d) { return d.id; }));
  g.players.forEach(function (p) { p.pendingDest = g.destDeck.splice(-RULES.destInitDraw); });
  g.status = 'setup';
  g.turn = { phase: 'initDest' };
  g.currentIdx = 0;
  g.turnStartedAt = Date.now();
  addEvent_(g, { type: 'setup' });
  g.players.forEach(function (p) { if (p.isCpu) cpuChooseDestinations_(g, p, true); });
  maybeFinishSetup_(g);
  runCpuTurns_(g);
}

function maybeFinishSetup_(g) {
  if (g.status !== 'setup') return;
  if (!g.players.every(function (p) { return p.setupDone; })) return;
  g.status = 'playing';
  g.turn = { phase: 'start' };
  g.currentIdx = 0;
  g.turnStartedAt = Date.now();
  addEvent_(g, { type: 'start', playerId: currentPlayer_(g).playerId });
}

/* =========================================================
 * ゲーム状態の取得
 * ========================================================= */
function apiGetState_(user, req) {
  let g = loadGame_(req.gameId);
  requireMember_(g, user.userId);
  if (timeoutDue_(g)) {
    // 時間切れの手番があれば、ロックを取って代行処理（ポーリングした誰かのリクエストで進む）
    g = withLock_(function () {
      const fresh = loadGame_(req.gameId);
      if (applyTimeouts_(fresh)) {
        saveGame_(fresh);
        log_(fresh.gameId, user.userId, 'timeout', {});
      }
      return fresh;
    });
  }
  if (req.clientVersion !== undefined && Number(req.clientVersion) === g.version) {
    return { stateVersion: g.version, data: { unchanged: true } };
  }
  return { stateVersion: g.version, data: { unchanged: false }, state: view_(g, user.userId) };
}

function apiCheckDestinations_(user, req) {
  const g = loadGame_(req.gameId);
  const p = requireMember_(g, user.userId);
  const results = p.destHeld.map(function (id) {
    const d = destById_(id);
    const path = findPath_(g, p.playerId, d.a, d.b);
    return Object.assign(destInfo_(id), { completed: !!path, path: path || [] });
  });
  return { stateVersion: g.version, data: { results: results } };
}

/** プレイヤー視点の状態（他人の手札・目的地は隠す） */
function view_(g, pid) {
  const me = findPlayer_(g, pid);
  const ended = g.status === 'ended';
  const inPlay = g.status === 'playing' || g.status === 'finalRound';
  return {
    gameId: g.gameId, title: g.title, status: g.status, hostId: g.hostId, version: g.version, mapId: g.mapId,
    players: g.players.map(function (p) {
      const o = {
        playerId: p.playerId, name: p.name, color: p.color, isCpu: p.isCpu, score: p.score,
        trainsLeft: p.trainsLeft, handCount: handTotal_(p.hand), destCount: p.destHeld.length,
        destDoneCount: p.destDone.length, setupDone: p.setupDone, away: !!p.away, timeouts: p.timeouts || 0
      };
      if (ended) {
        o.destHeld = p.destHeld.map(destInfo_);
        o.destDone = p.destDone.slice();
        o.penalty = p.penalty || 0;
      }
      return o;
    }),
    currentPlayerId: inPlay ? currentPlayer_(g).playerId : null,
    phase: g.turn.phase,
    faceUp: g.faceUp,
    deckCount: g.deck.length, discardCount: g.discard.length, destDeckCount: g.destDeck.length,
    routes: g.routes, finalTurnsLeft: g.finalTurnsLeft, events: g.events, results: g.results,
    turnTimeoutSec: g.turnTimeoutSec || 0, turnStartedAt: g.turnStartedAt || null,
    setupTimeoutFactor: RULES.setupTimeoutFactor, serverNow: Date.now(),
    me: me ? {
      playerId: me.playerId, hand: me.hand, setupDone: me.setupDone,
      destHeld: me.destHeld.map(destInfo_), destDone: me.destDone.slice(),
      pendingDest: me.pendingDest.map(destInfo_)
    } : null
  };
}

/* =========================================================
 * ゲームアクション（共通ラッパー）
 * ========================================================= */
function gameAction_(user, req, fn, needTurn) {
  return withLock_(function () {
    const g = loadGame_(req.gameId);
    const p = requireMember_(g, user.userId);
    if (needTurn) {
      if (g.status !== 'playing' && g.status !== 'finalRound') fail_('NOT_PLAYING', 'ゲーム進行中ではありません');
      if (currentPlayer_(g).playerId !== p.playerId) fail_('NOT_YOUR_TURN', 'あなたの手番ではありません');
    }
    const data = fn(g, p, req) || {};
    if (p.away || p.timeouts) {
      // 自分で操作した＝戻ってきたので代行を解除
      p.away = false;
      p.timeouts = 0;
    }
    runCpuTurns_(g);
    saveGame_(g);
    const logReq = Object.assign({}, req);
    delete logReq.sessionToken;
    log_(g.gameId, p.playerId, req.action, { req: logReq });
    return { stateVersion: g.version, data: data, state: view_(g, p.playerId) };
  });
}

/* ---------- 列車カードを引く ---------- */
function actDrawCard_(g, p, req) {
  const phase = g.turn.phase;
  if (phase !== 'start' && phase !== 'drawSecond') fail_('BAD_PHASE', '今はカードを引けません');
  let card;
  if (req.source === 'faceUp') {
    const i = Number(req.index);
    if (!(i >= 0 && i < RULES.faceUpCount) || !g.faceUp[i]) fail_('BAD_INDEX', 'そのカードは取れません');
    card = g.faceUp[i];
    if (card === 'loco' && phase === 'drawSecond') fail_('LOCO_SECOND', '2枚目に表向きの機関車は取れません');
    g.faceUp[i] = drawFromDeck_(g);
    refillFaceUp_(g);
  } else if (req.source === 'deck') {
    card = drawFromDeck_(g);
    if (!card) fail_('DECK_EMPTY', '山札がありません');
  } else {
    fail_('BAD_SOURCE', 'source は deck か faceUp を指定してください');
  }
  p.hand[card]++;
  p.lastAction = 'draw';
  g.passStreak = 0;
  addEvent_(g, { type: 'draw', playerId: p.playerId, source: req.source, card: req.source === 'faceUp' ? card : null });

  const endsTurn = phase === 'drawSecond' || (req.source === 'faceUp' && card === 'loco') || !canDrawSecond_(g);
  if (endsTurn) endTurn_(g);
  else g.turn.phase = 'drawSecond';
  return { drawn: card, turnEnded: endsTurn };
}

/* ---------- 路線を敷設する ---------- */
function actClaimRoute_(g, p, req) {
  if (g.turn.phase !== 'start') fail_('BAD_PHASE', 'カードを引いたターンは敷設できません');
  const r = routeById_(String(req.routeId || ''));
  if (!r) fail_('NO_ROUTE', '路線が見つかりません');
  const chk = canClaim_(g, p, r);
  if (!chk.ok) fail_(chk.code, chk.message);
  const pay = normalizePayment_(req.payment);
  const v = validatePayment_(p, r, pay);
  if (!v.ok) fail_('INVALID_PAYMENT', v.message);
  const result = doClaim_(g, p, r, pay);
  result.fx = buildFx_(r, result.newlyCompleted);
  return result;
}

function routeAvailable_(g, pid, r) {
  if (g.routes[r.id]) return false;
  if (r.double) {
    const owner = g.routes[r.double];
    if (owner === pid) return false;
    if (owner && g.players.length <= 3) return false;
  }
  return true;
}

function canClaim_(g, p, r) {
  if (g.routes[r.id]) return { ok: false, code: 'ROUTE_TAKEN', message: 'この路線は占有済みです' };
  if (r.double) {
    const owner = g.routes[r.double];
    if (owner === p.playerId) return { ok: false, code: 'DOUBLE_SELF', message: '複線の両方を占有することはできません' };
    if (owner && g.players.length <= 3) return { ok: false, code: 'DOUBLE_LOCKED', message: '2〜3人プレイでは複線は片側のみ使えます' };
  }
  if (p.trainsLeft < r.length) return { ok: false, code: 'NOT_ENOUGH_TRAINS', message: '列車コマが足りません' };
  return { ok: true };
}

function normalizePayment_(pay) {
  pay = pay || {};
  return { color: String(pay.color || ''), count: Math.max(0, Math.floor(Number(pay.count) || 0)), loco: Math.max(0, Math.floor(Number(pay.loco) || 0)) };
}

function validatePayment_(p, r, pay) {
  if (pay.count + pay.loco !== r.length) return { ok: false, message: 'カードは合計' + r.length + '枚必要です' };
  if (pay.count > 0) {
    if (CARD_COLORS.indexOf(pay.color) < 0) return { ok: false, message: 'カードの色が不正です' };
    if (r.color !== 'gray' && pay.color !== r.color) return { ok: false, message: '路線の色と一致しません' };
    if (p.hand[pay.color] < pay.count) return { ok: false, message: '手札の色カードが足りません' };
  }
  if (p.hand.loco < pay.loco) return { ok: false, message: '手札の機関車カードが足りません' };
  return { ok: true };
}

function doClaim_(g, p, r, pay) {
  if (pay.count > 0) {
    p.hand[pay.color] -= pay.count;
    for (let i = 0; i < pay.count; i++) g.discard.push(pay.color);
  }
  p.hand.loco -= pay.loco;
  for (let i = 0; i < pay.loco; i++) g.discard.push('loco');

  g.routes[r.id] = p.playerId;
  p.trainsLeft -= r.length;
  const pts = ROUTE_POINTS[r.length];
  p.score += pts;
  p.lastAction = 'claim';
  g.passStreak = 0;
  addEvent_(g, { type: 'claim', playerId: p.playerId, routeId: r.id, points: pts });

  const completed = updateDestinations_(g, p);
  completed.forEach(function (d) { addEvent_(g, { type: 'destComplete', playerId: p.playerId, destId: d.destId }); });

  if (p.trainsLeft <= RULES.finalTrigger && g.finalTurnsLeft === null) {
    g.finalTurnsLeft = g.players.length + 1; // 全員（発生者含む）が最後に1手番ずつ
    g.status = 'finalRound';
    addEvent_(g, { type: 'finalRound', playerId: p.playerId });
  }
  endTurn_(g);
  return { routeId: r.id, points: pts, trainsLeft: p.trainsLeft, newlyCompleted: completed };
}

/* ---------- 目的地カード ---------- */
function actDrawDestinations_(g, p) {
  if (g.turn.phase !== 'start') fail_('BAD_PHASE', '今は目的地カードを引けません');
  if (!g.destDeck.length) fail_('DEST_EMPTY', '目的地カードはもうありません');
  p.pendingDest = g.destDeck.splice(-Math.min(RULES.destDraw, g.destDeck.length));
  g.turn.phase = 'chooseDest';
  g.passStreak = 0;
  return { pendingDest: p.pendingDest.map(destInfo_) };
}

function actKeepDestinations_(g, p, req) {
  const keep = (req.keep || []).map(String).filter(function (id, i, a) { return a.indexOf(id) === i; });
  if (!p.pendingDest.length) fail_('NO_PENDING', '選択中の目的地カードがありません');
  if (keep.some(function (id) { return p.pendingDest.indexOf(id) < 0; })) fail_('BAD_KEEP', '選べない目的地が含まれています');
  let min;
  if (g.status === 'setup') {
    if (p.setupDone) fail_('ALREADY_CHOSEN', 'すでに選択済みです');
    min = Math.min(RULES.destInitKeep, p.pendingDest.length);
  } else {
    if (g.status !== 'playing' && g.status !== 'finalRound') fail_('NOT_PLAYING', 'ゲーム進行中ではありません');
    if (currentPlayer_(g).playerId !== p.playerId) fail_('NOT_YOUR_TURN', 'あなたの手番ではありません');
    if (g.turn.phase !== 'chooseDest') fail_('BAD_PHASE', '目的地を選ぶフェーズではありません');
    min = RULES.destKeep;
  }
  if (keep.length < min) fail_('KEEP_MORE', min + '枚以上選んでください');
  const completed = applyKeep_(g, p, keep);
  return { kept: keep, newlyCompleted: completed };
}

function applyKeep_(g, p, keep) {
  const returned = p.pendingDest.filter(function (id) { return keep.indexOf(id) < 0; });
  g.destDeck = returned.concat(g.destDeck); // 戻したカードは山の底へ
  p.destHeld = p.destHeld.concat(keep);
  p.pendingDest = [];
  const completed = updateDestinations_(g, p);
  if (g.status === 'setup') {
    p.setupDone = true;
    addEvent_(g, { type: 'destSetup', playerId: p.playerId, kept: keep.length });
    maybeFinishSetup_(g);
  } else {
    p.lastAction = 'dest';
    addEvent_(g, { type: 'destDraw', playerId: p.playerId, kept: keep.length });
    endTurn_(g);
  }
  return completed;
}

/* ---------- パス（引けるカードが一枚もない時のみ） ---------- */
function actPassTurn_(g, p) {
  if (g.turn.phase !== 'start') fail_('BAD_PHASE', '今はパスできません');
  if (canDrawAny_(g)) fail_('CANNOT_PASS', 'カードが引けるのでパスできません');
  forcePass_(g, p);
  return { passed: true };
}

function forcePass_(g, p) {
  g.passStreak = (g.passStreak || 0) + 1;
  addEvent_(g, { type: 'pass', playerId: p.playerId });
  if (g.passStreak >= g.players.length) { finishGame_(g); return; } // 全員手詰まり
  endTurn_(g);
}

/* ---------- 手番終了・ゲーム終了 ---------- */
function endTurn_(g) {
  g.turn = { phase: 'start' };
  if (g.finalTurnsLeft !== null) {
    g.finalTurnsLeft--;
    if (g.finalTurnsLeft <= 0) { finishGame_(g); return; }
  }
  if (boardFull_(g)) { addEvent_(g, { type: 'boardFull' }); finishGame_(g); return; }
  g.currentIdx = (g.currentIdx + 1) % g.players.length;
  g.turnStartedAt = Date.now();
  addEvent_(g, { type: 'turn', playerId: currentPlayer_(g).playerId });
}

/** 誰も敷設できる路線が残っていない（または全員コマ不足）なら true */
function boardFull_(g) {
  return !MAP.routes.some(function (r) {
    return g.players.some(function (p) { return p.trainsLeft >= r.length && routeAvailable_(g, p.playerId, r); });
  });
}

function finishGame_(g) {
  g.status = 'ended';
  g.turn = { phase: 'ended' };
  g.players.forEach(function (p) {
    let pen = 0;
    p.destHeld.forEach(function (id) { if (p.destDone.indexOf(id) < 0) pen += destById_(id).points; });
    p.penalty = pen;
    p.score -= pen;
  });
  const ranking = g.players.slice().sort(function (a, b) {
    return (b.score - a.score) || (b.destDone.length - a.destDone.length);
  }).map(function (p, i) {
    return {
      rank: i + 1, playerId: p.playerId, name: p.name, isCpu: p.isCpu, score: p.score,
      destDone: p.destDone.length, destFailed: p.destHeld.length - p.destDone.length, penalty: p.penalty
    };
  });
  g.results = { ranking: ranking };
  addEvent_(g, { type: 'end' });
}

/* =========================================================
 * 目的地判定（BFS）
 * ========================================================= */
function updateDestinations_(g, p) {
  const done = [];
  p.destHeld.forEach(function (id) {
    if (p.destDone.indexOf(id) >= 0) return;
    const d = destById_(id);
    const path = findPath_(g, p.playerId, d.a, d.b);
    if (path) {
      p.destDone.push(id);
      p.score += d.points;
      done.push(Object.assign(destInfo_(id), { path: path, narrateKey: id + ':complete' }));
    }
  });
  return done;
}

/** 自分の占有路線だけで a→b が繋がっていれば都市IDの経路を返す */
function findPath_(g, pid, a, b) {
  if (a === b) return [a];
  const adj = {};
  Object.keys(g.routes).forEach(function (rid) {
    if (g.routes[rid] !== pid) return;
    const r = routeById_(rid);
    (adj[r.a] = adj[r.a] || []).push(r.b);
    (adj[r.b] = adj[r.b] || []).push(r.a);
  });
  const prev = {};
  prev[a] = null;
  const queue = [a];
  while (queue.length) {
    const u = queue.shift();
    if (u === b) {
      const path = [];
      for (let v = b; v !== null; v = prev[v]) path.unshift(v);
      return path;
    }
    (adj[u] || []).forEach(function (v) {
      if (!(v in prev)) { prev[v] = u; queue.push(v); }
    });
  }
  return null;
}

/* =========================================================
 * 手番のタイムアウト・代行モード
 * ========================================================= */
function apiSetOptions_(user, req) {
  const g = loadGame_(req.gameId);
  requireHost_(g, user.userId);
  if (g.status !== 'waiting') fail_('ALREADY_STARTED', '開始後は変更できません');
  const sec = Number(req.turnTimeoutSec);
  if (RULES.timeoutChoices.indexOf(sec) < 0) fail_('BAD_OPTION', '制限時間の値が不正です');
  g.turnTimeoutSec = sec;
  addEvent_(g, { type: 'options', turnTimeoutSec: sec });
  saveGame_(g);
  log_(g.gameId, user.userId, 'setOptions', { turnTimeoutSec: sec });
  return { stateVersion: g.version, data: { turnTimeoutSec: sec }, state: view_(g, user.userId) };
}

function apiResume_(user, req) {
  const g = loadGame_(req.gameId);
  const p = requireMember_(g, user.userId);
  if (p.away || p.timeouts) {
    p.away = false;
    p.timeouts = 0;
    addEvent_(g, { type: 'resume', playerId: p.playerId });
    saveGame_(g);
    log_(g.gameId, user.userId, 'resume', {});
  }
  return { stateVersion: g.version, data: {}, state: view_(g, user.userId) };
}

/**
 * すぐに CPU が操作してよい手番か。
 * 代行中の人間は、他に操作中の人間がいる時だけ即時代行する
 * （全員が離席中に、CPU だけで最後まで進んでしまわないように）。
 */
function isAuto_(g, p) {
  if (p.isCpu) return true;
  if (!p.away) return false;
  return g.players.some(function (q) { return !q.isCpu && !q.away; });
}

/** 時間切れ（または代行モード）で進めるべき手番があるか */
function timeoutDue_(g) {
  if (!g.turnStartedAt) return false;
  if ((g.status === 'playing' || g.status === 'finalRound') && isAuto_(g, currentPlayer_(g))) return true;
  if (!g.turnTimeoutSec) return false;
  const elapsed = Date.now() - g.turnStartedAt;
  if (g.status === 'setup') {
    return elapsed > g.turnTimeoutSec * 1000 * RULES.setupTimeoutFactor &&
      g.players.some(function (p) { return !p.isCpu && !p.setupDone; });
  }
  if (g.status === 'playing' || g.status === 'finalRound') {
    const p = currentPlayer_(g);
    return elapsed > g.turnTimeoutSec * 1000;
  }
  return false;
}

/** 時間切れの手番を CPU ロジックで代行する。状態を変えたら true */
function applyTimeouts_(g) {
  let changed = false;
  for (let guard = 0; guard < 10 && timeoutDue_(g); guard++) {
    changed = true;
    if (g.status === 'setup') {
      g.players.forEach(function (p) {
        if (!p.isCpu && !p.setupDone && g.status === 'setup') {
          markTimeout_(g, p, false);
          cpuChooseDestinations_(g, p, true);
        }
      });
    } else {
      const p = currentPlayer_(g);
      if (p.isCpu) { runCpuTurns_(g); continue; }
      if (!isAuto_(g, p)) markTimeout_(g, p, true);
      try {
        autoPlayTurn_(g, p);
      } catch (err) {
        console.error('autoplay error: ' + (err && err.stack ? err.stack : err));
        g.turn = { phase: 'start' };
        forcePass_(g, p);
      }
    }
    runCpuTurns_(g);
  }
  return changed;
}

function markTimeout_(g, p, countTowardAway) {
  if (countTowardAway) {
    p.timeouts = (p.timeouts || 0) + 1;
    if (p.timeouts >= RULES.awayAfter) p.away = true;
  }
  addEvent_(g, { type: 'timeout', playerId: p.playerId, away: !!p.away, setup: g.status === 'setup' });
}

/** 手番の途中（2枚目・目的地選択中）からでも代行できるようにする */
function autoPlayTurn_(g, p) {
  const phase = g.turn.phase;
  if (phase === 'chooseDest') {
    cpuChooseDestinations_(g, p, false);
    return;
  }
  if (phase === 'drawSecond') {
    if (g.deck.length + g.discard.length > 0) { actDrawCard_(g, p, { source: 'deck' }); return; }
    for (let i = 0; i < g.faceUp.length; i++) {
      if (g.faceUp[i] && g.faceUp[i] !== 'loco') { actDrawCard_(g, p, { source: 'faceUp', index: i }); return; }
    }
    endTurn_(g);
    return;
  }
  cpuTakeTurn_(g, p);
}

/* =========================================================
 * CPU
 * ========================================================= */
function runCpuTurns_(g) {
  for (let i = 0; i < 60; i++) {
    if (g.status !== 'playing' && g.status !== 'finalRound') return;
    const p = currentPlayer_(g);
    if (!isAuto_(g, p)) return;
    try {
      cpuTakeTurn_(g, p);
    } catch (err) {
      console.error('CPU error: ' + (err && err.stack ? err.stack : err));
      g.turn = { phase: 'start' };
      forcePass_(g, p);
    }
  }
}

function cpuTakeTurn_(g, p) {
  const plan = cpuPlan_(g, p);

  // 1) 目的地に必要な路線を敷設できるなら敷設
  for (let i = 0; i < plan.needed.length; i++) {
    const r = plan.needed[i].route;
    const pay = payable_(p, r);
    if (pay && canClaim_(g, p, r).ok) { doClaim_(g, p, r, pay); return; }
  }

  // 2) 目標がない：目的地を追加 or 得点の高い路線を敷設
  if (!plan.needed.length) {
    if (g.status === 'playing' && g.destDeck.length && p.trainsLeft >= 12) {
      actDrawDestinations_(g, p);
      cpuChooseDestinations_(g, p, false);
      return;
    }
    const best = bestScoringRoute_(g, p, 3);
    if (best) { doClaim_(g, p, best.route, best.pay); return; }
  }

  // 3) 終盤で残りコマが少ない：取れる路線で得点を稼ぐ
  if (g.status === 'finalRound' || p.trainsLeft <= 6) {
    const best = bestScoringRoute_(g, p, 1);
    if (best) { doClaim_(g, p, best.route, best.pay); return; }
  }

  // 4) カードを引く
  if (canDrawAny_(g)) { cpuDraw_(g, p, plan); return; }

  // 5) 引けない：何でも敷設、だめならパス
  const any = bestScoringRoute_(g, p, 1);
  if (any) { doClaim_(g, p, any.route, any.pay); return; }
  forcePass_(g, p);
}

/** 未達成目的地への最短計画から「まだ必要な路線」を重み付きで返す */
function cpuPlan_(g, p) {
  const weight = {};
  p.destHeld.forEach(function (id) {
    if (p.destDone.indexOf(id) >= 0) return;
    const d = destById_(id);
    const res = dijkstra_(g, p.playerId, d.a, d.b);
    if (!res || res.cost > p.trainsLeft) return;
    res.routes.forEach(function (r) {
      if (g.routes[r.id] === p.playerId) return;
      weight[r.id] = (weight[r.id] || 0) + 1;
    });
  });
  const needed = Object.keys(weight).map(function (rid) { return { route: routeById_(rid), weight: weight[rid] }; });
  needed.sort(function (x, y) { return (y.weight - x.weight) || (y.route.length - x.route.length); });
  return { needed: needed };
}

function dijkstra_(g, pid, a, b) {
  const dist = {};
  const prevRoute = {};
  const prevCity = {};
  const visited = {};
  MAP.cities.forEach(function (c) { dist[c.id] = Infinity; });
  dist[a] = 0;
  for (;;) {
    let u = null;
    Object.keys(dist).forEach(function (k) { if (!visited[k] && (u === null || dist[k] < dist[u])) u = k; });
    if (u === null || dist[u] === Infinity) return null;
    if (u === b) break;
    visited[u] = true;
    MAP.routes.forEach(function (r) {
      if (r.a !== u && r.b !== u) return;
      const v = r.a === u ? r.b : r.a;
      if (visited[v]) return;
      let cost;
      if (g.routes[r.id] === pid) cost = 0;
      else if (routeAvailable_(g, pid, r)) cost = r.length;
      else return;
      if (dist[u] + cost < dist[v]) { dist[v] = dist[u] + cost; prevRoute[v] = r; prevCity[v] = u; }
    });
  }
  const routes = [];
  for (let v = b; v !== a; v = prevCity[v]) routes.push(prevRoute[v]);
  return { cost: dist[b], routes: routes };
}

/** 手札で支払える方法（色カード優先、不足分を機関車で補う） */
function payable_(p, r) {
  if (p.trainsLeft < r.length) return null;
  if (r.color !== 'gray') {
    const c = Math.min(p.hand[r.color], r.length);
    const l = r.length - c;
    return l <= p.hand.loco ? { color: r.color, count: c, loco: l } : null;
  }
  let best = null;
  CARD_COLORS.forEach(function (col) {
    const c = Math.min(p.hand[col], r.length);
    const l = r.length - c;
    if (l <= p.hand.loco && (!best || c > best.count)) best = { color: col, count: c, loco: l };
  });
  return best;
}

function bestScoringRoute_(g, p, minLength) {
  let best = null;
  MAP.routes.forEach(function (r) {
    if (r.length < minLength || !canClaim_(g, p, r).ok) return;
    const pay = payable_(p, r);
    if (!pay) return;
    if (!best || r.length > best.route.length || (r.length === best.route.length && pay.loco < best.pay.loco)) {
      best = { route: r, pay: pay };
    }
  });
  return best;
}

function cpuDraw_(g, p, plan) {
  const wanted = {};
  plan.needed.forEach(function (n) {
    if (n.route.color !== 'gray') wanted[n.route.color] = true;
  });
  if (!Object.keys(wanted).length) {
    // 灰色路線のみ必要 or 目標なし → 一番多く持っている色を集める
    let top = null;
    CARD_COLORS.forEach(function (c) { if (top === null || p.hand[c] > p.hand[top]) top = c; });
    wanted[top] = true;
  }
  const pickIndex = function (allowLoco) {
    for (let i = 0; i < g.faceUp.length; i++) {
      const c = g.faceUp[i];
      if (c && c !== 'loco' && wanted[c]) return i;
    }
    if (allowLoco && plan.needed.length && Math.random() < 0.35) {
      const li = g.faceUp.indexOf('loco');
      if (li >= 0) return li;
    }
    return -1;
  };
  const drawOnce = function (first) {
    const idx = pickIndex(first);
    if (idx >= 0) return actDrawCard_(g, p, { source: 'faceUp', index: idx });
    if (g.deck.length + g.discard.length > 0) return actDrawCard_(g, p, { source: 'deck' });
    for (let i = 0; i < g.faceUp.length; i++) {
      if (g.faceUp[i] && (first || g.faceUp[i] !== 'loco')) return actDrawCard_(g, p, { source: 'faceUp', index: i });
    }
    return null;
  };
  const r1 = drawOnce(true);
  if (!r1) { forcePass_(g, p); return; }
  if (r1.turnEnded) return;
  const r2 = drawOnce(false);
  if (!r2) endTurn_(g);
}

/** CPU の目的地選択（initial=true は初期配布、2枚以上） */
function cpuChooseDestinations_(g, p, initial) {
  const scored = p.pendingDest.map(function (id) {
    const d = destById_(id);
    const res = dijkstra_(g, p.playerId, d.a, d.b);
    return { id: id, cost: res ? res.cost : Infinity };
  }).sort(function (x, y) { return x.cost - y.cost; });
  const min = initial ? Math.min(RULES.destInitKeep, scored.length) : 1;
  const budget = p.trainsLeft * 0.7;
  const keep = [];
  let total = 0;
  scored.forEach(function (s, i) {
    if (i < min || (s.cost !== Infinity && total + s.cost <= budget)) {
      keep.push(s.id);
      if (s.cost !== Infinity) total += s.cost;
    }
  });
  applyKeep_(g, p, keep);
}

/* =========================================================
 * 演出（Earth Studio 動画・Gemini ナレーション・TTS）
 * ========================================================= */
function buildFx_(r, completed) {
  const a = cityById_(r.a);
  const b = cityById_(r.b);
  return {
    from: { id: a.id, name: a.name, lat: a.lat, lng: a.lng },
    to: { id: b.id, name: b.name, lat: b.lat, lng: b.lng },
    flight: findFlight_(r.id) || (r.double ? findFlight_(r.double) : null),
    narrateKey: r.id + ':open',
    destinations: completed.map(function (d) { return { destId: d.destId, narrateKey: d.narrateKey, path: d.path }; })
  };
}

/** Driveの FLIGHT_FOLDER_ID 内にある flight_{routeId}.mp4 を探す */
function findFlight_(routeId) {
  try {
    return findFlightCore_(routeId);
  } catch (err) {
    console.error('findFlight failed: ' + err);
    return null;
  }
}

function findFlightCore_(routeId) {
  const folderId = prop_('FLIGHT_FOLDER_ID', '');
  if (!folderId) return null;
  const cache = CacheService.getScriptCache();
  let index = null;
  const cached = cache.get('flightIndex');
  if (cached) {
    index = JSON.parse(cached);
  } else {
    index = {};
    try {
      const it = DriveApp.getFolderById(folderId).getFiles();
      while (it.hasNext()) {
        const f = it.next();
        index[f.getName()] = f.getId();
      }
      cache.put('flightIndex', JSON.stringify(index), 3600);
    } catch (err) {
      console.error('flight folder error: ' + err);
      return null;
    }
  }
  const id = index['flight_' + routeId + '.mp4'];
  return id ? { fileId: id, previewUrl: 'https://drive.google.com/file/d/' + id + '/preview' } : null;
}

function apiNarrate_(req) {
  const key = String(req.key || '');
  const m = key.match(/^([A-Z0-9]+):(open|complete)$/);
  if (!m) fail_('BAD_KEY', 'key が不正です');
  const ctx = m[2] === 'open' ? routeContext_(m[1]) : destContext_(m[1]);
  if (!ctx) fail_('BAD_KEY', '対象が見つかりません');
  const season = season_();
  const cacheKey = key + ':' + season + ':' + NARRATION_CACHE_VER;

  const cached = findNarration_(cacheKey);
  if (cached) {
    const audio = audioFromFile_(cached.audioFileId);
    if (audio) return { key: key, text: cached.text, audioBase64: audio, mimeType: 'audio/wav', cached: true };
  }

  let text;
  try {
    text = generateNarration_(ctx, season);
  } catch (err) {
    console.error('narration text failed: ' + err);
    text = fallbackNarration_(ctx, season);
  }

  let audioBase64 = null;
  let fileId = '';
  try {
    const blob = synthesizeSpeech_(text);
    audioBase64 = Utilities.base64Encode(blob.getBytes());
    fileId = saveAudio_(blob, cacheKey);
  } catch (err) {
    console.error('TTS failed: ' + err);
  }
  if (fileId) {
    withLock_(function () {
      if (!findNarration_(cacheKey)) sheet_('NarrationCache').appendRow([cacheKey, safeCell_(text), fileId, nowIso_()]);
    });
  }
  return { key: key, text: text, audioBase64: audioBase64, mimeType: audioBase64 ? 'audio/wav' : null, cached: false };
}

function routeContext_(rid) {
  const r = routeById_(rid);
  if (!r) return null;
  return { event: 'route_open', from: cityById_(r.a), to: cityById_(r.b), length: r.length, type: r.type };
}

function destContext_(did) {
  const d = destById_(did);
  if (!d) return null;
  return { event: 'destination_complete', from: cityById_(d.a), to: cityById_(d.b), points: d.points };
}

function generateNarration_(ctx, season) {
  const f = ctx.from;
  const t = ctx.to;
  const lines = [];
  if (ctx.event === 'route_open') {
    lines.push('イベント: 路線開通');
    lines.push('区間: ' + f.name + '（' + f.pref + ', 緯度' + f.lat + ', 経度' + f.lng + '）→ ' + t.name + '（' + t.pref + ', 緯度' + t.lat + ', 経度' + t.lng + '）');
    lines.push('距離感: 路線長' + ctx.length + '（1=隣接〜6=長距離）');
    if (ctx.type === 'tunnel') lines.push('補足: 海峡をくぐるトンネル区間');
    if (ctx.type === 'ferry') lines.push('補足: 海を渡る航路区間');
  } else {
    lines.push('イベント: 目的地達成（自分の路線で' + f.name + 'から' + t.name + 'まで一本につながった）');
    lines.push('出発地: ' + f.name + '（' + f.pref + '） / 到着地: ' + t.name + '（' + t.pref + '）');
    lines.push('旅の長さ: ' + ctx.points + '区間ぶん');
  }
  lines.push('季節: ' + season);

  const raw = geminiText_(NARRATION_SYSTEM, lines.join('\n'));
  const obj = JSON.parse(raw.replace(/```json|```/g, '').trim());
  let text = String(obj.narration || '').replace(/\s+/g, '');
  if (text.length > 100) {
    const cut = text.lastIndexOf('。', 100);
    text = cut >= 40 ? text.slice(0, cut + 1) : text.slice(0, 99) + '。';
  }
  if (text.length < 20) throw new Error('narration too short');
  return text;
}

function fallbackNarration_(ctx, season) {
  if (ctx.event === 'route_open') {
    return ctx.from.name + 'から' + ctx.to.name + 'へ、新しいレールがつながりました。車窓には' + season + 'の景色がゆっくりと流れていきます。';
  }
  return ctx.from.name + 'から' + ctx.to.name + 'まで、ついに一本の線路でつながりました。長い旅路の終着駅で、' + season + 'の風が出迎えてくれます。';
}

function geminiText_(system, userText) {
  const apiKey = prop_('GEMINI_API_KEY', '');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const model = prop_('GEMINI_TEXT_MODEL', 'gemini-2.5-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.9, responseMimeType: 'application/json' }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const json = JSON.parse(res.getContentText());
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(function (pt) { return pt.text || ''; }).join('');
}

/** Gemini TTS → PCM(L16) を WAV に変換して Blob で返す */
function synthesizeSpeech_(text) {
  const apiKey = prop_('GEMINI_API_KEY', '');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const model = prop_('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const voice = prop_('GEMINI_TTS_VOICE', 'Charon');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const body = {
    // 指示文を混ぜると冒頭で読み上げられてしまうため、ナレーション本文だけを渡す
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('TTS ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const json = JSON.parse(res.getContentText());
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.map(function (pt) { return pt.inlineData; }).filter(function (x) { return x && x.data; })[0];
  if (!inline) throw new Error('TTS: no audio');
  const rateMatch = String(inline.mimeType || '').match(/rate=(\d+)/);
  const rate = rateMatch ? Number(rateMatch[1]) : 24000;
  const pcm = Utilities.base64Decode(inline.data);
  return Utilities.newBlob(pcmToWav_(pcm, rate), 'audio/wav', 'narration.wav');
}

function pcmToWav_(pcm, sampleRate) {
  const h = [];
  const str = function (s) { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = function (v) { h.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); };
  const u16 = function (v) { h.push(v & 255, (v >> 8) & 255); };
  str('RIFF'); u32(36 + pcm.length); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16);
  str('data'); u32(pcm.length);
  return h.map(function (b) { return b > 127 ? b - 256 : b; }).concat(pcm);
}

function saveAudio_(blob, cacheKey) {
  const folderId = prop_('NARRATION_FOLDER_ID', '');
  if (!folderId) return '';
  const name = 'narr_' + cacheKey.replace(/:/g, '_') + '.wav';
  return DriveApp.getFolderById(folderId).createFile(blob.copyBlob().setName(name)).getId();
}

function audioFromFile_(fileId) {
  if (!fileId) return null;
  try {
    return Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
  } catch (err) {
    return null;
  }
}

function findNarration_(cacheKey) {
  const sh = sheet_('NarrationCache');
  const f = sh.getRange('A:A').createTextFinder(cacheKey).matchEntireCell(true).findNext();
  if (!f) return null;
  const row = sh.getRange(f.getRow(), 1, 1, SHEETS.NarrationCache.length).getValues()[0];
  return { key: row[0], text: unsafeCell_(String(row[1])), audioFileId: row[2] };
}

function season_() {
  const m = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M'));
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}

/* =========================================================
 * カード・山札
 * ========================================================= */
function emptyHand_() {
  const h = { loco: 0 };
  CARD_COLORS.forEach(function (c) { h[c] = 0; });
  return h;
}

function handTotal_(h) {
  return Object.keys(h).reduce(function (s, k) { return s + h[k]; }, 0);
}

function buildDeck_() {
  const d = [];
  CARD_COLORS.forEach(function (c) { for (let i = 0; i < RULES.cardsPerColor; i++) d.push(c); });
  for (let i = 0; i < RULES.locoCount; i++) d.push('loco');
  return shuffle_(d);
}

function drawFromDeck_(g) {
  if (!g.deck.length && g.discard.length) {
    g.deck = shuffle_(g.discard);
    g.discard = [];
  }
  return g.deck.length ? g.deck.pop() : null;
}

/** 表向き5枚を補充。機関車が3枚以上並んだら総入れ替え */
function refillFaceUp_(g) {
  for (let i = 0; i < RULES.faceUpCount; i++) {
    if (!g.faceUp[i]) g.faceUp[i] = drawFromDeck_(g);
  }
  for (let guard = 0; guard < 5; guard++) {
    const locos = g.faceUp.filter(function (c) { return c === 'loco'; }).length;
    if (locos < 3) break;
    if (g.deck.length + g.discard.length < RULES.faceUpCount) break;
    g.faceUp.forEach(function (c) { if (c) g.discard.push(c); });
    g.faceUp = [];
    for (let i = 0; i < RULES.faceUpCount; i++) g.faceUp[i] = drawFromDeck_(g);
    addEvent_(g, { type: 'faceUpReset' });
  }
  for (let i = 0; i < RULES.faceUpCount; i++) if (!g.faceUp[i]) g.faceUp[i] = null;
}

function canDrawSecond_(g) {
  return g.deck.length + g.discard.length > 0 || g.faceUp.some(function (c) { return c && c !== 'loco'; });
}

function canDrawAny_(g) {
  return g.deck.length + g.discard.length > 0 || g.faceUp.some(function (c) { return !!c; });
}

/* =========================================================
 * ゲーム保存・共通ヘルパー
 * ========================================================= */
function loadGame_(gameId) {
  if (!gameId) fail_('NO_GAME', 'gameId を指定してください');
  const sh = sheet_('Games');
  const f = sh.getRange('A:A').createTextFinder(String(gameId)).matchEntireCell(true).findNext();
  if (!f) fail_('NO_GAME', 'ゲームが見つかりません');
  const row = f.getRow();
  const g = JSON.parse(sh.getRange(row, 5).getValue());
  if (g.status === 'closed') fail_('GAME_CLOSED', 'このゲームは解散しました');
  Object.defineProperty(g, '_row', { value: row, enumerable: false, writable: true });
  return g;
}

function saveGame_(g, isNew) {
  if (!isNew) g.version++;
  const json = JSON.stringify(g);
  if (json.length > 49000) fail_('STATE_TOO_LARGE', '状態データが大きすぎます');
  const vals = [g.gameId, g.status, g.hostId, g.version, json, g.createdAt, nowIso_()];
  const sh = sheet_('Games');
  if (isNew || !g._row) sh.appendRow(vals);
  else sh.getRange(g._row, 1, 1, vals.length).setValues([vals]);
}

function addEvent_(g, e) {
  g.eventSeq = (g.eventSeq || 0) + 1;
  e.seq = g.eventSeq;
  e.ts = Date.now();
  g.events.push(e);
  if (g.events.length > RULES.maxEvents) g.events = g.events.slice(-RULES.maxEvents);
}

function currentPlayer_(g) { return g.players[g.currentIdx]; }

function findPlayer_(g, pid) {
  return g.players.filter(function (p) { return p.playerId === pid; })[0] || null;
}

function requireMember_(g, pid) {
  const p = findPlayer_(g, pid);
  if (!p) fail_('NOT_IN_GAME', 'このゲームに参加していません');
  return p;
}

function requireHost_(g, uid) {
  if (g.hostId !== uid) fail_('NOT_HOST', 'ホストのみ操作できます');
}

function destInfo_(id) {
  const d = destById_(id);
  return { destId: d.id, a: d.a, b: d.b, aName: cityById_(d.a).name, bName: cityById_(d.b).name, points: d.points };
}

function getMapData_() {
  return {
    map: MAP,
    rules: { routePoints: ROUTE_POINTS, cardColors: CARD_COLORS, pieceColors: PIECE_COLORS, trainsByPlayers: RULES.trainsByPlayers, maxPlayers: RULES.maxPlayers }
  };
}

function log_(gameId, uid, action, detail) {
  try {
    sheet_('Log').appendRow([nowIso_(), gameId, uid, action, JSON.stringify(detail).slice(0, 5000)]);
  } catch (err) {
    console.error('log failed: ' + err);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('BUSY', '混み合っています。少し待って再試行してください');
  try { return fn(); } finally { lock.releaseLock(); }
}

let SS_CACHE_ = null;
function ss_() {
  if (SS_CACHE_) return SS_CACHE_;
  const id = prop_('SPREADSHEET_ID', '');
  SS_CACHE_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return SS_CACHE_;
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function prop_(key, def) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === undefined || v === '' ? def : v;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function shortId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(); }
function nowIso_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss"); }
function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function safeCell_(s) { s = String(s); return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unsafeCell_(s) { s = String(s); return s.charAt(0) === "'" ? s.slice(1) : s; }

/* =========================================================
 * 初期設定・動作確認（エディタから手動実行）
 * ========================================================= */
function setup() {
  Object.keys(SHEETS).forEach(function (n) { sheet_(n); });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!props.getProperty('NARRATION_FOLDER_ID')) {
    props.setProperty('NARRATION_FOLDER_ID', DriveApp.createFolder('tetsudo-no-tabi_narration').getId());
  }
  if (!props.getProperty('FLIGHT_FOLDER_ID')) {
    props.setProperty('FLIGHT_FOLDER_ID', DriveApp.createFolder('tetsudo-no-tabi_flight').getId());
  }
  console.log('セットアップ完了。スクリプトプロパティに GEMINI_API_KEY を設定してください。');
}

function testNarration() {
  const r = apiNarrate_({ key: 'R17:open' });
  console.log(r.text + ' / audio=' + (r.audioBase64 ? Math.round(r.audioBase64.length / 1024) + 'KB' : 'none'));
}

/** CPUのみでゲームを1回最後まで回すテスト（スプレッドシートには保存しない） */
function testCpuGame() {
  const g = newGameState_('CPU0', 'CPUテスト', 'テスト');
  g.players[0].isCpu = true;
  for (let i = 1; i < 4; i++) g.players.push(newPlayer_('CPU' + i, CPU_NAMES[i - 1], PIECE_COLORS[i], true));
  startGameCore_(g);
  for (let i = 0; i < 100 && g.status !== 'ended'; i++) runCpuTurns_(g);
  console.log(JSON.stringify(g.results));
}
