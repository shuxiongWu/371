const SUITS = {
  s: ['♠', 'black'],
  h: ['♥', 'red'],
  d: ['♦', 'red'],
  c: ['♣', 'black'],
};
const STREET = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
const SEATS = [
  ['50%', '84%'],
  ['17%', '66%'],
  ['17%', '32%'],
  ['50%', '13%'],
  ['83%', '32%'],
  ['83%', '66%'],
];
const BETS = [
  ['50%', '67%'],
  ['32%', '58%'],
  ['33%', '40%'],
  ['50%', '29%'],
  ['67%', '40%'],
  ['68%', '58%'],
];

const root = document.querySelector('#root');
const toastEl = document.querySelector('#toast');
let token = localStorage.getItem('qz_token');
let state = null;
let socket = null;
let authMode = 'register';
let rootMode = '';
let buyInDraft = 5000;
let rebuyDraft = 2000;
let turnDeadline = null;
let toastTimer = 0;

function fmt(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function toast(message) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
}

async function api(path, body, method) {
  const response = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function card(code, size = '') {
  if (!code) return `<div class="card ghost ${size}"></div>`;
  if (code === 'back') return `<div class="card back ${size}"></div>`;
  const rank = code[0] === 'T' ? '10' : code[0];
  const [suit, color] = SUITS[code[1]] || ['?', 'black'];
  return `<div class="card ${color} ${size}"><span class="r">${rank}</span><span class="s">${suit}</span></div>`;
}

function send(message) {
  if (!socket || socket.readyState !== 1) {
    toast('正在连接牌桌');
    return;
  }
  socket.send(JSON.stringify(message));
}

function connect() {
  if (!token) return;
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      state = message;
      turnDeadline = message.table?.turnDeadline || null;
      render();
    } else if (message.type === 'error') toast(message.error);
  });
  socket.addEventListener('close', () => {
    socket = null;
    if (!token) return;
    setTimeout(connect, 800);
  });
}

function render() {
  if (!token) renderAuth();
  else if (!state) renderWaiting();
  else if (!state.you.seated) renderLobby();
  else renderTable();
}

function renderAuth() {
  if (rootMode === 'auth') return;
  rootMode = 'auth';
  root.innerHTML = `
    <main class="auth">
      <section class="auth-card">
        <div class="brand">
          <div class="seal">青</div>
          <div>
            <h1>青毡</h1>
            <p>无限制德州扑克</p>
          </div>
        </div>
        <p class="lede">一张安静的六人牌桌。只使用娱乐筹码，不能充值，也不能兑换现金。</p>
        <div class="tabs">
          <button type="button" id="tab-register" class="${authMode === 'register' ? 'active' : ''}">注册</button>
          <button type="button" id="tab-login" class="${authMode === 'login' ? 'active' : ''}">登录</button>
        </div>
        <form id="auth-form">
          <label>用户名<input id="username" name="username" type="text" maxlength="12" autocomplete="username" required></label>
          <label>密码<input id="password" name="password" type="password" maxlength="64" autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}" required></label>
          <p class="form-error" id="form-error"></p>
          <button class="solid full" type="submit">${authMode === 'register' ? '注册并进入' : '登录'}</button>
        </form>
        <p class="fine">新玩家获得 10,000 娱乐筹码。盲注 50 / 100，六人桌。</p>
      </section>
    </main>`;
  document.querySelector('#tab-register').onclick = () => { authMode = 'register'; rootMode = ''; renderAuth(); };
  document.querySelector('#tab-login').onclick = () => { authMode = 'login'; rootMode = ''; renderAuth(); };
  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const username = document.querySelector('#username').value.trim();
    const password = document.querySelector('#password').value;
    const error = document.querySelector('#form-error');
    error.textContent = '';
    try {
      const path = authMode === 'register' ? '/api/register' : '/api/login';
      const data = await api(path, { username, password });
      token = data.token;
      localStorage.setItem('qz_token', token);
      state = null;
      rootMode = '';
      connect();
      render();
    } catch (err) {
      error.textContent = err.message;
    }
  };
}

function renderWaiting() {
  rootMode = 'wait';
  root.innerHTML = `<main class="auth"><p>正在连接青毡…</p></main>`;
}

function header() {
  const wallet = state?.you?.wallet ?? 0;
  const name = state?.you?.username || '';
  return `
    <header class="topbar">
      <div class="brand">
        <div class="seal">青</div>
        <div>
          <h1>青毡</h1>
          <p>娱乐筹码 · 不可兑换</p>
        </div>
      </div>
      <div class="top-actions">
        <div class="chip-pill">钱包 <strong id="wallet">${fmt(wallet)}</strong></div>
        <div class="who">${esc(name)}</div>
        ${state?.you?.seated ? '<button class="ghost" id="leave" type="button">离开牌桌</button>' : ''}
        <button class="ghost" id="logout" type="button">退出</button>
      </div>
    </header>`;
}

