# Realtime Demo — Week 8 sample application

A reference React + ASP.NET Core (.NET 8) application that demonstrates the real-time technologies featured in the Week 8 lecture, with each sample technology on its own page and instrumented with **Application Insights**-tagged telemetry.

| Page          | Technology                       | Lecture section |
| ------------- | -------------------------------- | --------------- |
| `/polling`    | HTTP short polling + long polling | §4              |
| `/streaming`  | HTTP streaming (NDJSON over POST) | §5              |
| `/sse`        | Server-Sent Events                | §6              |
| `/websocket`  | Raw WebSocket                     | §7              |
| `/signalr`    | SignalR (chat hub)                | §8              |
| `/webrtc`     | WebRTC (P2P data channel)         | §9              |
| `/push`       | Web Push (VAPID)                  | §11             |
| `/pwa`        | PWA install + offline             | §12             |
| `/compare`    | Telemetry summary across all techs | n/a            |
| `/mcp-demo`   | MCP tools, MCP Apps and live activity | §§16–19         |

---

## Prerequisites

- **.NET 8 SDK** (`8.0.126`; `global.json` allows the latest feature band) — `dotnet --version` should print an 8.0 SDK.
- **Node.js 20+** with npm.

> A `global.json` in this directory pins the .NET SDK version so all students use the same toolchain.

## Run the backend

```powershell
cd backend\RealtimeDemo.Api
dotnet restore
dotnet run --no-launch-profile --urls "http://127.0.0.1:5090"
```

The first run creates the SQLite database (`realtimedemo.db`) and a development VAPID key-pair (`vapid.json`). Both are written next to the project file.

To enable live Application Insights telemetry, set the connection string in `appsettings.json` or as an environment variable:

```powershell
$env:ApplicationInsights__ConnectionString = "InstrumentationKey=...;IngestionEndpoint=..."
```

Without a connection string the SDK is registered passively, telemetry stays in the local SQLite mirror, and the `Compare` page still works.

## Run the frontend

```powershell
cd frontend
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite dev server proxies `/api`, `/hubs`, `/ws`, and `/mcp` to the backend.

For an installable production build:

```powershell
npm run build
npm run preview
```

## Default credentials

The login form pre-fills `alice / password`. Use the *Register* button on first run.

## Known-good environment

| Component  | Tested version       | Notes                                                                    |
| ---------- | -------------------- | ------------------------------------------------------------------------ |
| .NET SDK   | 8.0.126              | Pinned by `global.json`; `rollForward` is `latestFeature`.              |
| Node.js    | 20+                  | Frontend dependencies are installed from the checked-in lockfile.      |
| npm        | 10+                  | Bundled with Node.                                                       |
| Browser    | Chrome / Edge       | Safari/WebKit behavior has not been verified; Web Push on iOS needs an installed PWA. |
| OS         | Windows / macOS / Linux | Backend uses SQLite, no native dependencies.                          |

Run everything on `localhost` for development — service workers, Web Push, and WebRTC all relax their HTTPS requirement on `localhost`. **Production must be HTTPS.**

## Troubleshooting checklist

| Symptom | First thing to check |
| --- | --- |
| Page shows a stale UI after a code change | Service worker is serving cached files — DevTools → Application → Service Workers → Unregister, then reload. The `/pwa` page has an *Unregister SW* button as a kill switch. |
| Push notifications never appear | Permission denied, HTTPS missing, VAPID keys not configured, or the OS notification center is muted. The `/push` page prints permission state and the server endpoint response. |
| WebRTC stays in `connecting` forever | This sample uses **STUN only**. On most LANs it works; behind a restrictive NAT you must add a TURN server. Try both peers in the same browser first to confirm the data-channel logic. |
| SignalR is using *Long Polling* in dev tools | A proxy / firewall is blocking WebSocket upgrade. Confirm Vite's `ws: true` proxy is forwarding to the backend (check `vite.config.ts`). |
| `?access_token=…` shows up in logs | **Stop and redact.** SSE / WebSocket / SignalR-on-WS all rely on the token query parameter because the browser can't set headers; production proxies and observability pipelines must strip it. |
| `dotnet run` complains about SDK version | Use the .NET 8 SDK; `sample-app/global.json` pins 8.0.126 and permits `latestFeature` roll-forward. |
| Vite dev server cannot connect to backend | Backend must be on `http://127.0.0.1:5090` (the proxy target). Verify with `curl http://127.0.0.1:5090/api/health`. |

