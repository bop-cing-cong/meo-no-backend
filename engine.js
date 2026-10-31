'use strict';

/**
 * MÈO NỔ — BỘ MÁY LUẬT PHÍA MÁY CHỦ (V3)
 *
 * Nguyên tắc an toàn:
 * - Máy chủ tạo bộ bài, xáo bài, rút bài và quyết định kết quả.
 * - Trình duyệt chỉ gửi ý định (đánh lá nào / chọn ai / chọn vị trí gỡ).
 * - Bài trên tay và 3 lá xem trước chỉ được gửi cho đúng người sở hữu.
 * - Fisher–Yates dùng crypto.randomInt, không dùng Math.random cho bộ bài.
 *
 * Bộ cơ bản được dựng theo danh mục 56 lá của bản Original Edition.
 * Các lá Streaking Kitten, Catomic Bomb, Super Skip, Draw From Bottom
 * và Imploding Kitten được bật bằng gói mở rộng, không làm sai xác suất bộ cơ bản.
 */

const { randomInt } = require('node:crypto');

const CARD_DEFS = Object.freeze({
  explode:      { name: 'Mèo Nổ', emoji: '💥', color: 'red', kind: 'danger', description: 'Rút trúng sẽ nổ và bị loại, trừ khi có Gỡ Bỏ.' },
  defuse:       { name: 'Gỡ Bỏ', emoji: '🧯', color: 'green', kind: 'defense', description: 'Cứu bạn khỏi Mèo Nổ. Bí mật đặt quả bom trở lại chồng rút.' },
  nope:         { name: 'Không Chịu', emoji: '🙅', color: 'purple', kind: 'reaction', description: 'Chặn một hành động trước khi hành động đó được thực hiện. Có thể chặn một lá Không Chịu khác.' },
  attack:       { name: 'Tấn Công', emoji: '⚔️', color: 'orange', kind: 'action', description: 'Kết thúc lượt và buộc người kế tiếp nhận 2 lượt (cộng lượt còn nợ nếu có).' },
  skip:         { name: 'Bỏ Lượt', emoji: '⏭️', color: 'blue', kind: 'action', description: 'Kết thúc một lượt mà không phải rút bài.' },
  favor:        { name: 'Thỉnh Cầu', emoji: '🙏', color: 'pink', kind: 'action', description: 'Chọn đối thủ; họ tự chọn một lá trên tay để trao cho bạn.' },
  shuffle:      { name: 'Xáo Bài', emoji: '🌀', color: 'violet', kind: 'action', description: 'Xáo trộn toàn bộ chồng bài rút bằng thuật toán Fisher–Yates.' },
  future:       { name: 'Nhìn Trước 3', emoji: '🔮', color: 'violet', kind: 'action', description: 'Bí mật xem 3 lá trên cùng, không đổi thứ tự.' },
  cat_beard:    { name: 'Mèo Râu', emoji: '🐈‍⬛', color: 'gold', kind: 'cat', description: 'Ghép đôi hoặc bộ ba với một lá cùng tên.' },
  cat_rainbow:  { name: 'Mèo Cầu Vồng', emoji: '🌈', color: 'pink', kind: 'cat', description: 'Ghép đôi hoặc bộ ba với một lá cùng tên.' },
  cat_potato:   { name: 'Mèo Khoai Tây', emoji: '🥔', color: 'gold', kind: 'cat', description: 'Ghép đôi hoặc bộ ba với một lá cùng tên.' },
  cat_melon:    { name: 'Mèo Dưa Hấu', emoji: '🍉', color: 'green', kind: 'cat', description: 'Ghép đôi hoặc bộ ba với một lá cùng tên.' },
  cat_taco:     { name: 'Mèo Taco', emoji: '🌮', color: 'orange', kind: 'cat', description: 'Ghép đôi hoặc bộ ba với một lá cùng tên.' },
  bottom:       { name: 'Rút Từ Đáy', emoji: '🪝', color: 'teal', kind: 'action', description: 'Kết thúc lượt bằng lá ở đáy chồng rút.' },
  streaking:    { name: 'Mèo Giữ Bom', emoji: '🧨', color: 'red', kind: 'special', description: 'Khi giữ lá này, bạn có thể bí mật giữ một Mèo Nổ trên tay.' },
  catomic:      { name: 'Bom Mèo', emoji: '☢️', color: 'red', kind: 'action', description: 'Gom mọi Mèo Nổ trong chồng rút, xáo phần còn lại rồi đặt các quả bom lên đầu.' },
  super_skip:   { name: 'Bỏ Hết Lượt', emoji: '⏩', color: 'blue', kind: 'action', description: 'Kết thúc toàn bộ lượt đang nợ mà không cần rút bài.' },
  imploding:    { name: 'Mèo Nổ Đen', emoji: '🌑', color: 'dark', kind: 'danger', description: 'Lần đầu rút phải lật ngửa và đặt lại sâu trong chồng bài; lần sau rút trúng sẽ nổ, không thể Gỡ Bỏ.' }
});

// Tổng đúng 56 lá của bộ cơ bản: 4 bom + 6 gỡ + 26 chức năng + 20 mèo.
const BASE_COUNTS = Object.freeze({
  explode: 4,
  defuse: 6,
  nope: 5,
  attack: 4,
  skip: 4,
  favor: 4,
  shuffle: 4,
  future: 5,
  cat_beard: 4,
  cat_rainbow: 4,
  cat_potato: 4,
  cat_melon: 4,
  cat_taco: 4
});

const EXPANSION_COUNTS = Object.freeze({
  explode: 1,       // lá Mèo Nổ bổ sung đi cùng Streaking Kitten
  streaking: 1,
  catomic: 1,
  super_skip: 1,
  bottom: 1,
  imploding: 1
});

const TURN_MS = 40_000;
const REACTION_MS = 5_000;
const DECISION_MS = 12_000;

