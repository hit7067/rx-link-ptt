# RX link BrandMeister 設定頁：伺服器安全設定

這個版本加入了設定頁與加密儲存 API，但**還沒有把儲存的認證交給 ProxDMR，也沒有真正的 BM 語音/PTT 連線**。請先不要把這個功能當成已完成的 DMR 電台。

## 1. 必要的伺服器環境變數

在部署平台的 Secret / Environment Variables 設定以下值。不要把實際值放進 GitHub、前端檔案或聊天：

- `RX_ADMIN_PASSWORD`：用來登入 RX link「BM 設定」頁的管理密碼，與 BM 密碼不同。
- `RX_ADMIN_SESSION_SECRET`：至少 32 個字元的隨機秘密，用來簽署管理登入 Cookie。
- `BM_CONFIG_ENCRYPTION_KEY`：恰好 64 個十六進位字元（32 bytes）的 AES-256 金鑰。
- `BM_CONFIG_FILE`：加密設定檔的完整路徑，必須位於持久化磁碟。

在可信任的 Linux shell 上產生兩個隨機金鑰（每個指令的輸出分別放入對應環境變數）：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

第一個輸出可用作 `RX_ADMIN_SESSION_SECRET`，第二個輸出可用作 `BM_CONFIG_ENCRYPTION_KEY`。不要把這兩個值提交到 Git。

## 2. 持久化儲存

例如，若主機已掛載持久化磁碟至 `/var/data`，設定：

```text
BM_CONFIG_FILE=/var/data/bm-config.enc
```

應限制該目錄的存取權。加密設定檔使用 AES-256-GCM，檔案以限制權限建立；伺服器不會透過 API 回傳已儲存的 BM 密碼。若遺失或更換加密金鑰，舊設定將無法解密。

Render 的一般容器檔案系統可能在重新部署時重設。**在確認持久化磁碟已設定以前，不要在正式環境儲存真實認證資料。** 不要因為看到「加密儲存」字樣就忽略持久化問題。

## 3. 介面使用方式

1. 開啟 RX link，進入「BM 設定」。
2. 使用 `RX_ADMIN_PASSWORD` 登入管理設定。
3. 輸入呼號、DMR ID、Hotspot Security Password 和 BM Master。
4. 按「加密儲存設定」。儲存後密碼欄會清空；留空更新密碼欄代表保留先前密碼。
5. 登出設定。

管理登入使用 HttpOnly、SameSite=Strict Cookie，Cookie 有效期為 4 小時；登入有基本的 IP 嘗試次數限制。管理頁務必使用 HTTPS。

## 4. 尚未完成的功能

- 尚未把這些設定接入 ProxDMR 的實際 gateway。
- 尚未建立 BM 連線、Talkgroup 控制 API、麥克風上行或接收語音播放。
- PTT 紅色狀態目前仍是介面示意，不會發射。
- Call Alert 目前不在開發範圍。

真正收發語音仍需在支援 UDP 的 Linux VPS 部署 ProxDMR，並完成後端整合與通聯測試。現有 Render Web Service 不應被當成 Homebrew DMR UDP gateway。
