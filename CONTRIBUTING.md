# Contributing to RX link PTT

Thanks for helping with RX link PTT. This project handles live DMR audio, so keep changes small and test receive and transmit independently.

## Workflow

1. Create a branch from the latest `main`, for example `fix/rx-audio-buffer` or `feat/caller-display`.
2. Make one focused change per pull request.
3. Describe the observed problem, the code path changed, and how it was tested.
4. Open a pull request to `main`; do not force-push or rewrite shared history.
5. Do not merge audio/protocol changes until the Render build succeeds and the affected BM test has been performed.

## Important audio/protocol invariants

- Browser PCM is mono, signed 16-bit little-endian, 8 kHz.
- One PCM frame is 160 samples / 320 bytes / 20 ms.
- One AMBE+2 frame is 9 bytes; one ODTP voice payload currently carries 3 frames / 27 bytes / 60 ms.
- Do not change AMBE frame representation, ODTP flags, FLC fields, frame cadence, or jitter-buffer timing based only on a successful login. Validate real receive and transmit audio.
- Group-call signaling and private-call signaling must be tested separately.
- Keep caller-ID display and receive audio working while changing packet parsing.

## Security

- Never commit BM Hotspot Security Passwords, session tokens, API keys, or real user credentials.
- Never add credentials or raw audio to logs, screenshots, issues, or pull requests.
- Do not log secret request bodies.
- Before sharing the deployed URL broadly, make sure the web service has access controls and rate limiting.

## Before opening a pull request

- Check JavaScript syntax and confirm the Docker/Render build succeeds.
- Test login and disconnect.
- Test group RX, group TX, PTT release, and caller display.
- Test private-call signaling separately if that code changed.
- State clearly which tests were performed and which remain unverified.