function randomIndex(length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  return randomInt(length);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function makeCard(type, serial) {
  const def = CARD_DEFS[type];
  if (!def) throw new Error('Loại lá bài không hợp lệ: ' + type);
  return { id: 'c-' + serial, type, name: def.name, emoji: def.emoji, faceUp: false };
}

function addLog(state, text, options = {}) {
  const entry = {
    id: state.nextLogId++,
    text,
    time: Date.now(),
    playerId: options.playerId || null,
    cardType: options.cardType || null,
    tactic: options.tactic || 'diễn biến',
    signal: options.signal || 'neutral'
  };
  state.log.push(entry);
  state.timeline.push({ id: entry.id, text, tactic: entry.tactic, signal: entry.signal, time: entry.time });
  if (state.log.length > 90) state.log.splice(0, state.log.length - 90);
  if (state.timeline.length > 12) state.timeline.splice(0, state.timeline.length - 12);
  return entry;
}

function addChat(state, who, text, mood = '😼', kind = 'bot') {
  state.chat.push({ id: state.nextChatId++, who, text: String(text).slice(0, 150), mood, kind, time: Date.now() });
  if (state.chat.length > 28) state.chat.splice(0, state.chat.length - 28);
}

function getPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId) || null;
}

function alivePlayers(state) {
  return state.players.filter((player) => player.alive);
}

function nextAlivePlayer(state, playerId) {
  const start = state.players.findIndex((player) => player.id === playerId);
  if (start < 0) return null;
  for (let step = 1; step <= state.players.length; step += 1) {
    const candidate = state.players[(start + step) % state.players.length];
    if (candidate && candidate.alive) return candidate;
  }
  return null;
}

function setTurnDeadline(state, duration = TURN_MS) {
  state.deadline = Date.now() + duration;
}

function checkWinner(state) {
  const survivors = alivePlayers(state);
  if (survivors.length <= 1) {
    state.status = 'finished';
    state.winnerId = survivors[0] ? survivors[0].id : null;
    state.activeId = state.winnerId;
    state.turnsLeft = 0;
    state.deadline = null;
    state.pendingAction = null;
    state.pendingFavor = null;
    state.pendingExplosion = null;
    if (survivors[0]) {
      addLog(state, '🏆 ' + survivors[0].name + ' là người sống sót cuối cùng và chiến thắng!', { playerId: survivors[0].id, tactic: 'chiến thắng', signal: 'safe' });
      addChat(state, 'Bàn mèo', 'Một người đã trụ lại đến cuối cùng. Vinh quang thuộc về ' + survivors[0].name + '!', '🎉', 'system');
    } else {
      addLog(state, 'Ván chơi kết thúc mà không còn người chiến thắng.', { tactic: 'kết quả', signal: 'danger' });
    }
    return true;
  }
  return false;
}

function finishOneTurn(state) {
  if (state.status !== 'playing') return;
  state.turnNo += 1;
  state.turnsLeft = Math.max(0, state.turnsLeft - 1);
  if (state.turnsLeft > 0) {
    const player = getPlayer(state, state.activeId);
    addLog(state, player.name + ' vẫn còn ' + state.turnsLeft + ' lượt phải hoàn thành.', { playerId: player.id, tactic: 'bị dồn lượt', signal: 'warning' });
    setTurnDeadline(state);
    return;
  }
  const next = nextAlivePlayer(state, state.activeId);
  if (!next) {
    checkWinner(state);
    return;
  }
  state.activeId = next.id;
  state.turnsLeft = 1;
  setTurnDeadline(state);
  addLog(state, 'Đến lượt ' + next.name + '.', { playerId: next.id, tactic: 'đổi lượt', signal: 'neutral' });
}

function removeFromHand(player, cardId) {
  const index = player.hand.findIndex((card) => card.id === cardId);
  if (index < 0) return null;
  return player.hand.splice(index, 1)[0];
}

function moveToDiscard(state, card) {
  if (card) state.discard.push(card);
}

function hasCard(player, type) {
  return player.hand.some((card) => card.type === type);
}

function noteAction(state, player, type, tactic, signal = 'neutral') {
  player.stats.actions += 1;
  if (['future', 'shuffle', 'skip', 'attack', 'super_skip', 'catomic'].includes(type)) player.stats.control += 1;
  if (['attack', 'favor'].includes(type)) player.stats.pressure += 1;
  if (type.startsWith('cat_')) player.stats.combo += 1;
  player.stats.lastAction = type;
  player.stats.lastTactic = tactic;
  player.mood = signal === 'danger' ? '😬' : signal === 'safe' ? '😎' : '😼';
}

function strategyLabel(player) {
  if (player.stats.pressure >= 2 && player.stats.pressure >= player.stats.control) return 'Gây áp lực';
  if (player.stats.control >= 2) return 'Thận trọng';
  if (player.stats.combo >= 1) return 'Chơi tổ hợp';
  if (player.stats.riskyDraws >= 2) return 'Liều lĩnh';
  return 'Đang thăm dò';
}

