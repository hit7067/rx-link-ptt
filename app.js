const $ = (id) => document.getElementById(id);
let socket;
let callsign = 'WEB USER';

// Tabs
for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${button.dataset.tab}`));
  });
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    $('serverState').textContent = data.bmAdapterConfigured ? 'BM adapter 設定值存在，尚待連線驗證' : '網頁服務正常 · BM 未連線';
    if (data.bmAdapterConfigured) {
      $('statusBanner').innerHTML = '<strong>BM 設定已填入，尚未驗證連線</strong><p>需要安裝並啟用相容的 DMR gateway adapter，才能確認語音收發。</p>';
    }
  } catch {
    $('serverState').textContent = '無法連接後端';
  }
}
loadStatus();

function connectSocket() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}/ws`);
  socket.addEventListener('open', () => {
    $('connectionLabel').textContent = '網頁服務已連線';
    document.querySelector('.connection-pill .dot').style.background = 'var(--accent)';
  });
  socket.addEventListener('close', () => {
    $('connectionLabel').textContent = '重新連線中';
    document.querySelector('.connection-pill .dot').style.background = 'var(--warn)';
    setTimeout(connectSocket, 2000);
  });
  socket.addEventListener('message', event => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.type === 'chat' || packet.type === 'system') addMessage(packet);
  });
}
connectSocket();

function addMessage(packet) {
  const box = $('messages');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const item = document.createElement('div');
  item.className = 'message';
  const name = document.createElement('b'); name.textContent = packet.callsign || 'SYSTEM';
  const time = document.createElement('time'); time.textContent = packet.time ? new Date(packet.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
  const body = document.createElement('div'); body.textContent = packet.text || '';
  item.append(name, time, body); box.append(item); box.scrollTop = box.scrollHeight;
}

$('applyTg').addEventListener('click', () => {
  const tg = $('tgSelect').value;
  $('channelName').textContent = `TG ${tg}`;
  $('tgLabel').textContent = tg;
  $('speakerState').querySelector('strong').textContent = '等待通話';
  $('pttHint').textContent = `已選擇 TG ${tg}（介面狀態）；尚未透過 BM 切換實際 Talkgroup。`;
});

const ptt = $('pttButton');
function pttDown(event) {
  event.preventDefault(); ptt.classList.add('pressed');
  $('speakerState').querySelector('strong').textContent = 'PTT 按下（測試）';
  $('speakerState').querySelector('small').textContent = '此版本不會傳送 RF 或 BM 語音';
}
function pttUp() {
  ptt.classList.remove('pressed');
  $('speakerState').querySelector('strong').textContent = '等待通話';
  $('speakerState').querySelector('small').textContent = 'PTT 測試結束，尚未連接 DMR 語音引擎';
}
ptt.addEventListener('pointerdown', pttDown);
['pointerup','pointercancel','pointerleave'].forEach(name => ptt.addEventListener(name, pttUp));
window.addEventListener('blur', pttUp);

$('callBtn').addEventListener('click', () => {
  const id = $('privateId').value.trim();
  $('callNote').textContent = /^\d{1,9}$/.test(id) ? `已輸入目標 ID ${id}；尚未發起 DMR 個呼，後端功能待開發。` : '請輸入有效的數字 Radio ID。';
});
$('sendSms').addEventListener('click', () => {
  const id = $('smsId').value.trim(), text = $('smsText').value.trim();
  $('smsNote').textContent = !/^\d{1,9}$/.test(id) ? '請輸入有效的收件人 Radio ID。' : !text ? '請輸入訊息內容。' : `訊息已在介面中準備好給 ID ${id}；尚未傳送至 BM，DMR SMS adapter 待開發。`;
});
$('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('chatText').value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({type:'chat', callsign, text})); $('chatText').value = '';
});