function bindHeader() {
  document.querySelector('#logout').onclick = logout;
  const leave = document.querySelector('#leave');
  if (leave) leave.onclick = () => send({ type: 'leave' });
}

function renderLobby() {
  const wallet = state.you.wallet;
  const max = Math.max(wallet, 0);
  if (buyInDraft > max) buyInDraft = max;
  if (max >= 1000 && (buyInDraft < 1000 || buyInDraft === 5000)) {
    buyInDraft = Math.min(5000, max);
  }
  const names = state.table.seats.filter((seat) => !seat.empty).map((seat) => seat.name);
  rootMode = 'lobby';
  root.innerHTML = `
    <main class="lobby-screen">
      ${header()}
      <section class="lobby">
        <article class="table-card">
          <div class="mini-felt">
            <strong>主桌</strong>
            <span id="occupied">${state.table.occupied} / 6 在座</span>
            <span>盲注 50 / 100</span>
          </div>
          <div>
            <h2>主桌</h2>
            <p class="meta">六人桌 · 无限制德州扑克<br>小盲 50，大盲 100。桌边已经坐着三位牌友。</p>
            <div class="names">${names.map((name) => `<span>${esc(name)}</span>`).join('')}</div>
            <div class="buyin-row"><span>买入</span><strong id="buyin-label">${fmt(buyInDraft)}</strong></div>
            <input id="buyin" type="range" min="${Math.min(1000, max)}" max="${Math.max(max, 1000)}" step="100" value="${Math.min(Math.max(buyInDraft, 0), Math.max(max, 1000))}">
            <button class="solid full" id="sit" type="button" ${max < 1 ? 'disabled' : ''}>入座</button>
            <p class="fine">断开后重新连接，会回到原来的座位。筹码留在桌上，离开牌桌后回到钱包。</p>
          </div>
        </article>
      </section>
    </main>`;
  bindHeader();
  const input = document.querySelector('#buyin');
  const label = document.querySelector('#buyin-label');
  input.oninput = () => {
    buyInDraft = Number(input.value);
    label.textContent = fmt(buyInDraft);
  };
  document.querySelector('#sit').onclick = () => {
    const amount = Math.min(max, Math.max(1000, Number(input.value) || 0));
    const buyIn = max < 1000 ? max : amount;
    send({ type: 'sit', buyIn });
  };
}

function renderTable() {
  const table = state.table;
  const street = table.phase === 'complete'
    ? (table.board.length === 5 ? '摊牌' : '本手结束')
    : (STREET[table.street] || '等待发牌');
  const board = Array.from({ length: 5 }, (_, index) => card(table.board[index] || '', ''));
  const seats = table.seats.map((seat) => {
    const [x, y] = SEATS[seat.index];
    if (seat.empty) {
      return `<div class="seat empty" style="left:${x};top:${y}">空位</div>`;
    }
    const cards = (seat.hole || []).map((item) => card(item, 'sm')).join('');
    const classes = ['seat', seat.isYou ? 'you' : '', seat.toAct ? 'acting' : '', seat.winner ? 'winner' : ''].filter(Boolean).join(' ');
    return `
      <div class="${classes}" style="left:${x};top:${y}">
        <div class="who-name"><span>${esc(seat.name)}${seat.role ? `<i class="role">${esc(seat.role)}</i>` : ''}</span></div>
        <div class="seat-cards">${cards}</div>
        <div class="stack">${fmt(seat.stack)}</div>
        <div class="status">${esc(seat.handName || seat.status || '')}</div>
      </div>
      ${seat.bet ? `<div class="bet" style="left:${BETS[seat.index][0]};top:${BETS[seat.index][1]}">${fmt(seat.bet)}</div>` : ''}`;
  }).join('');
  const hole = (state.you.hole || []).map((item) => card(item, 'lg')).join('') || '<span class="wait-note">这一手还没有底牌</span>';
  const actions = actionBar(table);
  const log = table.log.map((line) => `<div>${esc(line)}</div>`).join('');
  rootMode = 'table';
  root.innerHTML = `
    <main class="table-screen">
      ${header()}
      <section class="stage">
        <div class="felt"></div>
        <div class="center-stack">
          <div class="pot">底池 ${fmt(table.pot)}</div>
          <div class="street">第 ${table.handNumber || 0} 手 · ${street}</div>
          <div class="board">${board.join('')}</div>
          ${table.banner ? `<div class="banner">${esc(table.banner)}</div>` : ''}
        </div>
        ${seats}
      </section>
      <section class="dock">
        <div class="hole">${hole}</div>
        <div>${actions}</div>
        <div class="log">${log}</div>
      </section>
    </main>`;
  bindHeader();
  bindActions(table);
}