function createGame(playerSpecs, options = {}) {
  if (!Array.isArray(playerSpecs) || playerSpecs.length < 2 || playerSpecs.length > 5) {
    throw new Error('Một ván cần từ 2 đến 5 người chơi.');
  }
  const ids = playerSpecs.map((spec, index) => String(spec.id || ('player-' + (index + 1))));
  if (new Set(ids).size !== ids.length) throw new Error('Mã người chơi bị trùng.');

  const players = playerSpecs.map((spec, index) => ({
    id: ids[index],
    name: String(spec.name || ('Người chơi ' + (index + 1))).replace(/[<>\u0000-\u001F]/g, '').slice(0, 20),
    isBot: Boolean(spec.isBot),
    alive: true,
    hand: [],
    mood: '😼',
    bubble: '',
    stats: { actions: 0, control: 0, pressure: 0, combo: 0, riskyDraws: 0, peekedTurn: 0, lastAction: null, lastTactic: 'Đang quan sát' }
  }));

  const expansion = Boolean(options.expansions);
  const counts = Object.assign({}, BASE_COUNTS);
  if (expansion) Object.entries(EXPANSION_COUNTS).forEach(([type, amount]) => { counts[type] = (counts[type] || 0) + amount; });

  let serial = 1;
  const completeDeck = [];
  Object.entries(counts).forEach(([type, amount]) => {
    for (let i = 0; i < amount; i += 1) completeDeck.push(makeCard(type, serial++));
  });

  const defuses = completeDeck.filter((card) => card.type === 'defuse');
  const bombs = completeDeck.filter((card) => card.type === 'explode');
  const imploding = completeDeck.filter((card) => card.type === 'imploding');
  let drawDeck = completeDeck.filter((card) => !['defuse', 'explode', 'imploding'].includes(card.type));

  // Mỗi người có đúng 1 Gỡ Bỏ và 4 lá ngẫu nhiên từ nhóm bài còn lại.
  players.forEach((player) => player.hand.push(defuses.pop()));
  shuffleArray(drawDeck);
  players.forEach((player) => {
    for (let i = 0; i < 4; i += 1) player.hand.push(drawDeck.pop());
  });

  // Bộ cơ bản: số bom = số người - 1. Nếu có Streaking Kitten, dùng số bom = số người.
  const bombCount = expansion ? players.length : players.length - 1;
  const activeBombs = bombs.slice(0, bombCount);
  drawDeck = drawDeck.concat(defuses, activeBombs, imploding);
  shuffleArray(drawDeck);

  const state = {
    players,
    deck: drawDeck,
    discard: [],
    activeId: players[0].id,
    turnsLeft: 1,
    turnNo: 1,
    pendingAction: null,
    pendingExplosion: null,
    pendingFavor: null,
    privatePeek: Object.create(null),
    status: 'playing',
    winnerId: null,
    expansions: expansion,
    deadline: null,
    log: [],
    timeline: [],
    chat: [],
    nextLogId: 1,
    nextChatId: 1,
    nextActionId: 1,
    createdAt: Date.now()
  };
  setTurnDeadline(state);
  addLog(state, 'Ván mới bắt đầu với ' + players.length + ' người. Máy chủ đã tạo và xáo bộ bài.', { tactic: 'khởi tạo', signal: 'safe' });
  addLog(state, 'Mỗi người nhận 1 Gỡ Bỏ và 4 lá ngẫu nhiên. Không có Mèo Nổ trong tay khởi đầu.', { tactic: 'chia bài', signal: 'safe' });
  addChat(state, 'Bàn mèo', expansion ? 'Gói mở rộng đã bật. Đừng tin bất kỳ lá mèo nào!' : 'Bộ Cổ điển 56 lá đã sẵn sàng. Móng vuốt đâu rồi?', '🐾', 'system');
  return state;
}

function ensureCanAct(state, playerId) {
  if (state.status !== 'playing') return { ok: false, message: 'Ván chơi đã kết thúc.' };
  if (state.pendingAction) return { ok: false, message: 'Đang chờ phản hồi Không Chịu.' };
  if (state.pendingExplosion) return { ok: false, message: 'Hãy xử lý Mèo Nổ trước.' };
  if (state.pendingFavor) return { ok: false, message: 'Đang chờ người được Thỉnh Cầu chọn bài.' };
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return { ok: false, message: 'Bạn không còn trong ván.' };
  if (state.activeId !== playerId) return { ok: false, message: 'Chưa đến lượt của bạn.' };
  return { ok: true, player };
}

function createPendingAction(state, actor, card, payload) {
  state.pendingAction = {
    id: state.nextActionId++,
    actorId: actor.id,
    cardType: card.type,
    cardName: card.name,
    payload: payload || {},
    nopeCount: 0,
    lastNopeId: null,
    expiresAt: Date.now() + REACTION_MS
  };
  setTurnDeadline(state, REACTION_MS);
  addLog(state, actor.name + ' đã đánh ' + card.name + '. Đang mở cửa sổ phản hồi Không Chịu.', {
    playerId: actor.id, cardType: card.type, tactic: 'đánh ' + card.name, signal: ['attack', 'favor', 'catomic'].includes(card.type) ? 'warning' : 'neutral'
  });
}

function playCard(state, playerId, cardId, targetId) {
  const check = ensureCanAct(state, playerId);
  if (!check.ok) return check;
  const player = check.player;
  const card = player.hand.find((item) => item.id === String(cardId));
  if (!card) return { ok: false, message: 'Không tìm thấy lá bài trên tay bạn.' };
  const type = card.type;
  if (!['attack', 'skip', 'favor', 'shuffle', 'future', 'bottom', 'catomic', 'super_skip'].includes(type)) {
    return { ok: false, message: 'Lá này không thể đánh riêng lẻ. Hãy ghép bài hoặc dùng đúng tình huống.' };
  }
  if (type === 'favor') {
    const target = getPlayer(state, String(targetId || ''));
    if (!target || !target.alive || target.id === playerId) return { ok: false, message: 'Hãy chọn một đối thủ còn sống.' };
  }

  removeFromHand(player, card.id);
  moveToDiscard(state, card);
  let tactic = 'sử dụng hành động';
  if (type === 'future') tactic = 'do thám chồng bài';
  else if (type === 'shuffle') tactic = 'làm nhiễu xác suất';
  else if (type === 'attack') tactic = 'gây áp lực lên người kế tiếp';
  else if (type === 'skip' || type === 'super_skip') tactic = 'né lượt rút';
  else if (type === 'favor') tactic = 'thu thập tài nguyên';
  else if (type === 'catomic') tactic = 'đẩy bom về đầu chồng';
  noteAction(state, player, type, tactic, type === 'attack' || type === 'catomic' ? 'danger' : 'safe');
  createPendingAction(state, player, card, { targetId: targetId || null });
  return { ok: true, message: 'Đã đánh ' + card.name + '. Đang chờ cửa sổ phản hồi.', waitingForReaction: true };
}

