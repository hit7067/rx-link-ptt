
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
    small.textContent = Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString();
    item.appendChild(small);
  }

  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function connectSocket() {
  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener('open', () => {
    statusEl.textContent = '網頁已連線';
    statusEl.classList.add('online');
  });

  socket.addEventListener('message', (event) => {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === 'system') {
      addMessage(data.text, 'SYSTEM');
    } else if (data.type === 'chat') {
      addMessage(data.text, data.callsign, data.time);
    }
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
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab === button);
    });

    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== button.dataset.panel);
    });
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
  pttButton.textContent = pressed ? '測試中…' : '按住通話（測試）';
  pttNote.textContent = pressed
    ? '這只是按鍵介面測試，沒有傳送語音或 DMR 訊號。'
    : '目前為網頁測試模式，不會發射 DMR 射頻訊號。';
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

fetch('/api/status')
  .then((response) => response.json())
  .then((data) => {
    if (data.status !== 'not-connected') {
      statusEl.textContent = '服務正常';
    }
  })
  .catch(() => {
    statusEl.textContent = '服務狀態未知';
  });

connectSocket();
