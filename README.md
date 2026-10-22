# Week 8 — Real-Time Web Communication & PWAs

This folder contains the **lecture deliverables and reference sample app** for Web Development Week 8.

## Contents

| File / folder                | Purpose                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `Week08-Lecture-Notes.md`    | The single comprehensive markdown lecture notes (~3 h, no code samples).                       |
| `Week08-Slides.html`         | Linear HTML slide deck (Reveal.js via CDN). Open in any modern browser; use Left/Right or the previous/next arrows. |
| `Week08-Slides.pptx`         | Matching PowerPoint deck.                                                                      |
| `build_pptx.py`              | Script that builds `Week08-Slides.pptx` from the same outline (uses `python-pptx`).            |
| `sample-app/`                | The React + ASP.NET Core demo application — see `sample-app/README.md` for run instructions.  |

## Topics covered

1. Communication models — decide before you reach for an API
2. HTTP baseline
3. HTTP polling — short + long
4. HTTP streaming (fetch streams / NDJSON / chunked responses)
5. Server-Sent Events (SSE)
6. WebSockets
7. SignalR
8. WebRTC (media + data channels)
9. Service Workers
10. Web Push (VAPID)
11. Progressive Web Apps
12. Adjacent tech: gRPC streaming, MQTT, GraphQL subscriptions, WebTransport, Webhooks, BroadcastChannel/SharedWorker
13. Cross-cutting concerns: scaling, security, observability, cost

## Suggested 3-hour pacing

| Block | Topic | Minutes |
| --- | --- | ---: |
| 1 | Framing + communication models + HTTP baseline | 18 |
| 2 | Short + long polling | 15 |
| 3 | HTTP streaming + SSE | 18 |
| 4 | WebSockets | 22 |
| 5 | SignalR | 20 |
| — | Break | 10 |
| 6 | WebRTC | 25 |
| 7 | Service Workers + Web Push | 20 |
| 8 | PWA / offline architecture | 15 |
| 9 | Adjacent tech round-up | 10 |
| 10 | Decision matrix + sample-app walkthrough | 7 |

## Coverage highlights

The lecture emphasizes:

- Adding HTTP streaming as a distinct topic before SSE (LLM token UX).
- Making the SSE auth header limitation explicit and demonstrating the trade-off in the sample app.
- Promoting Service Workers to a first-class section instead of treating them as a sub-bullet of PWA.
- Calling out WebRTC TURN as a non-negotiable production requirement.
- Adding Webhooks, BroadcastChannel, and SharedWorker to the adjacent-tech round-up.
- Marking HTTP/2 server push as deprecated.

## Sample application status

All nine backend technologies pass end-to-end smoke tests (`sample-app/e2e-test.mjs` and `sample-app/e2e-signalr.mjs`):

```
✓ auth                  JWT bearer issued
✓ polling short         items returned
✓ polling long          items returned within timeout
✓ http streaming        NDJSON chunks streamed
✓ sse                   welcome + named events received
✓ websocket             echo + server-pushed tick
✓ signalr               WebSockets transport + broadcast + RPC return
✓ web push vapid        public key + subscription endpoint
✓ telemetry summary     events per technology aggregated
```

Frontend builds cleanly with `npm run build` (Vite + vite-plugin-pwa generates a service worker and `manifest.webmanifest`).

See [`sample-app/README.md`](sample-app/README.md) for full run / build / test instructions.