function validateCombo(state, player, cardIds, targetId, requestedType) {
  if (!Array.isArray(cardIds) || (cardIds.length !== 2 && cardIds.length !== 3)) return { ok: false, message: 'Chọn đúng 2 hoặc 3 lá cùng tên.' };
  if (new Set(cardIds).size !== cardIds.length) return { ok: false, message: 'Không thể chọn trùng một lá bài.' };
  const selected = cardIds.map((id) => player.hand.find((card) => card.id === String(id)));
  if (selected.some((card) => !card)) return { ok: false, message: 'Có lá bài không còn trên tay bạn.' };
  const type = selected[0].type;
  if (selected.some((card) => card.type !== type) || ['explode', 'imploding', 'streaking'].includes(type)) {
    return { ok: false, message: 'Các lá phải cùng tên và không được là Mèo Nổ / Mèo Nổ Đen / Mèo Giữ Bom.' };
  }
  const target = getPlayer(state, String(targetId || ''));
  if (!target || !target.alive || target.id === player.id) return { ok: false, message: 'Hãy chọn một đối thủ còn sống.' };
  if (cardIds.length === 3 && (!requestedType || !CARD_DEFS[requestedType] || ['explode', 'imploding', 'streaking'].includes(requestedType))) {
    return { ok: false, message: 'Hãy gọi tên một loại bài hợp lệ.' };
  }
  return { ok: true, selected, type, target };
}

function playCombo(state, playerId, cardIds, targetId, requestedType) {
  const check = ensureCanAct(state, playerId);
  if (!check.ok) return check;
  const player = check.player;
  const valid = validateCombo(state, player, cardIds, targetId, requestedType);
  if (!valid.ok) return valid;
  valid.selected.forEach((card) => {
    removeFromHand(player, card.id);
    moveToDiscard(state, card);
  });
  noteAction(state, player, valid.type, cardIds.length === 2 ? 'ghép đôi để cướp ngẫu nhiên' : 'ghép bộ ba để gọi tên lá bài', 'warning');
  createPendingAction(state, player, { type: 'combo', name: cardIds.length === 2 ? 'Bộ đôi ' + valid.selected[0].name : 'Bộ ba ' + valid.selected[0].name }, {
    comboType: cardIds.length === 2 ? 2 : 3,
    cardType: valid.type,
    targetId: valid.target.id,
    requestedType: requestedType || null
  });
  return { ok: true, message: 'Đã đánh tổ hợp. Đang chờ phản hồi Không Chịu.', waitingForReaction: true };
}

function playNope(state, playerId, cardId) {
  if (!state.pendingAction || state.status !== 'playing') return { ok: false, message: 'Hiện không có hành động nào để chặn.' };
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return { ok: false, message: 'Bạn không còn trong ván.' };
  if (state.pendingAction.actorId === playerId && state.pendingAction.nopeCount === 0) {
    return { ok: false, message: 'Bạn không thể tự chặn hành động của chính mình.' };
  }
  const card = player.hand.find((item) => item.id === String(cardId) && item.type === 'nope');
  if (!card) return { ok: false, message: 'Bạn không có lá Không Chịu hợp lệ.' };
  removeFromHand(player, card.id);
  moveToDiscard(state, card);
  state.pendingAction.nopeCount += 1;
  state.pendingAction.lastNopeId = playerId;
  state.pendingAction.expiresAt = Date.now() + REACTION_MS;
  setTurnDeadline(state, REACTION_MS);
  player.mood = '😼';
  addLog(state, player.name + ' tung Không Chịu! ' + (state.pendingAction.nopeCount % 2 ? 'Hành động đang bị chặn.' : 'Lá Không Chịu trước đó bị vô hiệu.'), {
    playerId, cardType: 'nope', tactic: 'phản đòn Không Chịu', signal: 'warning'
  });
  addChat(state, player.name, state.pendingAction.nopeCount % 2 ? 'Không nha! 🙅' : 'YUP! Tôi chặn lại lá chặn đó!', '🙅', player.isBot ? 'bot' : 'player');
  return { ok: true, message: 'Đã đánh Không Chịu.' };
}

function triggerExplosion(state, player, bombCard, reason = 'bốc trúng Mèo Nổ') {
  if (!player || !player.alive) return { ok: false, message: 'Người chơi không còn trong ván.' };
  if (hasCard(player, 'defuse')) {
    state.pendingExplosion = { playerId: player.id, bombCard, reason, expiresAt: Date.now() + DECISION_MS };
    setTurnDeadline(state, DECISION_MS);
    player.mood = '😱';
    player.bubble = 'ÁÁÁ! Có bom!';
    addLog(state, player.name + ' gặp Mèo Nổ. Có thể dùng Gỡ Bỏ để sống sót.', { playerId: player.id, cardType: bombCard.type, tactic: 'đối mặt bom', signal: 'danger' });
    return { ok: true, message: 'Có Mèo Nổ! Hãy dùng Gỡ Bỏ.', needsDefuse: true };
  }
  moveToDiscard(state, bombCard);
  eliminatePlayer(state, player.id, reason);
  return { ok: true, message: player.name + ' đã bị loại.', eliminated: true };
}

