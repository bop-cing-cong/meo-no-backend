'use strict';

/**
 * Máy chủ V3 — toàn bộ trạng thái và thao tác bài đều được xử lý tại đây.
 * Client không bao giờ gửi loại lá muốn rút; client chỉ gửi lệnh "rút".
 */
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
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
const socketToGame = new Map();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'meo-no-v3', authority: 'server' }));
app.get('/api/rules', (_req, res) => res.json({
  version: 3,
  basicDeckSize: Object.values(Game.BASE_COUNTS).reduce((sum, count) => sum + count, 0),
  basicCounts: Game.BASE_COUNTS,
  expansionCounts: Game.EXPANSION_COUNTS,
  shuffle: 'Fisher–Yates + crypto.randomInt (phía máy chủ)',
  drawAuthority: 'Máy chủ',
  multiplayer: 'Tạm khóa trong giai đoạn thử nghiệm'
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

function emitState(record) {
  if (!record || !record.socketId) return;
  const state = record.state;
  io.to(record.socketId).emit('game:state', Game.getPublicState(state, record.humanId));
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
  socket.on('solo:create', (payload = {}, ack) => {
    const existing = getRecord(socket);
    if (existing) {
      existing.disposed = true;
      games.delete(existing.id);
    }
    const botCount = Math.max(1, Math.min(3, Number(payload.botCount) || 2));
    const record = makeSoloRecord(socket, {
      name: payload.name,
      botCount,
      expansions: Boolean(payload.expansions)
    });
    emitState(record);
    reply(ack, { ok: true, message: 'Đã tạo ván Solo. Máy chủ đang giữ toàn bộ bộ bài và trạng thái.', gameId: record.id });
  });

  socket.on('game:play', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const result = Game.playCard(record.state, record.humanId, String(payload.cardId || ''), String(payload.targetId || ''));
    if (result.ok) {
      reactBotsToPlayer(record, record.state.pendingAction?.cardType === 'attack' ? 'danger' : 'neutral');
      emitState(record);
    }
    reply(ack, result);
  });

  socket.on('game:combo', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const result = Game.playCombo(record.state, record.humanId,
      Array.isArray(payload.cardIds) ? payload.cardIds.map(String) : [],
      String(payload.targetId || ''), String(payload.requestedType || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:draw', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    // Client không được quyền tự chọn đầu/đáy. Rút đáy chỉ được gọi nội bộ sau khi máy chủ xác nhận lá Rút Từ Đáy.
    const result = Game.drawCard(record.state, record.humanId, false);
    if (result.ok) {
      if (result.needsDefuse || result.eliminated) reactBotsToPlayer(record, 'danger');
      emitState(record);
    }
    reply(ack, result);
  });

  socket.on('game:defuse', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const result = Game.resolveDefuse(record.state, record.humanId,
      String(payload.placement || ''), payload.customIndex);
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:nope', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const result = Game.playNope(record.state, record.humanId, String(payload.cardId || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:favor-pick', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const result = Game.resolveFavor(record.state, record.humanId, String(payload.cardId || ''));
    if (result.ok) emitState(record);
    reply(ack, result);
  });

  socket.on('game:react', (payload = {}, ack) => {
    const record = getRecord(socket);
    if (!record) return reply(ack, { ok: false, message: 'Bạn chưa bắt đầu ván Solo.' });
    const mood = String(payload.mood || '😼');
    const message = String(payload.message || 'Tôi đang quan sát đây.');
    Game.setEmotion(record.state, record.humanId, mood, message);
    reactBotsToPlayer(record, 'neutral');
    emitState(record);
    reply(ack, { ok: true });
  });

  socket.on('game:restart', (_payload, ack) => {
    const old = getRecord(socket);
    const options = old ? { name: old.name, botCount: old.botCount, expansions: old.expansions } : { name: 'Bạn', botCount: 2, expansions: false };
    if (old) { old.disposed = true; games.delete(old.id); }
    const record = makeSoloRecord(socket, options);
    emitState(record);
    reply(ack, { ok: true, message: 'Ván mới đã sẵn sàng.' });
  });

  // Không đăng ký room:create / room:join ở V3: nút Chơi cùng bạn đang khóa trong giai đoạn thử nghiệm.
  socket.on('disconnect', () => {
    const record = getRecord(socket);
    if (record) {
      record.disposed = true;
      Game.forfeitPlayer(record.state, record.humanId, 'mất kết nối và rời khỏi ván');
      games.delete(record.id);
    }
    socketToGame.delete(socket.id);
  });
});

const ticker = setInterval(() => {
  for (const record of games.values()) tickRecord(record);
}, 250);

server.listen(PORT, '0.0.0.0', () => {
  console.log('MÈO NỔ V3 đang chạy tại http://localhost:' + PORT);
  console.log('Chế độ rút bài: máy chủ; xáo bài: Fisher–Yates + crypto.randomInt.');
});

function shutdown() {
  clearInterval(ticker);
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
