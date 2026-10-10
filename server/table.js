import { Hand, GameError, formatEvent, describeResult } from './hand.js';
import { chooseAction } from './bots.js';
import { fmt } from './cards.js';

export const SB = 50;
export const BB = 100;
export const MAX_SEATS = 6;
export const MIN_BUYIN = 1000;
export const TURN_MS = 30000;
export const BOT_THINK_MIN = 650;
export const BOT_THINK_MAX = 1200;
export const BOARD_DELAY = 650;
export const BETWEEN_HANDS_MS = 4200;

export const BOTS = [
  { id: 'bot:tingyu', name: '听雨', style: 'tight', stack: 4200, seat: 2 },
  { id: 'bot:shisui', name: '拾穗', style: 'loose', stack: 3600, seat: 3 },
  { id: 'bot:nanzhi', name: '南枝', style: 'aggro', stack: 4800, seat: 4 },
];

const STREET_NAME = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
};

function wait(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export class Table {
  constructor(db, options = {}) {
    this.db = db;
    this.manual = !!options.manual;
    this.seats = Array(MAX_SEATS).fill(null);
    this.button = -1;
    this.hand = null;
    this.handNumber = 0;
    this.online = new Set();
    this.pending = null;
    this.timer = null;
    this.turnDeadline = null;
    this.turnSeat = null;
    this.onUpdate = null;
    for (const bot of BOTS) {
      this.seats[bot.seat] = {
        id: bot.id,
        name: bot.name,
        isBot: true,
        style: bot.style,
        stack: bot.stack,
        baseStack: bot.stack,
        disconnected: false,
        leaveAfterHand: false,
      };
    }
  }

  seatByUser(userId) {
    return this.seats.find((seat) => seat && seat.id === userId) ?? null;
  }

  setConnected(userId, connected) {
    if (connected) this.online.add(userId);
    else this.online.delete(userId);
    const seat = this.seatByUser(userId);
    if (seat) seat.disconnected = !connected;
    this.emit();
  }

  sit(user, buyIn, preferredSeat = null) {
    const existing = this.seatByUser(user.id);
    if (existing) return existing;
    const seatIndex = this.pickSeat(preferredSeat);
    if (seatIndex < 0) throw new GameError('牌桌已满');
    if (!Number.isInteger(buyIn)) throw new GameError('买入金额不合法');
    const wallet = this.wallet(user.id);
    let amount = buyIn;
    if (wallet <= 0) throw new GameError('筹码不足');
    if (wallet < MIN_BUYIN) {
      amount = wallet;
    } else if (amount < MIN_BUYIN) {
      throw new GameError(`买入至少 ${fmt(MIN_BUYIN)}`);
    }
    if (amount > wallet) throw new GameError('筹码不足');
    this.db.addChips(user.id, -amount);
    this.seats[seatIndex] = {
      id: user.id,
      name: user.username,
      isBot: false,
      style: null,
      stack: amount,
      baseStack: amount,
      disconnected: !this.online.has(user.id),
      leaveAfterHand: false,
    };
    this.emit();
    this.queueNext();
    return this.seats[seatIndex];
  }

  pickSeat(preferredSeat) {
    if (Number.isInteger(preferredSeat) && preferredSeat >= 0 && preferredSeat < MAX_SEATS && !this.seats[preferredSeat]) {
      return preferredSeat;
    }
    return this.seats.findIndex((seat) => seat == null);
  }

  leave(userId) {
    const index = this.seats.findIndex((seat) => seat && seat.id === userId && !seat.isBot);
    if (index < 0) throw new GameError('你没有在座位上');
    const seat = this.seats[index];
    const player = this.hand?.players.find((item) => item.id === userId);
    const stillIn = player && !player.folded && this.hand.phase !== 'complete';
    if (stillIn && player.allIn) {
      seat.leaveAfterHand = true;
      this.emit();
      return;
    }
    if (stillIn) {
      this.hand.forceFold(userId);
      this.syncStacks();
      this.follow();
    }
    this.cashOut(index);
    this.emit();
  }

  rebuy(userId, amount) {
    const seat = this.seatByUser(userId);
    if (!seat || seat.isBot) throw new GameError('你还没有入座');
    if (this.hand && this.hand.phase !== 'complete') {
      const player = this.hand.players.find((item) => item.id === userId);
      if (player && !player.folded) throw new GameError('本手结束后才能补码');
    }
    if (!Number.isInteger(amount)) throw new GameError('补码金额不合法');
    const wallet = this.wallet(userId);
    let chips = amount;
    if (wallet <= 0) throw new GameError('钱包里没有筹码了');
    if (wallet < MIN_BUYIN) chips = wallet;
    else if (chips < MIN_BUYIN) throw new GameError(`补码至少 ${fmt(MIN_BUYIN)}`);
    if (chips > wallet) throw new GameError('筹码不足');
    this.db.addChips(userId, -chips);
    seat.stack += chips;
    const player = this.hand?.players.find((item) => item.id === userId);
    if (player && this.hand.phase === 'complete') player.stack += chips;
    this.emit();
    if (!this.hand) this.queueNext();
  }

  action(userId, type, amount) {
    if (!this.hand || this.hand.phase !== 'betting') throw new GameError('现在不能行动');
    const current = this.hand.currentPlayer();
    if (!current || current.id !== userId) throw new GameError('还没轮到你');
    this.clearPending();
    this.hand.action(userId, type, amount);
    this.syncStacks();
    this.follow();
    this.emit();
  }

  wallet(userId) {
    return this.db.getChips(userId);
  }

  queueNext() {
    if (this.hand) return;
    if (!this.canStart()) return;
    this.arm(this.manual ? 0 : 700, () => this.startHand());
  }

  canStart() {
    const ready = this.seats.filter((seat) => seat && seat.stack > 0);
    const humans = ready.filter((seat) => !seat.isBot);
    return humans.length >= 1 && ready.length >= 2;
  }

  startHand() {
    if (this.hand) return;
    this.resolveLeaves();
    this.refillBots();
    if (!this.canStart()) {
      this.emit();
      return;
    }
    const playing = this.seats
      .map((seat, index) => (seat && seat.stack > 0 ? { seat, index } : null))
      .filter(Boolean);
    const seatNumbers = playing.map((item) => item.index);
    const next = seatNumbers.find((seat) => seat > this.button);
    this.button = next ?? seatNumbers[0];
    this.handNumber += 1;
    this.hand = new Hand({
      players: playing.map(({ seat, index }) => ({
        id: seat.id,
        name: seat.name,
        seat: index,
        stack: seat.stack,
        isBot: seat.isBot,
      })),
      buttonSeat: this.button,
      sb: SB,
      bb: BB,
    });
    this.syncStacks();
    this.follow();
    this.emit();
  }

  refillBots() {
    for (const seat of this.seats) {
      if (seat?.isBot && seat.stack === 0) seat.stack = seat.baseStack;
    }
  }

  resolveLeaves() {
    for (let index = 0; index < this.seats.length; index += 1) {
      if (this.seats[index]?.leaveAfterHand) this.cashOut(index);
    }
  }

  cashOut(index) {
    const seat = this.seats[index];
    if (!seat || seat.isBot) return;
    const stack = seat.stack;
    this.seats[index] = null;
    if (stack > 0) this.db.addChips(seat.id, stack);
  }

  syncStacks() {
    if (!this.hand) return;
    for (const player of this.hand.players) {
      const seat = this.seats[player.seat];
      if (seat && seat.id === player.id) seat.stack = player.stack;
    }
  }

  follow() {
    if (!this.hand) {
      this.queueNext();
      return;
    }
    if (this.hand.phase === 'complete') {
      this.turnDeadline = null;
      this.turnSeat = null;
      this.arm(this.manual ? 0 : BETWEEN_HANDS_MS, () => this.finishPause());
      return;
    }
    if (this.hand.phase === 'await_board') {
      this.turnDeadline = null;
      this.turnSeat = null;
      this.arm(this.manual ? 0 : BOARD_DELAY, () => this.dealBoard());
      return;
    }
    const player = this.hand.currentPlayer();
    if (!player) return;
    this.turnSeat = player.seat;
    if (player.isBot) {
      this.turnDeadline = null;
      const seat = this.seats[player.seat];
      this.arm(this.manual ? 0 : wait(BOT_THINK_MIN, BOT_THINK_MAX), () => this.botAct(player.id, seat?.style));
      return;
    }
    this.turnDeadline = Date.now() + TURN_MS;
    this.arm(this.manual ? 0 : TURN_MS, () => this.timeoutAct(player.id));
  }

  dealBoard() {
    if (!this.hand || this.hand.phase !== 'await_board') return;
    this.hand.dealNext();
    this.syncStacks();
    this.follow();
    this.emit();
  }

  botAct(playerId, style) {
    if (!this.hand || this.hand.phase !== 'betting') return;
    const player = this.hand.currentPlayer();
    if (!player || player.id !== playerId) return;
    const legal = this.hand.legalFor(player);
    const opponents = this.hand.living().length - 1;
    const decision = chooseAction({
      style,
      hole: player.hole,
      board: this.hand.board,
      legal,
      opponents,
      pot: this.hand.potAmount(),
    });
    try {
      this.hand.action(player.id, decision.action, decision.amount);
    } catch {
      const safe = legal?.canCheck ? 'check' : legal?.canCall ? 'call' : 'fold';
      try { this.hand.action(player.id, safe); } catch { /* already advanced */ }
    }
    this.syncStacks();
    this.follow();
    this.emit();
  }

  timeoutAct(playerId) {
    if (!this.hand || this.hand.phase !== 'betting') return;
    const player = this.hand.currentPlayer();
    if (!player || player.id !== playerId || player.isBot) return;
    const legal = this.hand.legalFor(player);
    const type = legal?.canCheck ? 'check' : 'fold';
    this.hand.events.push({ type: 'note', text: `${player.name} 思考超时` });
    try { this.hand.action(player.id, type); } catch { return; }
    this.syncStacks();
    this.follow();
    this.emit();
  }

  finishPause() {
    if (!this.hand || this.hand.phase !== 'complete') return;
    this.syncStacks();
    this.hand = null;
    this.turnDeadline = null;
    this.turnSeat = null;
    this.resolveLeaves();
    this.refillBots();
    if (this.canStart()) this.startHand();
    else this.emit();
  }

  arm(delay, fn) {
    this.clearPending();
    this.pending = fn;
    if (this.manual) return;
    this.timer = setTimeout(() => {
      this.pending = null;
      this.timer = null;
      fn();
    }, delay);
  }

  clearPending() {
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.turnDeadline = null;
  }

  runPending() {
    const fn = this.pending;
    this.clearPending();
    if (fn) fn();
  }

  destroy() {
    this.clearPending();
  }

  emit() {
    this.onUpdate?.();
  }

  view(userId) {
    const wallet = this.wallet(userId);
    const mine = this.seatByUser(userId);
    const hand = this.hand;
    const meInHand = hand?.players.find((player) => player.id === userId) ?? null;
    const legal = meInHand ? hand.legalFor(meInHand) : null;
    const pot = hand ? hand.potAmount() : 0;
    const winners = new Map((hand?.result?.winners ?? []).map((winner) => [winner.seat, winner]));

    const seats = this.seats.map((seat, index) => {
      if (!seat) return { index, empty: true };
      const player = hand?.players.find((item) => item.seat === index && item.id === seat.id) ?? null;
      let hole = null;
      if (player && !player.folded) {
        if (player.id === userId || hand.showCards) hole = [...player.hole];
        else if (hand.phase !== 'complete') hole = ['back', 'back'];
      }
      const winner = winners.get(index);
      let role = null;
      if (hand && index === hand.buttonSeat && index === hand.sbSeat) role = '庄/小盲';
      else if (hand && index === hand.buttonSeat) role = '庄';
      else if (hand && index === hand.sbSeat) role = '小盲';
      else if (hand && index === hand.bbSeat) role = '大盲';
      let status = '';
      if (hand && hand.phase === 'betting' && player && hand.currentPlayer()?.id === player.id) status = '思考中';
      else if (player?.folded) status = '弃牌';
      else if (player?.allIn) status = '全下';
      else if (seat.disconnected) status = '离线';
      else if (hand && !player) status = '等待';
      return {
        index,
        empty: false,
        name: seat.name,
        isBot: seat.isBot,
        isYou: seat.id === userId,
        stack: seat.stack,
        bet: player?.streetCommit || 0,
        folded: !!player?.folded,
        allIn: !!player?.allIn,
        disconnected: seat.disconnected,
        inHand: !!player && !player.folded,
        hole,
        role,
        toAct: !!(hand && hand.phase === 'betting' && player && hand.currentPlayer()?.id === player.id),
        winner: !!winner,
        winAmount: winner?.amount ?? 0,
        handName: player && hand.showCards && !player.folded ? player.rankName : (winner?.hand ?? ''),
        status,
        leaving: seat.leaveAfterHand,
      };
    });

    let phase = 'waiting';
    if (hand?.phase === 'betting') phase = 'betting';
    else if (hand?.phase === 'await_board') phase = 'board';
    else if (hand?.phase === 'complete') phase = 'complete';

    let banner = null;
    if (hand?.result) banner = describeResult(hand.result);
    else if (!hand && mine && mine.stack <= 0) banner = '筹码输光了，补码后继续';
    else if (!hand && !this.canStart()) banner = '入座后即可开局';
    else if (legal) banner = '轮到你了';
    else if (hand && phase === 'board') banner = `发出${STREET_NAME[hand.street] || '公共牌'}`;

    const log = [];
    if (hand) {
      log.push(`第 ${this.handNumber} 手`);
      for (const event of hand.events) {
        const line = formatEvent(event);
        if (line) log.push(line);
      }
    }

    return {
      you: {
        id: userId,
        username: mine?.name ?? this.db.getUser(userId)?.username ?? '',
        wallet,
        seated: !!mine,
        seat: mine ? this.seats.indexOf(mine) : null,
        stack: mine?.stack ?? null,
        hole: meInHand && !meInHand.folded ? [...meInHand.hole] : null,
        inHand: !!(meInHand && !meInHand.folded),
        toAct: !!legal,
      },
      table: {
        name: '主桌',
        blinds: { sb: SB, bb: BB },
        maxSeats: MAX_SEATS,
        handNumber: this.handNumber,
        phase,
        street: hand?.street ?? null,
        board: hand ? [...hand.board] : [],
        pot,
        seats,
        buttonSeat: hand ? hand.buttonSeat : (this.button >= 0 ? this.button : null),
        turnDeadline: this.turnDeadline,
        turnSeat: this.turnSeat,
        legal,
        log: log.slice(-16),
        banner,
        minBuyIn: MIN_BUYIN,
        occupied: this.seats.filter(Boolean).length,
      },
    };
  }
}