## End-to-end smoke tests

`e2e-test.mjs` covers authentication, polling, long polling, HTTP streaming, SSE, raw WebSocket, SignalR negotiate, the Web Push VAPID key, and telemetry summary. It does not test a full WebRTC session. `e2e-signalr.mjs` tests the SignalR hub with its official client, and `e2e-mcp.mjs` tests MCP tools, resources, prompts, job SSE, and MCP security. Install frontend packages with `npm ci` before running the first two scripts; `e2e-mcp.mjs` uses only Node.js built-ins. All scripts accept `BASE_URL` (default `http://127.0.0.1:5090`).

```powershell
# after `npm ci` in frontend/ and with the backend running on :5090
node e2e-test.mjs
node e2e-signalr.mjs
node e2e-mcp.mjs
```

Each script prints a green ✓ for each check.

## MCP and MCP Apps

The sample app is also an MCP server: MCP connects an AI host to your app through discoverable tools and request/response calls. MCP Apps add an interactive `ui://` view to a tool. The export monitor opens its own SSE stream because MCP itself is request/response — this is the lecture's **MCP + real-time** pattern.

- `POST /mcp` serves the stateless Streamable HTTP MCP endpoint.
- `GET /api/jobs/{id}/events` serves job progress as ticket-authenticated SSE.
- `/mcp-demo` shows live server activity over SignalR and includes an in-browser MCP client/Apps host as a fallback.

### Class demo with GitHub Copilot

1. In the Copilot desktop app's feature settings, enable **Inline MCP Apps** and restart the app. Alternatively, launch it with `COPILOT_MCP_APPS=true`.
2. Start the backend on port 5090 using the instructions above, and start the frontend with `npm ci` then `npm run dev` in `frontend/`.
3. Trust this repository folder in Copilot, then register the MCP server through the repository's `.github/mcp.json`, or run `copilot mcp add --transport http realtime-demo http://localhost:5090/mcp`.
4. Start a **new session**; MCP servers are loaded when a session starts.
5. Try: “Start a 15 second export of the orders dataset”, “Cancel it”, “Post 'Hello from Copilot' to the class chat”, and “Show the telemetry summary”. Keep `/mcp-demo` open alongside the conversation to show the SignalR live feed.

If Copilot does not forward `_meta` / `structuredContent`, or blocks the app's SSE connection, use `/mcp-demo`'s **Plan B**. It calls the same tools and renders the same MCP App view in the browser.

### Troubleshooting and security

- If the server is missing, trust the repository folder and start a new Copilot session. Confirm the backend is running on port 5090. If the app area is blank, check that the view's CSP `connectDomains` matches the backend base URL and that `Mcp__PublicBaseUrl` is configured correctly when needed.
- The **Inline MCP Apps** feature must be enabled, and the desktop app must be restarted after enabling it. Job tickets expire after 15 minutes; reopen the stream to obtain a fresh ticket.
- The `/mcp` endpoint validates Host and Origin to mitigate DNS rebinding. An optional `Mcp__ApiKey` requires a bearer token or `X-Api-Key`; `Mcp__AllowedHosts`, `Mcp__AllowedOrigins`, and `Mcp__PublicBaseUrl` configure the respective checks and advertised app URL.
- Job tickets are job-scoped, short-lived credentials passed in the SSE query string, so they can appear in access logs. The app view runs in a sandboxed iframe and declares a CSP; the demo is for local teaching and is **not hardened for the public internet**.

---

## Architecture quick-reference

```
┌────────────────────────┐                ┌─────────────────────────────┐
│   React + Vite + TS    │                │  ASP.NET Core (.NET 8)      │
│   (frontend, :5173)    │                │  RealtimeDemo.Api (:5090)   │
│                        │                │                             │
│  • Pages per tech      │   /api/*       │  • Controllers              │
│  • vite-plugin-pwa     │ ─────────────► │      Auth, Polling, SSE,    │
│  • SignalR client      │   /hubs/*      │      HttpStreaming, Push,   │
│  • EventSource         │ ─────────────► │      Telemetry              │
│  • WebSocket           │   /ws/*        │  • SignalR hub: ChatHub     │
│  • PushManager         │ ─────────────► │  • Raw WS: EchoWS           │
│  • Service Worker      │   /mcp         │  • MCP tools/resources      │
│                        │                │  • MCP Apps + job SSE       │
│                        │                │  • EF Core + SQLite         │
│                        │                │  • JWT bearer auth          │
│                        │                │  • Application Insights     │
└────────────────────────┘                │    TelemetryService         │
                                          └─────────────────────────────┘
```

