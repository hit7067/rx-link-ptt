# Deploy RX link PTT (prototype)

This repository is deployable as a web prototype. It is **not yet a real BrandMeister client**: DMR voice, private calls and DMR SMS are not implemented.

## Quickest hosted deployment (Render)

1. Create a GitHub repository and upload the contents of this folder (not the ZIP file itself).
2. In Render, choose **New + → Blueprint** and select the repository containing `render.yaml`.
3. Render will build the Docker image and publish a URL similar to `https://rx-link-ptt.onrender.com`.
4. Open the URL and test the interface and website-local test chat.

The URL is assigned by Render only after you deploy it; this project does not contain a pre-created public URL.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Before connecting BrandMeister

Do not set `BM_ADAPTER_ENABLED=true` yet. The DMR adapter has not been implemented. Do not expose BM credentials until a compatible, authorized adapter and access controls have been built and tested. Store credentials only as server-side environment variables, never in `public/` files.