function actionBar(table) {
  const legal = table.legal;
  const wallet = state.you.wallet;
  const canRebuy = wallet > 0 && (!state.you.inHand || table.phase === 'complete');
  if (!legal) {
    return `<div class="actions"><span class="wait-note">${state.you.toAct ? '' : '等待其他玩家行动'}</span>${rebuyControl(canRebuy)}</div>`;
  }
  const buttons = [];
  if (legal.canFold) buttons.push('<button class="danger" type="button" data-act="fold">弃牌</button>');
  if (legal.canCheck) buttons.push('<button class="solid" type="button" data-act="check">过牌</button>');
  if (legal.canCall) {
    const label = legal.callAllIn ? `全下 ${fmt(legal.callAmount)}` : `跟注 ${fmt(legal.callAmount)}`;
    buttons.push(`<button class="solid" type="button" data-act="call">${label}</button>`);
  }
  let slider = '';
  if (legal.minRaiseTo != null) {
    slider = `
      <div class="slider">
        <div class="slider-top"><span>加注到</span><strong id="raise-label">${fmt(legal.minRaiseTo)}</strong></div>
        <input id="raise" type="range" min="${legal.minRaiseTo}" max="${legal.maxRaiseTo}" step="1" value="${legal.minRaiseTo}">
        <div class="presets">
          <button type="button" data-preset="${legal.minRaiseTo}">最低</button>
          ${legal.halfPotTo ? `<button type="button" data-preset="${legal.halfPotTo}">半池</button>` : ''}
          ${legal.potTo ? `<button type="button" data-preset="${legal.potTo}">满池</button>` : ''}
        </div>
      </div>
      <button class="raise" type="button" id="do-raise">加注</button>`;
  }
  if (legal.allInTo && !legal.callAllIn) {
    buttons.push('<button class="danger" type="button" data-act="allin">全下</button>');
  }
  const clock = turnDeadline ? '<span class="chip-pill" id="clock"></span>' : '';
  return `<div class="actions">${clock}${buttons.join('')}${slider}${rebuyControl(canRebuy)}</div>`;
}

function rebuyControl(show) {
  if (!show) return '';
  const max = state.you.wallet;
  const value = Math.min(Math.max(rebuyDraft, Math.min(1000, max)), max);
  return `<button class="ghost tiny" type="button" id="rebuy">补码 ${fmt(value)}</button>`;
}

function bindActions(table) {
  document.querySelectorAll('[data-act]').forEach((button) => {
    button.onclick = () => send({ type: 'action', action: button.dataset.act });
  });
  const slider = document.querySelector('#raise');
  const label = document.querySelector('#raise-label');
  const raise = document.querySelector('#do-raise');
  if (slider && raise) {
    const paint = () => { label.textContent = fmt(slider.value); };
    slider.oninput = paint;
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.onclick = () => {
        slider.value = button.dataset.preset;
        paint();
      };
    });
    raise.onclick = () => send({ type: 'action', action: 'raise', amount: Number(slider.value) });
  }
  const rebuy = document.querySelector('#rebuy');
  if (rebuy) {
    rebuy.onclick = () => {
      const max = state.you.wallet;
      const amount = max < 1000 ? max : Math.min(max, Math.max(1000, rebuyDraft || 2000));
      send({ type: 'rebuy', amount });
    };
  }
  const clock = document.querySelector('#clock');
  if (clock && turnDeadline) {
    const secs = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
    clock.textContent = `${secs} 秒`;
  }
}

async function logout() {
  const current = token;
  token = null;
  localStorage.removeItem('qz_token');
  socket?.close();
  socket = null;
  state = null;
  rootMode = '';
  if (current) {
    await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${current}` } }).catch(() => {});
  }
  render();
}

setInterval(() => {
  const clock = document.querySelector('#clock');
  if (!clock || !turnDeadline) return;
  const secs = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  clock.textContent = `${secs} 秒`;
}, 250);

async function boot() {
  if (!token) {
    render();
    return;
  }
  try {
    await api('/api/me');
    connect();
    render();
  } catch {
    token = null;
    localStorage.removeItem('qz_token');
    render();
  }
}

boot();
