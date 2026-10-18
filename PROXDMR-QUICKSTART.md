# RX link × ProxDMR：最快通聯部署

> 目前 RX link 原本的 Render 版本仍是網頁原型，沒有 DMR 語音引擎。要先真正連上 BrandMeister，最快做法是先在支援 UDP 的 Linux VPS 部署 ProxDMR；完成通聯後再把 RX link 品牌介面整合進去。此文件不代表已完成部署或已測試實際通聯。

## 需要準備

- 一台 Linux VPS（x86_64 或 ARM64），有公網 IP，能使用 Docker / Docker Compose。
- VPS 防火牆與雲端安全群組允許：TCP 8266、UDP 62031。
- 已有的業餘無線電呼號、DMR ID，以及 BrandMeister Hotspot Security Password。
- 建議使用自己的網域及有效 HTTPS 憑證；若先使用 ProxDMR 自簽憑證，首次開啟時瀏覽器會顯示憑證警告。

## 部署步驟（Ubuntu / Debian VPS）

以 SSH 登入 VPS 後執行：

```bash
git clone https://github.com/owlze/proxdmr.git
cd proxdmr
cp .env.example .env
nano .env
```

編輯 `.env`，至少修改：

- `HOST_IP`：填 VPS 公網 IP 或你準備使用的網域。
- `ADMIN_USER`：改成自己的管理員帳號。
- `ADMIN_PASSWORD`：設定唯一、夠長的密碼，**不要使用範例預設密碼**。
- `ALLOW_REGISTRATION=false`：保持關閉公開註冊。

啟動：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

確認容器正常後，在 iPhone Safari 開啟：

`https://你的VPS_IP或網域:8266`

登入後進入 ProxDMR 的 hotspot 設定，填入呼號、DMR ID、BrandMeister Hotspot Security Password，以及適用的 BM master host，儲存後查看連線狀態。

## 網路與安全

- VPS 防火牆及雲端安全群組需放行 TCP 8266 與 UDP 62031；不要把 UDP 62031 配到 Render Web Service。
- 管理介面不宜直接向全網公開。優先考慮 VPN（例如 Tailscale / WireGuard）或限制管理介面的來源 IP。
- 不要把 `.env`、BM 密碼、管理員密碼或 `config/` 資料夾提交到 GitHub。
- 請遵守所在地無線電法規、呼號與頻段規範，並確認你的 BrandMeister 帳號使用方式符合網路規則。

## RX link 下一階段

此部署先讓 ProxDMR 原生網頁介面提供真正的語音/PTT/Talkgroup 功能。之後才整合 RX link 外觀與觸控操作。整合前必須先檢查 ProxDMR 的登入、音訊串流、PTT 與 Talkgroup API，不能只靠前端按鈕假裝發射。Call Alert 暫不納入本階段。