function transferCard(state, fromPlayer, toPlayer, card) {
  if (!fromPlayer || !toPlayer || !card) return;
  fromPlayer.hand = fromPlayer.hand.filter((item) => item.id !== card.id);
  toPlayer.hand.push(card);
  if (card.type === 'explode') {
    if (!(hasCard(toPlayer, 'streaking') && toPlayer.hand.filter((item) => item.type === 'explode').length === 1)) {
      toPlayer.hand = toPlayer.hand.filter((item) => item.id !== card.id);
      triggerExplosion(state, toPlayer, card, 'bị trao Mèo Nổ và không có Mèo Giữ Bom');
    }
  }
  if (card.type === 'streaking') {
    const heldBomb = fromPlayer.hand.find((item) => item.type === 'explode');
    if (heldBomb && !hasCard(fromPlayer, 'streaking')) {
      fromPlayer.hand = fromPlayer.hand.filter((item) => item.id !== heldBomb.id);
      triggerExplosion(state, fromPlayer, heldBomb, 'mất Mèo Giữ Bom khi đang giữ Mèo Nổ');
    }
  }
}

function resolvePendingAction(state) {
  const pending = state.pendingAction;
  if (!pending || state.status !== 'playing') return { ok: false, message: 'Không có hành động đang chờ.' };
  state.pendingAction = null;
  if (pending.nopeCount % 2 === 1) {
    const actor = getPlayer(state, pending.actorId);
    addLog(state, 'Hành động ' + pending.cardName + ' của ' + (actor ? actor.name : 'người chơi') + ' đã bị Không Chịu hủy.', {
      playerId: pending.actorId, cardType: pending.cardType, tactic: 'bị chặn', signal: 'safe'
    });
    if (actor) { actor.mood = '😾'; actor.bubble = 'Ủa? Bị chặn rồi!'; }
    setTurnDeadline(state);
    return { ok: true, canceled: true };
  }
  if (pending.nopeCount > 0) addLog(state, 'Các lá Không Chịu đã triệt tiêu lẫn nhau. Hành động được tiếp tục.', { tactic: 'đấu trí', signal: 'neutral' });

  const actor = getPlayer(state, pending.actorId);
  if (!actor || !actor.alive) return { ok: false, message: 'Người đánh bài không còn trong ván.' };
  const type = pending.cardType;
  const payload = pending.payload || {};

  if (pending.cardType === 'combo') {
    const target = getPlayer(state, payload.targetId);
    if (!target || !target.alive) {
      addLog(state, 'Tổ hợp không có mục tiêu hợp lệ.', { playerId: actor.id, tactic: 'tổ hợp thất bại' });
      setTurnDeadline(state);
      return { ok: true };
    }
    if (payload.comboType === 2) {
      if (!target.hand.length) addLog(state, actor.name + ' ghép đôi nhưng ' + target.name + ' không còn bài để cướp.', { playerId: actor.id, tactic: 'ghép đôi hụt' });
      else {
        const stolen = target.hand[randomIndex(target.hand.length)];
        transferCard(state, target, actor, stolen);
        addLog(state, actor.name + ' ghép đôi ' + CARD_DEFS[payload.cardType].name + ', cướp ngẫu nhiên 1 lá từ ' + target.name + '.', { playerId: actor.id, cardType: payload.cardType, tactic: 'cướp bài bằng ghép đôi', signal: 'warning' });
      }
    } else {
      const index = target.hand.findIndex((card) => card.type === payload.requestedType);
      if (index < 0) addLog(state, actor.name + ' gọi ' + CARD_DEFS[payload.requestedType].name + ' từ ' + target.name + ' nhưng đối thủ không có lá đó.', { playerId: actor.id, tactic: 'ghép bộ ba hụt' });
      else {
        const stolen = target.hand[index];
        transferCard(state, target, actor, stolen);
        addLog(state, actor.name + ' ghép bộ ba, gọi lá ' + CARD_DEFS[payload.requestedType].name + ' từ ' + target.name + ' và nhận được.', { playerId: actor.id, tactic: 'gọi bài bằng ghép bộ ba', signal: 'warning' });
      }
    }
    if (state.status === 'playing') setTurnDeadline(state);
    return { ok: true };
  }

  if (type === 'skip') {
    addLog(state, actor.name + ' dùng Bỏ Lượt: kết thúc 1 lượt mà không rút.', { playerId: actor.id, cardType: type, tactic: 'né lượt rút', signal: 'safe' });
    finishOneTurn(state);
  } else if (type === 'super_skip') {
    const skipped = state.turnsLeft;
    state.turnsLeft = 1;
    addLog(state, actor.name + ' dùng Bỏ Hết Lượt, bỏ qua toàn bộ ' + skipped + ' lượt còn nợ.', { playerId: actor.id, cardType: type, tactic: 'né toàn bộ lượt rút', signal: 'safe' });
    finishOneTurn(state);
  } else if (type === 'attack') {
    const next = nextAlivePlayer(state, actor.id);
    if (!next) { checkWinner(state); return { ok: true }; }
    const forcedTurns = Math.max(2, state.turnsLeft + 1);
    state.activeId = next.id;
    state.turnNo += 1;
    state.turnsLeft = forcedTurns;
    setTurnDeadline(state);
    addLog(state, actor.name + ' Tấn Công ' + next.name + '! Đối thủ phải hoàn thành ' + forcedTurns + ' lượt liên tiếp.', { playerId: actor.id, cardType: type, tactic: 'dồn lượt sang đối thủ', signal: 'danger' });
    next.mood = '😾'; next.bubble = 'Sao lại là tôi?!';
  } else if (type === 'future') {
    const cards = state.deck.slice(0, 3).map((card) => ({ type: card.type, name: card.name, emoji: card.emoji, faceUp: card.faceUp }));
    state.privatePeek[actor.id] = { cards, expiresAt: Date.now() + 3_000 };
    addLog(state, actor.name + ' dùng Nhìn Trước 3 để kiểm tra ba lá đầu (chỉ họ nhìn thấy kết quả).', { playerId: actor.id, cardType: type, tactic: 'do thám chồng bài', signal: 'safe' });
    actor.mood = '🧐'; actor.bubble = 'Để xem tương lai nào…';
    setTurnDeadline(state);
  } else if (type === 'shuffle') {
    shuffleArray(state.deck);
    addLog(state, actor.name + ' dùng Xáo Bài; toàn bộ chồng rút đã được trộn lại.', { playerId: actor.id, cardType: type, tactic: 'xóa lợi thế biết trước', signal: 'neutral' });
    actor.mood = '🌀'; actor.bubble = 'Mọi thứ đảo lộn!';
    setTurnDeadline(state);
  } else if (type === 'bottom') {
    addLog(state, actor.name + ' dùng Rút Từ Đáy và phải rút lá dưới cùng để kết thúc lượt.', { playerId: actor.id, cardType: type, tactic: 'đổi hướng rút bài', signal: 'neutral' });
    return drawCard(state, actor.id, true);
  } else if (type === 'favor') {
    const target = getPlayer(state, payload.targetId);
    if (!target || !target.alive || target.id === actor.id || target.hand.length === 0) {
      addLog(state, actor.name + ' dùng Thỉnh Cầu nhưng mục tiêu không còn bài để trao.', { playerId: actor.id, cardType: type, tactic: 'thỉnh cầu hụt' });
      setTurnDeadline(state);
    } else {
      state.pendingFavor = { actorId: actor.id, targetId: target.id, expiresAt: Date.now() + DECISION_MS };
      setTurnDeadline(state, DECISION_MS);
      target.mood = '🤔'; target.bubble = 'Đưa lá nào đây nhỉ…';
      addLog(state, actor.name + ' Thỉnh Cầu ' + target.name + ': chọn một lá trên tay để trao.', { playerId: actor.id, cardType: type, tactic: 'chờ đối thủ chọn bài', signal: 'warning' });
    }
  } else if (type === 'catomic') {
    const bombs = state.deck.filter((card) => card.type === 'explode');
    state.deck = state.deck.filter((card) => card.type !== 'explode');
    shuffleArray(state.deck);
    shuffleArray(bombs);
    state.deck = bombs.concat(state.deck);
    addLog(state, actor.name + ' kích hoạt Bom Mèo: gom ' + bombs.length + ' Mèo Nổ, xáo phần còn lại rồi đặt bom lên đầu chồng rút.', { playerId: actor.id, cardType: type, tactic: 'đẩy rủi ro lên đỉnh', signal: 'danger' });
    actor.mood = '😈'; actor.bubble = 'Mèo nào muốn thử vận may?';
    finishOneTurn(state);
  }
  return { ok: true };
}