## Things to point out in class

1. **Auth differences across transports.** REST and SignalR's *negotiate* call use `Authorization: Bearer …`; **SSE and raw WebSocket cannot** because the browser APIs don't allow custom headers. **SignalR is not magic here either** — when its chosen transport is WebSockets or SSE the JS client uses `accessTokenFactory` to pass the JWT via `?access_token=…`. The frontend therefore passes `?access_token=…` on those endpoints and a banner on each page explains the trade-off. **Never log full URLs in production**: redact the `access_token` query parameter at every proxy and observability layer.
2. **Same data, different delivery.** Polling, long polling, and SSE all read from the same `PollItems` table. Producing one item via the polling page is visible on the SSE page too.
3. **Transport negotiation.** Open DevTools → Network → WS while the SignalR page is connected. You'll see the negotiation request, then the WebSocket. Disable WebSockets in Chrome flags and watch SignalR fall back to SSE then long-polling.
4. **WebRTC TURN caveat.** The demo uses only STUN. On a LAN it works; behind a restrictive NAT it would need TURN. We deliberately don't ship a TURN server so students hit this in their lab.
5. **Service-worker lifecycle.** Reload the page after a code change and watch DevTools → Application → Service Workers for the `installing → waiting → active` flow. The `Unregister SW` button on `/pwa` is the kill switch.
6. **Telemetry per technology.** Every demo's events are tagged with `technology=<SSE|WebSocket|SignalR|…>`. In App Insights you can chart "events by technology" with no extra setup. The same rows are visible locally on the `Compare` page.
7. **MCP + real-time.** MCP connects an AI host to the app through request/response tools; MCP Apps pair a tool with a `ui://` view. The view opens its own SSE stream for live job progress, while the browser demo also receives SignalR events.

## Project layout

```
backend/
  RealtimeDemo.Api/
    Program.cs                     # composition root: CORS, auth, AI, DI
    appsettings.json
    Auth/                          # PBKDF2 password hasher
    Controllers/
      AuthController.cs            # register, login → JWT
      PollingController.cs         # short + long + produce
      HttpStreamingController.cs   # NDJSON streaming over POST
      SseController.cs             # text/event-stream
      PushController.cs            # VAPID public key, subscribe, send
      TelemetryController.cs       # summary / recent
      JobEventsController.cs        # ticket-authenticated job SSE
    Data/AppDbContext.cs           # EF Core context
    Models/Entities.cs             # User, ChatMessage, PollItem, …
    Hubs/ChatHub.cs                # SignalR hub + WebRTC signaling relay
    EchoWebSocketHandler.cs        # raw WebSocket echo + tick
    Mcp/                          # MCP tools, resources, prompts, jobs, tickets
      Views/job-monitor.html       # embedded MCP App view
    Telemetry/TelemetryService.cs  # App Insights + SQLite mirror
frontend/
  src/
    main.tsx                       # React entry + SW registration
    App.tsx                        # nav + router
    sw.ts                          # service worker (injectManifest)
    lib/
      auth.ts                      # token storage + buildSseUrl / buildWsUrl
      mcpClient.ts                  # minimal Streamable HTTP MCP client
      mcpAppHost.ts                 # sandboxed in-browser MCP Apps host
      useLog.tsx                   # tiny log hook used by every page
    pages/
      Home.tsx, Login.tsx
      PollingPage.tsx, HttpStreamingPage.tsx
      SsePage.tsx, WebSocketPage.tsx, SignalRPage.tsx
      WebRTCPage.tsx
      PushPage.tsx, PwaPage.tsx
      ComparePage.tsx, McpPage.tsx
  index.html, vite.config.ts, tsconfig.json, package.json
e2e-test.mjs       # node smoke test of REST/SSE/WS/HTTP-stream/Push/Polling
e2e-signalr.mjs    # node smoke test of the SignalR hub
e2e-mcp.mjs         # zero-dependency MCP/MCP Apps end-to-end test
global.json        # pins .NET SDK
```
