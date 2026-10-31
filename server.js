'use strict';

/**
 * Máy chủ V5 — toàn bộ trạng thái và thao tác bài đều được xử lý tại đây.
 * Client không bao giờ gửi loại lá muốn rút; client chỉ gửi lệnh "rút".
 */
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomInt } = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const Game = require('./engine');

const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 1e5
});

const PORT = Number(process.env.PORT) || 3000;
const games = new Map();
const rooms = new Map();
const socketToGame = new Map();
const socketToRoom = new Map();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'meo-no-v5', authority: 'server', multiplayer: true }));
app.get('/api/rules', (_req, res) => res.json({
  version: 5,
  basicDeckSize: Object.values(Game.BASE_COUNTS).reduce((sum, count) => sum + count, 0),
  basicCounts: Game.BASE_COUNTS,
  expansionCounts: Game.EXPANSION_COUNTS,
  shuffle: 'Fisher–Yates + crypto.randomInt (phía máy chủ)',
  drawAuthority: 'Máy chủ',
  multiplayer: 'Phòng realtime 2–5 người, trạng thái và bộ bài do máy chủ quyết định'
}));

function reply(ack, result) {
  if (typeof ack === 'function') ack(result);
}

function cleanName(value) {
  const name = String(value || 'Bạn')
    .replace(/[<>\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return name || 'Bạn';
}

function getRecord(socket) {
  const gameId = socketToGame.get(socket.id);
  return gameId ? games.get(gameId) : null;
}

function playerIdFor(record, socket) {
  if (!record) return null;
  if (record.type === 'room') return record.playerBySocket.get(socket.id) || null;
  return record.humanId;
}

function emitState(record) {
  if (!record || !record.state) return;
  if (record.type === 'room') {
    for (const member of record.members) {
      if (!member.online || !member.socketId) continue;
      const publicState = Game.getPublicState(record.state, member.playerId);
      publicState.isRoom = true;
      publicState.roomCode = record.roomCode;
      publicState.roomHost = member.playerId === record.hostId;
      publicState.roomHostId = record.hostId;
      publicState.onlineCount = record.members.filter((item) => item.online).length;
      io.to(member.socketId).emit('game:state', publicState);
    }
    return;
  }
  if (record.socketId) io.to(record.socketId).emit('game:state', Game.getPublicState(record.state, record.humanId));
}

function emitRoomState(room) {
  if (!room) return;
  const snapshot = room.members.map((member) => ({
    id: member.playerId,
    name: member.name,
    isHost: member.playerId === room.hostId,
    online: member.online
  }));
  for (const member of room.members) {
    if (!member.online || !member.socketId) continue;
    io.to(member.socketId).emit('room:state', {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      yourId: member.playerId,
      members: snapshot,
      minPlayers: 2,
      maxPlayers: 5,
      expansions: room.expansions
    });
  }
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}

function findRoomForSocket(socket) {
  const code = socketToRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function removeFromLobby(socket, reason = 'đã rời phòng') {
  const room = findRoomForSocket(socket);
  if (!room || room.status !== 'lobby') return null;
  const index = room.members.findIndex((member) => member.socketId === socket.id);
  if (index >= 0) room.members.splice(index, 1);
  socketToRoom.delete(socket.id);
  socket.leave('lobby:' + room.code);
  if (!room.members.length) {
    rooms.delete(room.code);
    return room;
  }
  if (!room.members.some((member) => member.playerId === room.hostId)) room.hostId = room.members[0].playerId;
  emitRoomState(room);
  return room;
}

function makeRoomRecord(room) {
  const connected = room.members.filter((member) => member.online && member.socketId);
  const specs = connected.map((member) => ({ id: member.playerId, name: member.name, isBot: false }));
  const state = Game.createGame(specs, { expansions: room.expansions });
  const gameId = 'room-' + room.code + '-' + randomUUID();
  const record = {
    type: 'room', id: gameId, roomCode: room.code, hostId: room.hostId,
    members: connected.map((member) => ({ ...member })),
    playerBySocket: new Map(connected.map((member) => [member.socketId, member.playerId])),
    state, disposed: false
  };
  games.set(gameId, record);
  room.recordId = gameId;
  room.status = 'playing';
  for (const member of connected) {
    socketToGame.set(member.socketId, gameId);
    const peer = io.sockets.sockets.get(member.socketId);
    if (peer) {
      peer.leave('lobby:' + room.code);
      peer.join(gameId);
    }
  }
  emitRoomState(room);
  emitState(record);
  return record;
}

function makeSoloRecord(socket, options = {}) {
  const humanId = randomUUID();
  const botCount = Math.max(1, Math.min(3, Number(options.botCount) || 2));
  const name = cleanName(options.name);
  const specs = [{ id: humanId, name, isBot: false }];
  for (let index = 0; index < botCount; index += 1) {
    specs.push({ id: 'bot-' + randomUUID(), name: ['Mướp Máy', 'Bánh Bao AI', 'Ngài Meo'][index], isBot: true });
  }
  const state = Game.createGame(specs, { expansions: Boolean(options.expansions) });
  const gameId = 'solo-' + randomUUID();
  const record = {
    type: 'solo',
    id: gameId,
    socketId: socket.id,
    humanId,
    name,
    botCount,
    expansions: Boolean(options.expansions),
    state,
    aiAt: null,
    aiBusy: false,
    botResponded: new Set(),
    disposed: false
  };
  games.set(gameId, record);
  socketToGame.set(socket.id, gameId);
  socket.join(gameId);
  return record;
}

function getNextPlayer(state, playerId) {
  return Game.nextAlivePlayer(state, playerId);
}

function botShouldNope(state, bot, pending) {
  if (!Game.getPlayer(state, bot.id) || !bot.alive || !bot.hand.some((card) => card.type === 'nope')) return false;
  if (pending.lastNopeId === bot.id) return false;
  if (pending.actorId === bot.id && pending.nopeCount === 0) return false;
  const targetId = pending.payload && pending.payload.targetId;
  if (pending.cardType === 'attack') {
    const next = getNextPlayer(state, pending.actorId);
    if (next && next.id === bot.id) return true;
  }
  if (pending.cardType === 'combo' && targetId === bot.id) return true;
  if (pending.cardType === 'favor' && targetId === bot.id) return true;
  if (pending.cardType === 'catomic') return Game.getBombDensity(state) > 0.10;
  if (pending.cardType === 'future') return false;
  // Các bot có cá tính hơi khác nhau: thỉnh thoảng phản đòn để tránh quá máy móc.
  return Math.random() < 0.08;
}

function botChatter(state, speaker, text, mood = '😼') {
  speaker.mood = mood;
  speaker.bubble = text;
  Game.addChat(state, speaker.name, text, mood, 'bot');
}

function reactBotsToPlayer(record, signal) {
  const state = record.state;
  const bots = state.players.filter((player) => player.isBot && player.alive);
  if (!bots.length) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const lines = {
    danger: [
      ['Ủa, vừa rồi nguy hiểm thật đó!', '😱'],
      ['Tôi nghe tiếng mèo rít rồi…', '🫣'],
      ['Tình hình này không ổn nha.', '😬']
    ],
    safe: [
      ['Nước đi khá gọn đấy.', '👏'],
      ['Bình tĩnh ghê. Tôi hơi rén rồi.', '😼'],
      ['Bạn đang tính xa hơn tôi tưởng.', '🧐']
    ],
    neutral: [
      ['Hừm… tôi đang quan sát.', '🧐'],
      ['Đừng tưởng tôi không để ý nhé.', '😼'],
      ['Mèo nào cũng có móng vuốt!', '🐾']
    ]
  };
  const choice = lines[signal] || lines.neutral;
  const line = choice[Math.floor(Math.random() * choice.length)];
  botChatter(state, bot, line[0], line[1]);
  const other = bots.find((item) => item.id !== bot.id);
  if (other && Math.random() < 0.42) {
    setTimeout(() => {
      if (!record.disposed && record.state.status === 'playing') {
        other.mood = '😂';
        other.bubble = 'Bot ' + (bots.indexOf(bot) + 1) + ' nói nghe cũng hợp lý đấy!';
        Game.addChat(state, other.name, other.bubble, other.mood, 'bot');
        emitState(record);
      }
    }, 650);
  }
}

function chooseBotFavorCard(target) {
  const priority = ['cat_beard', 'cat_rainbow', 'cat_potato', 'cat_melon', 'cat_taco', 'shuffle', 'skip', 'attack', 'future', 'bottom', 'super_skip', 'catomic', 'nope', 'streaking', 'defuse', 'explode'];
  const sorted = target.hand.slice().sort((a, b) => priority.indexOf(a.type) - priority.indexOf(b.type));
  return sorted[0] || null;
}

function startBotWork(record) {
  if (!record || record.disposed || record.aiBusy) return;
  record.aiBusy = true;
  setTimeout(() => {
    try {
      if (record.disposed || record.state.status !== 'playing') return;
      runBotWork(record);
    } finally {
      record.aiBusy = false;
      emitState(record);
    }
  }, 620 + Math.floor(Math.random() * 380));
}

function runBotWork(record) {
  const state = record.state;
  const now = Date.now();

  if (state.pendingExplosion) {
    const pendingPlayer = Game.getPlayer(state, state.pendingExplosion.playerId);
    if (pendingPlayer && pendingPlayer.isBot) {
      if (pendingPlayer.hand.some((card) => card.type === 'defuse') && state.pendingExplosion.bombCard.type !== 'imploding') {
        // Bot thường đặt bom lên đầu để tạo áp lực lên người kế tiếp.
        Game.resolveDefuse(state, pendingPlayer.id, 'top');
        botChatter(state, pendingPlayer, 'Không dễ loại tôi vậy đâu!', '😎');
      } else {
        Game.autoResolveTimeout(state);
      }
      reactBotsToPlayer(record, 'danger');
    }
    return;
  }

  if (state.pendingFavor) {
    const target = Game.getPlayer(state, state.pendingFavor.targetId);
    if (target && target.isBot && target.hand.length) {
      const chosen = chooseBotFavorCard(target);
      Game.resolveFavor(state, target.id, chosen.id);
      botChatter(state, target, 'Được rồi, cầm lấy lá này đi.', '😼');
    }
    return;
  }

  if (state.pendingAction) {
    const pending = state.pendingAction;
    const bots = state.players.filter((player) => player.isBot && player.alive);
    for (const bot of bots) {
      const responseKey = pending.id + ':' + bot.id + ':' + pending.nopeCount;
      if (record.botResponded.has(responseKey)) continue;
      record.botResponded.add(responseKey);
      if (botShouldNope(state, bot, pending)) {
        const nope = bot.hand.find((card) => card.type === 'nope');
        if (nope) {
          Game.playNope(state, bot.id, nope.id);
          botChatter(state, bot, 'Không nha! 🙅', '😼');
        }
      }
    }
    if (state.pendingAction && state.pendingAction.expiresAt <= now) {
      const result = Game.resolvePendingAction(state);
      const actor = Game.getPlayer(state, pending.actorId);
      if (actor && pending.cardType === 'future' && !result.canceled) {
        actor.stats.peekedTurn = state.turnNo;
      }
      if (result.ok && !result.canceled) reactBotsToPlayer(record, pending.cardType === 'attack' ? 'danger' : 'neutral');
      record.botResponded.clear();
    }
    return;
  }

  const active = Game.getPlayer(state, state.activeId);
  if (!active || !active.alive || !active.isBot) return;

  if (state.deadline && state.deadline <= now) {
    Game.autoResolveTimeout(state);
    record.aiAt = null;
    return;
  }

  const getCard = (type) => active.hand.find((card) => card.type === type);
  const play = (type, targetId) => {
    const card = getCard(type);
    if (!card) return false;
    const result = Game.playCard(state, active.id, card.id, targetId);
    if (result.ok) {
      active.mood = '😼';
      record.aiAt = Date.now() + 1_000;
      return true;
    }
    return false;
  };

  // Bot luôn ưu tiên xem trước nếu có, mỗi lượt chỉ xem một lần.
  if (getCard('future') && active.stats.peekedTurn !== state.turnNo) {
    active.stats.peekedTurn = state.turnNo;
    if (play('future')) {
      botChatter(state, active, 'Tôi muốn nhìn qua tương lai một chút…', '🧐');
      return;
    }
  }

  const peekedThisTurn = active.stats.peekedTurn === state.turnNo;
  const topCard = peekedThisTurn ? state.deck[0] : null;
  const bombAtTop = Boolean(topCard && (topCard.type === 'explode' || (topCard.type === 'imploding' && topCard.faceUp)));

  if (bombAtTop) {
    if (play('super_skip')) { botChatter(state, active, 'Tạm biệt lượt nguy hiểm!', '😎'); return; }
    if (play('attack')) { botChatter(state, active, 'Tôi xin phép chuyển quả bom này cho người khác.', '😈'); return; }
    if (play('skip')) { botChatter(state, active, 'Không, cảm ơn. Tôi bỏ lượt này.', '😼'); return; }
    if (play('shuffle')) { botChatter(state, active, 'Đảo lại mọi thứ nào!', '🌀'); return; }
  }

  // Khi mật độ bom tăng, bot dùng hành động phòng thủ nếu không có lá xem trước.
  if (!peekedThisTurn && Game.getBombDensity(state) >= 0.18) {
    if (play('super_skip')) return;
    if (play('skip')) return;
  }

  // Một vài hành động chiến thuật, có mục tiêu rõ ràng.
  const human = state.players.find((player) => !player.isBot && player.alive);
  if (human && getCard('favor') && Math.random() < 0.30) {
    if (play('favor', human.id)) {
      botChatter(state, active, 'Tôi xin một món quà nhỏ nhé.', '🙏');
      return;
    }
  }

  // Ghép đôi / bộ ba có thể áp dụng cho các lá cùng tên, ngoại trừ bom và Mèo Giữ Bom.
  const counts = new Map();
  active.hand.forEach((card) => {
    if (!['explode', 'imploding', 'streaking'].includes(card.type)) counts.set(card.type, (counts.get(card.type) || 0) + 1);
  });
  const comboType = Array.from(counts.entries()).find(([, count]) => count >= 3)?.[0]
    || Array.from(counts.entries()).find(([, count]) => count >= 2)?.[0];
  if (human && comboType && Math.random() < 0.55) {
    const needed = counts.get(comboType) >= 3 ? 3 : 2;
    const ids = active.hand.filter((card) => card.type === comboType).slice(0, needed).map((card) => card.id);
    const requested = needed === 3 ? 'defuse' : null;
    const result = Game.playCombo(state, active.id, ids, human.id, requested);
    if (result.ok) {
      botChatter(state, active, needed === 3 ? 'Tôi muốn lá Gỡ Bỏ của bạn.' : 'Cho tôi mượn một lá nhé!', '😈');
      record.aiAt = Date.now() + 1_000;
      return;
    }
  }

  if (getCard('bottom') && state.deck.length > 0 && Math.random() < 0.22) {
    if (play('bottom')) { botChatter(state, active, 'Thử vận may từ đáy xem sao.', '🪝'); return; }
  }

  // Catomic Bomb là hành động tạo áp lực, chỉ dùng khi còn bom trong chồng rút.
  if (getCard('catomic') && state.deck.some((card) => card.type === 'explode') && Math.random() < 0.25) {
    if (play('catomic')) { botChatter(state, active, 'Tất cả bom lên đầu hàng nào!', '😈'); return; }
  }

  // Không còn nước đi có lợi: rút đúng lá ở đầu chồng — máy chủ tự chọn.
  const density = Game.getBombDensity(state);
  active.stats.riskyDraws += density > 0.12 ? 1 : 0;
  const result = Game.drawCard(state, active.id, false);
  if (result.needsDefuse) {
    record.aiAt = Date.now() + 650;
  } else {
    record.aiAt = Date.now() + 700;
  }
  if (result.eliminated) reactBotsToPlayer(record, 'danger');
}

function tickRecord(record) {
  if (record.disposed || record.state.status !== 'playing') return;
  const state = record.state;
  const now = Date.now();

  // Phòng nhiều người không có AI tự phản hồi. Khi cửa sổ phản đòn/ra quyết định hết hạn,
  // máy chủ tự xử lý bằng cùng bộ luật và phát trạng thái riêng cho từng người.
  if (record.type === 'room') {
    if (state.pendingAction && state.pendingAction.expiresAt <= now) {
      Game.resolvePendingAction(state);
      emitState(record);
      return;
    }
    if (state.pendingExplosion && state.pendingExplosion.expiresAt <= now) {
      Game.autoResolveTimeout(state);
      emitState(record);
      return;
    }
    if (state.pendingFavor && state.pendingFavor.expiresAt <= now) {
      Game.autoResolveTimeout(state);
      emitState(record);
      return;
    }
    if (state.deadline && state.deadline <= now) {
      Game.autoResolveTimeout(state);
      emitState(record);
    }
    return;
  }

  if (state.pendingAction) {
    if (!record.aiBusy) startBotWork(record);
    return;
  }
  if (state.pendingExplosion) {
    const player = Game.getPlayer(state, state.pendingExplosion.playerId);
    if (player && player.isBot && !record.aiBusy) startBotWork(record);
    else if (state.pendingExplosion.expiresAt <= now && !record.aiBusy) {
      Game.autoResolveTimeout(state);
      emitState(record);
    }
    return;
  }
  if (state.pendingFavor) {
    const target = Game.getPlayer(state, state.pendingFavor.targetId);
    if (target && target.isBot && !record.aiBusy) startBotWork(record);
    else if (state.pendingFavor.expiresAt <= now && !record.aiBusy) {
      Game.autoResolveTimeout(state);
      emitState(record);
    }
    return;
  }

  const active = Game.getPlayer(state, state.activeId);
  if (!active) return;
  if (active.isBot) {
    if (!record.aiAt) record.aiAt = now + 350;
    if (record.aiAt <= now && !record.aiBusy) {
      record.aiAt = null;
      startBotWork(record);
    }
  } else if (state.deadline && state.deadline <= now && !record.aiBusy) {
    Game.autoResolveTimeout(state);
    emitState(record);
  }
}

io.on('connection', (socket) => {
  // ----- SẢNH PHÒNG TRỰC TUYẾN -----
  socket.on('room:create', (payload = {}, ack) => {
    if (getRecord(socket)) return reply(ack, { ok: false, message: 'Bạn đang ở trong một ván chơi.' });
    removeFromLobby(socket, 'tạo phòng mới');
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();
    const playerId = randomUUID();
    const room = {
      code,
      hostId: playerId,
      status: 'lobby',
      expansions: Boolean(payload.expansions),
      members: [{ playerId, socketId: socket.id, name: cleanName(payload.name), online: true }],
      recordId: null,
      createdAt: Date.now()
    };
    rooms.set(code, room);
    socketToRoom.set(socket.id, code);
    socket.join('lobby:' + code);
    emitRoomState(room);
    reply(ack, { ok: true, code, message: 'Đã tạo phòng. Gửi mã phòng cho bạn bè.' });
  });

  socket.on('room:join', (payload = {}, ack) => {
    if (getRecord(socket)) return reply(ack, { ok: false, message: 'Bạn đang ở trong một ván chơi.' });
    removeFromLobby(socket, 'tham gia phòng khác');
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return reply(ack, { ok: false, message: 'Không tìm thấy phòng. Kiểm tra lại mã gồm 6 ký tự.' });
    if (room.status !== 'lobby') return reply(ack, { ok: false, message: 'Ván chơi trong phòng đã bắt đầu.' });
    if (room.members.length >= 5) return reply(ack, { ok: false, message: 'Phòng đã đủ 5 người.' });
    const playerId = randomUUID();
    const member = { playerId, socketId: socket.id, name: cleanName(payload.name), online: true };
    room.members.push(member);
    socketToRoom.set(socket.id, code);
    socket.join('lobby:' + code);
    emitRoomState(room);
    reply(ack, { ok: true, code, message: 'Đã vào phòng.' });
  });

  socket.on('room:leave', (_payload, ack) => {
    const room = removeFromLobby(socket, 'rời phòng');
    reply(ack, { ok: true, message: room ? 'Đã rời phòng.' : 'Bạn không ở trong sảnh phòng.' });
  });

  socket.on('room:start', (payload = {}, ack) => {
    const room = findRoomForSocket(socket);
    if (!room || room.status !== 'lobby') return reply(ack, { ok: false, message: 'Phòng không còn ở trạng thái chờ.' });
    const member = room.members.find((item) => item.socketId === socket.id);
    if (!member || member.playerId !== room.hostId) return reply(ack, { ok: false, message: 'Chỉ chủ phòng mới được bắt đầu ván.' });
    const connected = room.members.filter((item) => item.online);
    if (connected.length < 2) return reply(ack, { ok: false, message: 'Cần ít nhất 2 người để bắt đầu.' });
    if (connected.length > 5) return reply(ack, { ok: false, message: 'Mỗi phòng tối đa 5 người.' });
    room.expansions = Boolean(payload.expansions ?? room.expansions);
    try {
      makeRoomRecord(room);
      reply(ack, { ok: true, message: 'Ván nhiều người đã bắt đầu.', code: room.code });
    } catch (error) {
      room.status = 'lobby';
      reply(ack, { ok: false, message: error.message || 'Không thể khởi tạo ván.' });
    }
  });

  socket.on('room:restart', (_payload, ack) => {
    const record = getRecord(socket);
    if (!record || record.type !== 'room') return reply(ack, { ok: false, message: 'Bạn không ở trong ván phòng.' });
    const member = record.members.find((item) => item.socketId === socket.id);
    if (!member || member.playerId !== record.hostId) return reply(ack, { ok: false, message: 'Chỉ chủ phòng mới được mở ván mới.' });
    const connected = record.members.filter((item) => item.online && io.sockets.sockets.has(item.socketId));
    if (connected.length < 2) return reply(ack, { ok: false, message: 'Cần ít nhất 2 người đang kết nối để chơi lại.' });
    const specs = connected.map((item) => ({ id: item.playerId, name: item.name, isBot: false }));
    record.members = connected;
    record.playerBySocket = new Map(connected.map((item) => [item.socketId, item.playerId]));
    record.state = Game.createGame(specs, { expansions: Boolean(record.expansions) });
    record.disposed = false;
    const room = rooms.get(record.roomCode);
    if (room) { room.members = connected; room.status = 'playing'; room.recordId = record.id; }
    emitState(record);
    reply(ack, { ok: true, message: 'Ván mới đã sẵn sàng.' });
  });

  // ----- CHẾ ĐỘ CHƠI ĐƠN -----
  socket.on('solo:create', (payload = {}, ack) => {
    const existing = getRecord(socket);
    if (existing) {
      if (existing.type === 'room') return reply(ack, { ok: false, message: 'Bạn đang ở trong phòng nhiều người.' });
      existing.disposed = true;
      games.delete(existing.id);
    }
    removeFromLobby(socket, 'bắt đầu Solo');
    const botCount = Math.max(1, Math.min(3, Number(payload.botCount) || 2));
    const record = makeSoloRecord(socket, {
      name: payload.name,
      botCount,
      expansions: Boolean(payload.expansions)
    });
    emitState(record);
    reply(ack, { ok: true, message: 'Đã tạo ván Solo. Máy chủ đang giữ toàn bộ bộ bài và trạng thái.', gameId: record.id });
  });

  // ----- CÁC THAO TÁC DÙNG CHUNG CHO SOLO VÀ PHÒNG -----
  socket.on('game:play', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const result = Game.playCard(record.state, playerId, String(payload.cardId || ''), String(payload.targetId || ''));
    if (result.ok) {
      if (record.type === 'solo') reactBotsToPlayer(record, record.state.pendingAction?.cardType === 'attack' ? 'danger' : 'neutral');
      emitState(record);
    }
    reply(ack, result);
  });

  socket.on('game:combo', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const result = Game.playCombo(record.state, playerId,
      Array.isArray(payload.cardIds) ? payload.cardIds.map(String) : [],
      String(payload.targetId || ''), String(payload.requestedType || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:draw', (_payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    // Client không được quyền gửi cờ rút đáy; chỉ lá Rút Từ Đáy đã đánh mới tạo lệnh nội bộ rút đáy.
    const result = Game.drawCard(record.state, playerId, false);
    if (result.ok) {
      if (record.type === 'solo' && (result.needsDefuse || result.eliminated)) reactBotsToPlayer(record, 'danger');
      emitState(record);
    }
    reply(ack, result);
  });

  socket.on('game:defuse', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const result = Game.resolveDefuse(record.state, playerId, String(payload.placement || ''), payload.customIndex);
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:nope', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const result = Game.playNope(record.state, playerId, String(payload.cardId || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:favor-pick', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const result = Game.resolveFavor(record.state, playerId, String(payload.cardId || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:react', (payload = {}, ack) => {
    const record = getRecord(socket);
    const playerId = playerIdFor(record, socket);
    if (!record || !playerId) return reply(ack, { ok: false, message: 'Bạn chưa tham gia ván chơi.' });
    const mood = String(payload.mood || '😼');
    const message = String(payload.message || 'Tôi đang quan sát đây.');
    Game.setEmotion(record.state, playerId, mood, message);
    if (record.type === 'solo') reactBotsToPlayer(record, 'neutral');
    emitState(record);
    reply(ack, { ok: true });
  });

  socket.on('game:restart', (_payload, ack) => {
    const old = getRecord(socket);
    if (old?.type === 'room') return reply(ack, { ok: false, message: 'Ván phòng cần chủ phòng chọn Chơi lại.' });
    const options = old ? { name: old.name, botCount: old.botCount, expansions: old.expansions } : { name: 'Bạn', botCount: 2, expansions: false };
    if (old) { old.disposed = true; games.delete(old.id); }
    const record = makeSoloRecord(socket, options);
    emitState(record);
    reply(ack, { ok: true, message: 'Ván mới đã sẵn sàng.' });
  });

  socket.on('disconnect', () => {
    const record = getRecord(socket);
    if (record) {
      if (record.type === 'solo') {
        record.disposed = true;
        Game.forfeitPlayer(record.state, record.humanId, 'mất kết nối và rời khỏi ván');
        games.delete(record.id);
      } else {
        const member = record.members.find((item) => item.socketId === socket.id);
        if (member) {
          member.online = false;
          Game.forfeitPlayer(record.state, member.playerId, 'mất kết nối và rời khỏi ván');
          const room = rooms.get(record.roomCode);
          if (room) {
            const roomMember = room.members.find((item) => item.playerId === member.playerId);
            if (roomMember) roomMember.online = false;
            if (room.hostId === member.playerId) {
              const nextHost = record.members.find((item) => item.online);
              if (nextHost) { record.hostId = nextHost.playerId; room.hostId = nextHost.playerId; }
            }
          }
          emitState(record);
        }
      }
      socketToGame.delete(socket.id);
    }
    const lobby = findRoomForSocket(socket);
    if (lobby && lobby.status === 'lobby') removeFromLobby(socket, 'mất kết nối');
    socketToRoom.delete(socket.id);
  });
});

const ticker = setInterval(() => {
  for (const record of games.values()) tickRecord(record);
}, 250);

server.listen(PORT, '0.0.0.0', () => {
  console.log('MÈO NỔ V5 đang chạy tại http://localhost:' + PORT);
  console.log('Solo AI + Multiplayer phòng realtime; bài và lượt luôn do máy chủ quyết định.');
});

function shutdown() {
  clearInterval(ticker);
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
