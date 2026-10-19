# RX link PTT

Mobile-first browser PTT client for BrandMeister DMR, designed for iPhone and desktop browsers. The app is served by Node.js/Express and uses WebSocket for browser audio/control, UDP ODTP/REWIND for the BrandMeister session, and the OpenDMR AMBE+2 codec bridge.

## Current implementation status

- **BrandMeister login/session:** implemented in the server; actual connectivity depends on valid user credentials and a supported BM master.
- **Group voice path:** browser microphone PCM → AMBE+2 encoder → ODTP voice packets; receive ODTP voice packets → AMBE+2 decoder → browser playback.
- **Receive caller display:** reads DMR call headers/terminators and looks up the caller's DMR ID.
- **Talkgroup subscription and PTT release:** implemented in the current code path.
- **Private call:** UI and transmit-header path exist, but end-to-end private-call interoperability has not been verified.
- **DMR SMS:** placeholder UI only; SMS transport is not implemented.
- **Audio quality and interoperability:** not yet confirmed as production-ready. A successful login alone does not prove that AMBE frame format, call signaling, or audio timing is correct.

Treat this as an actively developed test project, not a certified radio terminal. Verify every voice path with a permitted test destination before relying on it for operational communications.

## Run locally

Requirements: Node.js 20+, Git, C++ build tools, and network access to clone/build [OpenDMR](https://github.com/MW0MWZ/OpenDMR).

```bash
npm install
npm start
```

Open `http://localhost:3000`. The Docker build compiles the AMBE+2 bridge and is the deployment path configured for Render.

## BrandMeister setup

1. Open **設定 → BrandMeister 連線**.
2. Enter your own callsign, 7-digit DMR ID, BM Hotspot Security Password, and official BM master hostname.
3. Select **連線 BrandMeister** and verify the returned connection status.
4. Start with a permitted test talkgroup such as BM Parrot/Echo TG 9990 where available; confirm both receive and transmit separately.

The password is sent to the server for the login handshake and is not saved in browser local storage by the UI. Do not paste credentials into issues, pull requests, source files, or logs.

## Deploy on Render

The repository includes `Dockerfile` and `render.yaml`. Render should build the Docker image from the repository root and use `/api/status` as its health-check path. Keep the GitHub repository private unless you intentionally want to publish the source.

**Security note:** before sharing a public service URL widely, add authentication/access controls and rate limiting. Do not assume that a private GitHub repository makes the deployed web service private.

## Development notes

- Keep credentials and session tokens out of source control and logs.
- Do not delete or replace the AMBE codec bridge, ODTP/REWIND packet handling, or audio scheduler without checking both receive and transmit paths.
- Keep the README aligned with actual code. UI placeholders must not be described as implemented transport features.
