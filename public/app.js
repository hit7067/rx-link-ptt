const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatText = document.getElementById('chatText');
const pttButton = document.getElementById('pttButton');
const pttNote = document.getElementById('pttNote');
const privatePttButton = document.getElementById('privatePttButton');
const privatePttNote = document.getElementById('privatePttNote');
const callsignSetting = document.getElementById('bmCallsign');
const radioIdSetting = document.getElementById('bmRadioId');
const identityCallsign = document.getElementById('identityCallsign');
const identityRadioId = document.getElementById('identityRadioId');
const privateSearch = document.getElementById('privateSearch');
const privateResults = document.getElementById('privateResults');
const privateId = document.getElementById('privateId');
const privateTarget = document.getElementById('privateTarget');

let socket = null;
let reconnectTimer = null;
let lookupTimer = null;\nlet bmSessionToken = null;\nlet selectedPrivateContact = null;\nlet pttPressed = false;

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

function showPanel(panelId) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== panelId));
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => showPanel(button.dataset.panel));
});
document.getElementById('goSettings').addEventListener('click', () => showPanel('settings'));

function updateIdentity() {
  const callsign = callsignSetting.value.trim().toUpperCase();
  const radioId = radioIdSetting.value.trim();
  identityCallsign.textContent = callsign || '尚未設定';
  identityRadioId.textContent = radioId || '尚未設定';
  try {
    localStorage.setItem('rxlink.callsign', callsign);
    localStorage.setItem('rxlink.radioId', radioId);
  } catch {}
}
try {
  callsignSetting.value = localStorage.getItem('rxlink.callsign') || '';
  radioIdSetting.value = localStorage.getItem('rxlink.radioId') || '';
} catch {}
updateIdentity();
callsignSetting.addEventListener('input', updateIdentity);
radioIdSetting.addEventListener('input', updateIdentity);

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
    callsign: callsignSetting.value.trim().toUpperCase() || 'WEB USER',
    text
  }));
  chatText.value = '';
  chatText.focus();
});

function setPttPressed(button, note, pressed) {
  button.classList.toggle('pressed', pressed);
  button.textContent = pressed ? 'PTT 按下中（預覽）' : '按住 PTT';
  note.textContent = pressed
    ? '按鍵狀態預覽中；目前沒有傳送語音或 DMR 訊號。'
    : '目前為介面預覽，尚未傳送真實 DMR 語音。';
}
function wirePtt(button, note, mode) {
  const press = () => {
    if (pttPressed) return;
    pttPressed = true;
    setPttPressed(button, note, true);
    if (socket && socket.readyState === WebSocket.OPEN && bmSessionToken) {
      const targetId = mode === 'private' ? privateId.value.trim() : document.getElementById('talkgroup').value.trim();
      const targetCallsign = mode === 'private' && selectedPrivateContact ? selectedPrivateContact.callsign : '';
      socket.send(JSON.stringify({ type: 'ptt-start', sessionToken: bmSessionToken, mode, targetId, targetCallsign }));
    } else {
      note.textContent = '尚未建立 BM 持續連線；請先到設定頁登入。';
    }
  };
  const release = () => {
    if (!pttPressed) return;
    pttPressed = false;
    setPttPressed(button, note, false);
    if (socket && socket.readyState === WebSocket.OPEN && bmSessionToken) {
      socket.send(JSON.stringify({ type: 'ptt-stop', sessionToken: bmSessionToken, mode }));
    }
  };
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); press(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => button.addEventListener(name, release));
  button.addEventListener('keydown', (event) => {
    if (event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return;
    event.preventDefault(); press();
  });
  button.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') release();
  });
}
wirePtt(pttButton, pttNote, 'group');
wirePtt(privatePttButton, privatePttNote, 'private');

document.getElementById('smsButton').addEventListener('click', () => {
  alert('目前是介面原型，DMR 簡訊後端尚未接通。');
});

function renderPrivateResults(items, message) {
  privateResults.replaceChildren();
  if (!items || !items.length) {
    const p = document.createElement('p');
    p.className = 'muted-text';
    p.textContent = message || '沒有找到符合的 DMR ID。';
    privateResults.appendChild(p);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lookup-result';
    const title = document.createElement('strong');
    title.textContent = `${item.callsign || '未知呼號'} · ${item.id || ''}`;
    const detail = document.createElement('span');
    detail.textContent = [item.name, item.city, item.country].filter(Boolean).join(' · ') || '公開 DMR ID 名錄';
    button.append(title, detail);
    button.addEventListener('click', () => {
      privateId.value = String(item.id || '');
      privateTarget.textContent = [item.callsign, item.name, item.id].filter(Boolean).join(' · ');
      privateResults.querySelectorAll('.lookup-result').forEach((node) => node.classList.toggle('selected', node === button));
    });
    privateResults.appendChild(button);
  });
}

async function searchPrivateContact() {
  const q = privateSearch.value.trim();
  if (q.length < 2) {
    renderPrivateResults([], '請輸入至少 2 個字元再查詢。');
    return;
  }
  privateResults.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'muted-text';
  loading.textContent = '正在查詢公開 DMR ID 名錄…';
  privateResults.appendChild(loading);
  try {
    const response = await fetch('/api/dmrid/search?q=' + encodeURIComponent(q));
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '查詢失敗');
    renderPrivateResults(data.results || [], data.detail);
  } catch (error) {
    renderPrivateResults([], error.message || '查詢失敗，請稍後重試。');
  }
}
document.getElementById('privateSearchButton').addEventListener('click', searchPrivateContact);
privateSearch.addEventListener('input', () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(searchPrivateContact, 450);
});
privateId.addEventListener('input', () => {
  if (!privateId.value.trim()) privateTarget.textContent = '尚未選擇個呼對象';
  else if (/^\d{7}$/.test(privateId.value.trim())) privateTarget.textContent = '目標 DMR ID：' + privateId.value.trim();
});

const bmLoginButton = document.getElementById('bmLoginButton');
bmLoginButton.addEventListener('click', async () => {
  const callsign = callsignSetting.value.trim().toUpperCase();
  const radioId = radioIdSetting.value.trim();
  const passwordInput = document.getElementById('bmPassword');
  const password = passwordInput.value;
  const host = document.getElementById('bmMaster').value.trim();
  const resultEl = document.getElementById('bmLoginResult');

  if (!callsign || !radioId || !password || !host) {
    resultEl.textContent = '請填寫呼號、本機 DMR ID、BM Hotspot Security Password 與 BM Server/Master。';
    return;
  }
  if (!/^\d{7}$/.test(radioId)) {
    resultEl.textContent = '本機 DMR ID 必須是 7 位數字。';
    return;
  }

  bmLoginButton.disabled = true;
  resultEl.textContent = '正在登入 BM，成功後會維持連線並啟動保活…';
  try {
    const response = await fetch('/api/bm/connect', {
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

document.getElementById('bmDisconnectButton').addEventListener('click', async () => {
  const token = bmSessionToken;
  if (!token) return;
  const button = document.getElementById('bmDisconnectButton');
  button.disabled = true;
  try {
    await fetch('/api/bm/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token })
    });
  } catch {}
  bmSessionToken = null;
  document.getElementById('bmConnectionStatus').textContent = 'BM 尚未連線';
  document.getElementById('bmLoginResult').textContent = '已中斷 BM 連線。';
  statusEl.textContent = '網頁已連線';
});
