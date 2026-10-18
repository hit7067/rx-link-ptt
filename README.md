# RX link PTT — fresh project scaffold

Mobile-first web client for a planned BrandMeister-connected DMR client.

## Current state

This is a new standalone project (not based on the old Replit project). It includes:
- Responsive PTT-style UI for iPhone / Android / desktop
- Tabbed Group PTT / Private Call / SMS screens
- Node.js status endpoint and WebSocket-based local test text chat
- Server-side environment variable template

**It is not yet connected to BrandMeister.** The PTT button currently demonstrates UI state only; it does not transmit audio. Private call and DMR SMS are interface placeholders. A compatible, authorized DMR gateway/adapter must be implemented and tested before real DMR operation.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Configure safely

Fill secrets only in the server environment (for example a host's Secrets / environment settings), never in `public/app.js` or any browser-visible file:

- `BM_RADIO_ID`
- `BM_HOTSPOT_PASSWORD`
- `BM_MASTER_HOST`
- `BM_MASTER_PORT`

These values alone do not create a working BM connection. `BM_ADAPTER_ENABLED` must not be set to true until the compatible gateway adapter is implemented and tested. Do not publish this service with BM credentials until authentication, authorization, rate limits, and access controls are in place.

## Next engineering milestone

Implement a server-side DMR adapter with explicit support for:
1. BrandMeister connection using the user's own permitted Radio ID / hotspot credentials.
2. Group voice TX/RX and safe PTT release.
3. Private Call TX/RX.
4. DMR SMS TX/RX.

Verify support and network rules before choosing a protocol/library. Do not assume a BM account-management API is a voice or SMS transport API.