function drawCard(state, playerId, fromBottom = false, options = {}) {
  const check = options.automatic ? { ok: true, player: getPlayer(state, playerId) } : ensureCanAct(state, playerId);
  if (!check.ok) return check;
  const player = check.player;
  if (!player || !player.alive) return { ok: false, message: 'Người chơi không còn trong ván.' };

  if (!state.deck.length) {
    const recyclable = state.discard.filter((card) => !['explode', 'imploding'].includes(card.type));
    state.discard = state.discard.filter((card) => ['explode', 'imploding'].includes(card.type));
    if (recyclable.length) {
      state.deck = shuffleArray(recyclable);
      addLog(state, 'Chồng rút cạn. Máy chủ trộn lại các lá đã đánh (không đưa bom đã nổ trở lại).', { tactic: 'tái tạo chồng bài', signal: 'neutral' });
    }
  }
  if (!state.deck.length) return { ok: false, message: 'Không còn lá bài nào có thể rút.' };

  const beforeRisk = getBombDensity(state);
  const card = fromBottom ? state.deck.pop() : state.deck.shift();
  if (options.automatic) addLog(state, player.name + ' hết giờ; máy chủ tự rút một lá.', { playerId, tactic: 'hết giờ', signal: 'warning' });

  if (card.type === 'explode') {
    if (hasCard(player, 'streaking') && !hasCard(player, 'explode')) {
      player.hand.push(card);
      player.mood = '😎'; player.bubble = 'Tôi giữ được quả bom!';
      // Không công khai việc người chơi đang bí mật giữ Exploding Kitten bằng Streaking Kitten.
      addLog(state, player.name + ' rút một lá nguy hiểm nhưng vẫn sống sót nhờ hiệu ứng bảo vệ.', { playerId, tactic: 'bảo vệ đặc biệt', signal: 'warning' });
      finishOneTurn(state);
      return { ok: true, message: 'Mèo Giữ Bom đã bảo vệ bạn.', heldBomb: true };
    }
    addLog(state, player.name + ' rút trúng Mèo Nổ!', { playerId, cardType: 'explode', tactic: 'rút trúng bom', signal: 'danger' });
    player.stats.riskyDraws += beforeRisk > 0.12 ? 1 : 0;
    return triggerExplosion(state, player, card, 'rút trúng Mèo Nổ mà không có Gỡ Bỏ');
  }

  if (card.type === 'imploding') {
    if (card.faceUp) {
      addLog(state, player.name + ' rút trúng Mèo Nổ Đen đã lật ngửa. Không thể dùng Gỡ Bỏ!', { playerId, cardType: 'imploding', tactic: 'chạm bom đếm ngược', signal: 'danger' });
      moveToDiscard(state, card);
      eliminatePlayer(state, player.id, 'rút trúng Mèo Nổ Đen đã lật ngửa');
      return { ok: true, message: 'Mèo Nổ Đen phát nổ. Không thể Gỡ Bỏ.', eliminated: true, imploded: true };
    }
    card.faceUp = true;
    const position = Math.min(7, state.deck.length);
    state.deck.splice(position, 0, card);
    addLog(state, player.name + ' rút Mèo Nổ Đen lần đầu. Lá bài đã lật ngửa và được đặt lại ở vị trí thứ ' + (position + 1) + '.', { playerId, cardType: 'imploding', tactic: 'kích hoạt đếm ngược', signal: 'warning' });
    player.mood = '😳'; player.bubble = 'Nó đang đếm ngược…';
    finishOneTurn(state);
    return { ok: true, message: 'Mèo Nổ Đen đã bắt đầu đếm ngược.', countdown: true };
  }

  player.hand.push(card);
  // Không đưa tên lá vừa rút vào nhật ký công khai: bài trên tay phải được giữ bí mật.
  addLog(state, player.name + ' rút một lá bài mới.', { playerId, tactic: 'rút bài', signal: beforeRisk > 0.12 ? 'warning' : 'safe' });
  if (options.automatic) player.mood = '😅';
  finishOneTurn(state);
  return { ok: true, message: 'Đã rút ' + card.name + '.', drawn: { type: card.type, name: card.name } };
}

