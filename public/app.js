const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatText = document.getElementById('chatText');
const callsignInput = document.getElementById('callsign');
const pttButton = document.getElementById('pttButton');
const pttNote = document.getElementById('pttNote');
const settingsBadge = document.getElementById('settingsBadge');
const settingsUnavailable = document.getElementById('settingsUnavailable');
const loginBox = document.getElementById('loginBox');
const loginMessage = document.getElementById('loginMessage');
const bmConfigForm = document.getElementById('bmConfigForm');
const saveMessage = document.getElementById('saveMessage');
const storageNote = document.getElementById('storageNote');

let socket = null;
let reconnectTimer = null;
let settingsReady = false;
let savedPasswordExists = false;

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
    statusEl.textContent = '網頁已連線 · BM 未連線';
    statusEl.classList.add('online');
  });
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'system') addMessage(data.text, 'SYSTEM');
    else if (data.type === 'chat') addMessage(data.text, data.callsign, data.time);
  });
  socket.addEventListener('close', () => {
    statusEl.textContent = '網頁重新連線中';
    statusEl.classList.remove('online');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 3000);
  });
  socket.addEventListener('error', () => {
    statusEl.textContent = '網頁連線異常';
    statusEl.classList.remove('online');
  });
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== button.dataset.panel));
    if (button.dataset.panel === 'settings') refreshSettingsStatus();
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
  socket.send(JSON.stringify({ type: 'chat', callsign: callsignInput.value.trim() || 'WEB USER', text }));
  chatText.value = '';
  chatText.focus();
});

function setPttPressed(pressed) {
  pttButton.classList.toggle('pressed', pressed);
  pttButton.setAttribute('aria-pressed', String(pressed));
  pttButton.innerHTML = pressed ? '🎙<span>PTT 按下（示意）</span>' : '🎙<span>按住通話</span>';
  pttNote.textContent = pressed
    ? '按鍵狀態示意：目前尚未連接 DMR 語音引擎，沒有傳送語音或 DMR 訊號。'
    : '目前尚未連接 DMR 語音引擎；按鍵不會發射或傳送 BM 語音。';
}
pttButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (pttButton.setPointerCapture) {
    try { pttButton.setPointerCapture(event.pointerId); } catch {}
  }
  setPttPressed(true);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => pttButton.addEventListener(name, () => setPttPressed(false)));
window.addEventListener('blur', () => setPttPressed(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) setPttPressed(false); });

document.getElementById('smsButton').addEventListener('click', () => {
  alert('目前是介面原型，DMR 簡訊後端尚未接通。');
});

async function refreshSettingsStatus() {
  try {
    const response = await fetch('/api/settings/status', { credentials: 'same-origin' });
    const data = await response.json();
    settingsReady = Boolean(data.ready);
    storageNote.textContent = data.storageNote || '';
    if (!settingsReady) {
      settingsBadge.textContent = '尚未設定伺服器';
      settingsUnavailable.classList.remove('hidden');
      settingsUnavailable.textContent = '管理登入與加密儲存尚未啟用。部署管理員需先設定 RX_ADMIN_PASSWORD、RX_ADMIN_SESSION_SECRET、BM_CONFIG_ENCRYPTION_KEY，以及持久化的 BM_CONFIG_FILE。這些是伺服器環境變數，不是 BrandMeister 認證欄位。';
      loginBox.classList.add('hidden');
      bmConfigForm.classList.add('hidden');
      return;
    }
    settingsUnavailable.classList.add('hidden');
    loginBox.classList.remove('hidden');
    if (data.authenticated) {
      settingsBadge.textContent = data.saved ? '已儲存加密設定' : '尚未設定 BM 認證';
      loginBox.classList.add('hidden');
      bmConfigForm.classList.remove('hidden');
      await loadSavedConfig();
    } else {
      settingsBadge.textContent = '請登入';
      loginBox.classList.remove('hidden');
      bmConfigForm.classList.add('hidden');
    }
  } catch {
    settingsBadge.textContent = '無法連線';
    loginMessage.textContent = '無法讀取設定狀態，請稍後重試。';
  }
}

async function loadSavedConfig() {
  try {
    const response = await fetch('/api/bm-config', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '讀取設定失敗');
    document.getElementById('bmCallsign').value = data.callsign || '';
    document.getElementById('bmRadioId').value = data.radioId || '';
    document.getElementById('bmPassword').value = '';
    document.getElementById('bmPassword').placeholder = data.hasPassword
      ? '已儲存密碼；留空代表不更改'
      : '首次設定請輸入 Hotspot Security Password';
    savedPasswordExists = Boolean(data.hasPassword);
    const select = document.getElementById('bmMaster');
    const custom = document.getElementById('bmCustomMaster');
    if ([...select.options].some(option => option.value === data.masterHost)) {
      select.value = data.masterHost;
      custom.value = '';
    } else if (data.masterHost) {
      select.value = '2322.master.brandmeister.network';
      custom.value = data.masterHost;
    }
    saveMessage.textContent = data.saved
      ? '已載入設定摘要。為保護密碼，密碼欄不會顯示已儲存內容。'
      : '尚未儲存認證資料。';
  } catch (error) {
    saveMessage.textContent = error.message;
  }
}

document.getElementById('loginButton').addEventListener('click', async () => {
  const password = document.getElementById('adminPassword').value;
  if (!password) {
    loginMessage.textContent = '請輸入 RX link 管理密碼。';
    return;
  }
  loginMessage.textContent = '正在驗證…';
  try {
    const response = await fetch('/api/settings/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await response.json();
    document.getElementById('adminPassword').value = '';
    if (!response.ok) throw new Error(data.error || '登入失敗');
    loginMessage.textContent = '登入成功。';
    await refreshSettingsStatus();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

document.getElementById('bmConfigForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const customHost = document.getElementById('bmCustomMaster').value.trim();
  const payload = {
    callsign: document.getElementById('bmCallsign').value.trim(),
    radioId: document.getElementById('bmRadioId').value.trim(),
    hotspotPassword: document.getElementById('bmPassword').value,
    masterHost: customHost || document.getElementById('bmMaster').value
  };
  saveMessage.textContent = '正在加密儲存…';
  try {
    const response = await fetch('/api/bm-config', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '儲存失敗');
    document.getElementById('bmPassword').value = '';
    savedPasswordExists = true;
    settingsBadge.textContent = '已儲存加密設定';
    callsignInput.value = data.callsign;
    saveMessage.textContent = data.message + ' 密碼已清空，不會回傳到頁面。';
  } catch (error) {
    saveMessage.textContent = error.message;
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await fetch('/api/settings/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    bmConfigForm.classList.add('hidden');
    loginBox.classList.remove('hidden');
    settingsBadge.textContent = '已登出';
    loginMessage.textContent = '已登出設定介面。';
    savedPasswordExists = false;
  }
});

fetch('/api/status')
  .then(response => response.json())
  .then(data => {
    statusEl.textContent = data.bmAdapterConfigured ? 'BM 設定存在（未驗證）' : '網頁已連線 · BM 未連線';
  })
  .catch(() => { statusEl.textContent = '服務狀態未知'; });

connectSocket();
