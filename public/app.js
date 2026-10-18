const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatText = document.getElementById('chatText');
const callsignInput = document.getElementById('callsign');
const pttButton = document.getElementById('pttButton');
const pttNote = document.getElementById('pttNote');

let socket = null;
let reconnectTimer = null;

function addMessage(text, callsign = 'SYSTEM', time = '') {
  const item = document.createElement('div');
  item.className = 'message';
  const name = document.createElement('strong');
  name.textContent = callsign;
  const body = document.createElement('div');
  body.textContent = text;
  item.append(name, body);
  if (time) {
    const date = new Date(time);
    const small = document.createElement('small');
    small.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
    item.appendChild(small);
  }
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => {
    statusEl.textContent = '網頁已連線';
    statusEl.classList.add('online');
  });
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'system') addMessage(data.text, 'SYSTEM');
    else if (data.type === 'chat') addMessage(data.text, data.callsign, data.time);
  });
  socket.addEventListener('close', () => {
    statusEl.textContent = '連線中斷';
    statusEl.classList.remove('online');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 3000);
  });
  socket.addEventListener('error', () => {
    statusEl.textContent = '連線異常';
    statusEl.classList.remove('online');
  });
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== button.dataset.panel));
  });
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatText.value.trim();
  if (!text) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addMessage('目前沒有連上文字測試服務，請稍後再試。');
    return;
  }
  socket.send(JSON.stringify({
    type: 'chat',
    callsign: callsignInput.value.trim() || 'WEB USER',
    text
  }));
  chatText.value = '';
  chatText.focus();
});

function setPttPressed(pressed) {
  pttButton.classList.toggle('pressed', pressed);
  pttButton.textContent = pressed ? '測試中…' : '按住通話（尚未接通）';
  pttNote.textContent = pressed
    ? '這只是按鍵介面測試，沒有傳送語音或 DMR 訊號。'
    : 'BM 登入成功不代表語音已接通；目前尚未傳輸真實 DMR 語音。';
}
pttButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  setPttPressed(true);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => {
  pttButton.addEventListener(name, () => setPttPressed(false));
});

document.getElementById('smsButton').addEventListener('click', () => {
  alert('目前是介面原型，DMR 簡訊後端尚未接通。');
});

const bmLoginButton = document.getElementById('bmLoginButton');
bmLoginButton.addEventListener('click', async () => {
  const callsign = document.getElementById('bmCallsign').value.trim();
  const radioId = document.getElementById('bmRadioId').value.trim();
  const passwordInput = document.getElementById('bmPassword');
  const password = passwordInput.value;
  const host = document.getElementById('bmMaster').value.trim();
  const resultEl = document.getElementById('bmLoginResult');

  if (!callsign || !radioId || !password || !host) {
    resultEl.textContent = '請填寫呼號、DMR ID、BM Hotspot Security Password 與 BM Server/Master。';
    return;
  }

  bmLoginButton.disabled = true;
  resultEl.textContent = '正在向 BM Master 進行登入握手…';
  try {
    const response = await fetch('/api/bm/login-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, radioId, password, host })
    });
    const data = await response.json();
    resultEl.textContent = data.detail || '未取得登入結果。';
    if (data.stage) resultEl.textContent += '（階段：' + data.stage + '）';
  } catch {
    resultEl.textContent = '無法連到 RX link 伺服器，請稍後重試。';
  } finally {
    // Never retain the password in the page after an attempt.
    passwordInput.value = '';
    bmLoginButton.disabled = false;
  }
});

fetch('/api/status')
  .then((response) => response.json())
  .then((data) => {
    if (data.status !== 'not-connected') statusEl.textContent = '服務正常';
  })
  .catch(() => { statusEl.textContent = '服務狀態未知'; });

connectSocket();