function eliminatePlayer(state, playerId, reason) {
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return;
  player.alive = false;
  player.mood = '💀';
  player.bubble = 'Tôi… đã nổ…';
  player.hand.forEach((card) => moveToDiscard(state, card));
  player.hand = [];
  if (state.pendingExplosion && state.pendingExplosion.playerId === playerId) state.pendingExplosion = null;
  if (state.pendingFavor && (state.pendingFavor.actorId === playerId || state.pendingFavor.targetId === playerId)) state.pendingFavor = null;
  addLog(state, '💥 ' + player.name + ' ' + reason + ' và bị loại khỏi ván.', { playerId, tactic: 'bị loại', signal: 'danger' });
  addChat(state, player.name, 'Tôi sẽ quay lại… trong một ván khác!', '💀', player.isBot ? 'bot' : 'player');
  if (checkWinner(state)) return;
  if (state.activeId === playerId) {
    const next = nextAlivePlayer(state, playerId);
    state.activeId = next ? next.id : null;
    state.turnsLeft = next ? 1 : 0;
    if (next) setTurnDeadline(state);
  }
}

function resolveDefuse(state, playerId, placement, customIndex) {
  const pending = state.pendingExplosion;
  if (!pending || pending.playerId !== playerId) return { ok: false, message: 'Không có Mèo Nổ đang chờ bạn xử lý.' };
  if (pending.bombCard.type === 'imploding') return { ok: false, message: 'Mèo Nổ Đen đã lật ngửa không thể Gỡ Bỏ.' };
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return { ok: false, message: 'Bạn không còn trong ván.' };
  const defuseIndex = player.hand.findIndex((card) => card.type === 'defuse');
  if (defuseIndex < 0) return { ok: false, message: 'Bạn không có lá Gỡ Bỏ.' };

  let index;
  if (placement === 'top') index = 0;
  else if (placement === 'bottom') index = state.deck.length;
  else if (placement === 'random') index = randomIndex(state.deck.length + 1);
  else if (placement === 'custom') {
    const parsed = Number(customIndex);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > state.deck.length) return { ok: false, message: 'Vị trí đặt không hợp lệ.' };
    index = parsed;
  } else return { ok: false, message: 'Hãy chọn đầu, đáy, ngẫu nhiên hoặc vị trí chỉ định.' };

  const defuse = player.hand.splice(defuseIndex, 1)[0];
  moveToDiscard(state, defuse);
  state.deck.splice(index, 0, pending.bombCard);
  state.pendingExplosion = null;
  const placeText = index === 0 ? 'đầu chồng bài' : index >= state.deck.length - 1 ? 'đáy chồng bài' : 'vị trí số ' + (index + 1);
  addLog(state, player.name + ' dùng Gỡ Bỏ và bí mật đặt Mèo Nổ vào ' + placeText + '.', { playerId, cardType: 'defuse', tactic: 'cứu nguy bằng Gỡ Bỏ', signal: 'safe' });
  player.mood = '😮‍💨'; player.bubble = 'Phù… suýt nữa!';
  finishOneTurn(state);
  return { ok: true, message: 'Bạn đã sống sót!' };
}

function resolveFavor(state, targetId, cardId) {
  const pending = state.pendingFavor;
  if (!pending || pending.targetId !== targetId) return { ok: false, message: 'Không có lời Thỉnh Cầu dành cho bạn.' };
  const target = getPlayer(state, targetId);
  const actor = getPlayer(state, pending.actorId);
  if (!target || !actor || !target.alive || !actor.alive) {
    state.pendingFavor = null;
    return { ok: false, message: 'Lời Thỉnh Cầu không còn hiệu lực.' };
  }
  const card = target.hand.find((item) => item.id === String(cardId));
  if (!card) return { ok: false, message: 'Hãy chọn một lá thực sự có trên tay.' };
  state.pendingFavor = null;
  transferCard(state, target, actor, card);
  // Chỉ người nhận thấy lá bài trong tay; nhật ký chung không tiết lộ danh tính lá được trao.
  addLog(state, target.name + ' đã trao một lá bài cho ' + actor.name + ' theo lời Thỉnh Cầu.', { playerId: target.id, tactic: 'trao bài theo Thỉnh Cầu', signal: 'warning' });
  target.mood = '😼';
  actor.mood = '😈';
  if (state.status === 'playing' && !state.pendingExplosion) setTurnDeadline(state);
  return { ok: true, message: 'Bạn đã trao một lá bài.' };
}

function autoResolveTimeout(state) {
  if (state.pendingExplosion) {
    const pending = state.pendingExplosion;
    const player = getPlayer(state, pending.playerId);
    if (player && player.alive) {
      if (hasCard(player, 'defuse') && pending.bombCard.type !== 'imploding') return resolveDefuse(state, player.id, 'random');
      moveToDiscard(state, pending.bombCard);
      state.pendingExplosion = null;
      eliminatePlayer(state, player.id, 'không xử lý bom kịp thời');
      return { ok: true, eliminated: true };
    }
  }
  if (state.pendingFavor) {
    const target = getPlayer(state, state.pendingFavor.targetId);
    if (target && target.alive && target.hand.length) {
      const card = target.hand[randomIndex(target.hand.length)];
      return resolveFavor(state, target.id, card.id);
    }
    state.pendingFavor = null;
  }
  if (state.pendingAction) return resolvePendingAction(state);
  const player = getPlayer(state, state.activeId);
  if (player && player.alive) return drawCard(state, player.id, false, { automatic: true });
  return { ok: false, message: 'Không có thao tác nào cần tự động xử lý.' };
}

function getBombDensity(state) {
  if (!state.deck.length) return 0;
  const bombs = state.deck.filter((card) => card.type === 'explode').length;
  return bombs / state.deck.length;
}

function riskForPlayer(state, player) {
  const density = getBombDensity(state);
  let score = density * 100;
  const hasDefuse = hasCard(player, 'defuse');
  const hasStreaking = hasCard(player, 'streaking');
  if (!hasDefuse && !hasStreaking) score += 28;
  if (hasDefuse) score -= 12;
  if (hasStreaking) score -= 20;
  if (state.activeId === player.id && state.turnsLeft > 1) score += 8;
  if (state.deck.length <= 8) score += 10;
  if (state.deck[0] && state.deck[0].type === 'imploding' && state.deck[0].faceUp) score += 35;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    band: score >= 58 ? 'danger' : score >= 30 ? 'warning' : 'safe',
    label: score >= 58 ? 'NGUY HIỂM' : score >= 30 ? 'CẦN CẨN THẬN' : 'TƯƠNG ĐỐI AN TOÀN',
    densityPct: Math.round(density * 100),
    detail: hasDefuse ? 'Có Gỡ Bỏ dự phòng.' : hasStreaking ? 'Mèo Giữ Bom đang bảo vệ một quả bom.' : 'Không có Gỡ Bỏ trên tay.'
  };
}

function getPublicState(state, viewerId) {
  const viewer = getPlayer(state, viewerId);
  const now = Date.now();
  const peek = state.privatePeek[viewerId];
  if (peek && peek.expiresAt <= now) delete state.privatePeek[viewerId];
  return {
    status: state.status,
    expansions: state.expansions,
    yourId: viewerId,
    activeId: state.activeId,
    turnsLeft: state.turnsLeft,
    deadline: state.deadline,
    winnerId: state.winnerId,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    discardTop: state.discard.length ? { name: state.discard[state.discard.length - 1].name, emoji: state.discard[state.discard.length - 1].emoji, type: state.discard[state.discard.length - 1].type } : null,
    pendingAction: state.pendingAction ? {
      id: state.pendingAction.id,
      actorId: state.pendingAction.actorId,
      cardType: state.pendingAction.cardType,
      cardName: state.pendingAction.cardName,
      nopeCount: state.pendingAction.nopeCount,
      expiresAt: state.pendingAction.expiresAt,
      canNope: Boolean(viewer && viewer.alive && hasCard(viewer, 'nope') && (viewerId !== state.pendingAction.actorId || state.pendingAction.nopeCount > 0))
    } : null,
    pendingExplosion: Boolean(state.pendingExplosion && state.pendingExplosion.playerId === viewerId),
    pendingExplosionName: state.pendingExplosion && state.pendingExplosion.playerId === viewerId ? state.pendingExplosion.bombCard.name : null,
    pendingFavor: state.pendingFavor ? {
      actorId: state.pendingFavor.actorId,
      targetId: state.pendingFavor.targetId,
      expiresAt: state.pendingFavor.expiresAt,
      isYourChoice: state.pendingFavor.targetId === viewerId
    } : null,
    privatePeek: peek && peek.expiresAt > now ? peek.cards : null,
    risk: viewer ? riskForPlayer(state, viewer) : null,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
      alive: player.alive,
      handCount: player.hand.length,
      hand: player.id === viewerId ? player.hand.map((card) => ({ ...card, description: CARD_DEFS[card.type].description })) : undefined,
      mood: player.mood,
      bubble: player.bubble,
      strategy: strategyLabel(player),
      riskBand: player.id === viewerId ? riskForPlayer(state, player).band : null,
      isActive: player.id === state.activeId,
      turnsLeft: player.id === state.activeId ? state.turnsLeft : 0
    })),
    log: state.log.slice(-24),
    timeline: state.timeline.slice(-8),
    chat: state.chat.slice(-16)
  };
}

function setEmotion(state, playerId, mood, message) {
  const player = getPlayer(state, playerId);
  if (!player || !player.alive) return false;
  const allowed = ['👏', '😱', '😼', '😂', '🙈', '🔥', '🫣'];
  player.mood = allowed.includes(mood) ? mood : '😼';
  player.bubble = String(message || '').slice(0, 80);
  addChat(state, player.name, player.bubble || '…', player.mood, player.isBot ? 'bot' : 'player');
  return true;
}

function forfeitPlayer(state, playerId, reason = 'đã rời khỏi ván') {
  const player = getPlayer(state, playerId);
  if (!player || !player.alive || state.status !== 'playing') return { ok: false };
  eliminatePlayer(state, playerId, reason);
  return { ok: true };
}

module.exports = {
  CARD_DEFS,
  BASE_COUNTS,
  EXPANSION_COUNTS,
  TURN_MS,
  REACTION_MS,
  DECISION_MS,
  createGame,
  playCard,
  playCombo,
  playNope,
  resolvePendingAction,
  drawCard,
  resolveDefuse,
  resolveFavor,
  autoResolveTimeout,
  getPublicState,
  getBombDensity,
  riskForPlayer,
  setEmotion,
  forfeitPlayer,
  shuffleArray,
  randomIndex,
  addLog,
  addChat,
  getPlayer,
  alivePlayers,
  nextAlivePlayer
};
