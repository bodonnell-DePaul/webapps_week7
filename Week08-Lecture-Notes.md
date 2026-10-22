# Web Development — Week 8

## Real-Time Web Communication, MCP & Progressive Web Apps
---

## Table of Contents

1. [Why "Real-Time" Matters](#1-why-real-time-matters)
2. [Communication Models — Pick Before You Code](#2-communication-models)
3. [The HTTP Request/Response Baseline](#3-the-http-baseline)
4. [HTTP Polling — Short Polling and Long Polling](#4-http-polling)
5. [HTTP Streaming (Fetch Streams / Chunked Responses)](#5-http-streaming)
6. [Server-Sent Events (SSE)](#6-server-sent-events-sse)
7. [WebSockets](#7-websockets)
8. [SignalR](#8-signalr)
9. [WebRTC (Media + Data Channels)](#9-webrtc)
10. [Service Workers — Programmable Network Proxy](#10-service-workers)
11. [Web Push Notifications](#11-web-push)
12. [Progressive Web Apps (PWA) & Offline Architecture](#12-progressive-web-apps-pwa)
13. [Adjacent Technologies You Should Recognize](#13-adjacent-technologies)
14. [How to Choose — Decision Framework](#14-decision-framework)
15. [Cross-Cutting Concerns: Scaling, Security, Observability](#15-cross-cutting-concerns)
16. [Model Context Protocol (MCP)](#16-model-context-protocol-mcp)
17. [MCP Apps: Interactive Views](#17-mcp-apps-interactive-views)
18. [Integrating MCP with Real-Time Communication](#18-integrating-mcp-with-real-time-communication)
19. [Lecture Recap](#19-lecture-recap)

---

## 1. Why Real-Time Matters

The web started as a *pull* medium: a browser asked, a server answered, the conversation ended. Modern users now expect software to behave like a living surface — chat windows that update mid-keystroke, dashboards that breathe, video that flows, AI assistants that "type" their answer token by token. Every one of those experiences is a deliberate choice of *who* pushes data, *when*, and *over what wire*.

In this lecture we map the landscape of how a browser and a server stay in touch over time. We focus on **concepts**, **architecture**, **capabilities**, and the **trade-offs** that decide which tool fits a given problem. There is no single "best" technology — there is only the right tool for the right shape of communication.

### What you will be able to answer by the end

- *"Should this feature use polling, SSE, WebSockets, SignalR, or WebRTC?"*
- *"What infrastructure does each of these need to run in production at scale?"*
- *"What does a PWA give me that a normal web app does not, and what does it cost?"*
- *"When my AI-generated code says `new WebSocket(...)`, what is actually happening on the network?"*

---

## 2. Communication Models

Before any specific technology, decide *how* information needs to flow. Five questions answer almost every "which tech?" debate:

1. **Direction** — server → client, client → server, both, or peer ↔ peer?
2. **Latency budget** — milliseconds, seconds, or "eventually"?
3. **Fan-out** — one-to-one, one-to-few, one-to-many, many-to-many?
4. **Reliability** — must every message arrive in order? May any be dropped?
5. **Lifecycle** — short request, persistent connection, or background even when the app is closed?

If you can answer those five, the technology chooses itself. Students who reach for an AI assistant and ask for "real-time chat" tend to get a WebSocket bolted onto everything. Decide the *model* first; the API comes second.

> A useful rule of thumb: **start at the simplest model that satisfies your latency budget, and only escalate when measurement says you must.** Plain HTTP + polling is good enough far more often than people assume.

---

## 3. The HTTP Baseline

Before we talk real-time, anchor yourself in classic HTTP:

- **Stateless, request-driven.** The client speaks first; the server responds and the connection (logically) ends.
- **Half-duplex per request.** Only one side talks at a time, only in response to the other.
- **Cache-friendly.** CDNs, proxies, and browsers can store responses.
- **Connection reuse exists** (HTTP keep-alive, HTTP/2 multiplexing, HTTP/3 over QUIC) but the *programming model* is still "ask → receive".

**Why this matters:** Every real-time technology in this lecture either (a) bends HTTP to simulate push, (b) negotiates an upgrade away from HTTP for a persistent channel, or (c) bypasses the server entirely. Knowing the baseline helps you see what each one is actually doing differently.

### Capabilities at a glance

| Capability | Plain HTTP |
| --- | --- |
| Server can push without being asked | ❌ |
| Bi-directional within one connection | ❌ |
| Works through every proxy/firewall | ✅ |
| Friendly to CDNs and caching | ✅ |
| Native binary support | ✅ (body) |
| Built-in reconnection | n/a |

### Use cases where plain HTTP is still the right answer

- CRUD APIs, REST resources, GraphQL queries/mutations.
- Anything the user explicitly *requests* — search results, file downloads, form submissions.
- Read-mostly content where update latency of seconds-to-minutes is fine.

### Real-world example: GitHub REST API

GitHub's REST API at `api.github.com` is plain request/response at scale: every call is an independent HTTPS request that returns JSON, and conditional requests let a client re-check a resource cheaply.

- **Conditional requests.** Most endpoints return an `ETag` header, and many also return `Last-Modified`. Send the values back as `If-None-Match` or `If-Modified-Since`; if nothing changed the API answers `304 Not Modified`. ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api))
- **Rate limits.** The primary limit is 60 requests per hour unauthenticated and 5,000 per hour for authenticated users. A conditional request that returns `304` does not count against the primary limit when it is correctly authorized with an `Authorization` header. After a `403` or `429`, do not retry until the time in the `x-ratelimit-reset` header. ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api))
- **Watch for.** It is still pull-only. For frequent change detection GitHub's advice is: "You should subscribe to webhook events instead of polling the API for data."

---

## 4. HTTP Polling

**Polling** is the original way to fake server push: the client *keeps asking* "anything new?" on a timer.

### 4.1 Short Polling

The client sends a request every *N* seconds. The server answers immediately with whatever it has (often nothing).

**Architecture**

```
Client ──GET /updates──► Server ──[]──► Client
        (every 5s)
Client ──GET /updates──► Server ──[3 new items]──► Client
```

**Pros**

- Trivial to implement; works everywhere; no special infrastructure.
- Stateless on the server — load-balances and caches naturally.
- Easy to debug (just HTTP in the dev tools).

**Cons**

- Wasted requests when nothing changed (cost & battery on mobile).
- Latency ≈ poll interval. There is no "right now".
- Doesn't scale gracefully — N clients × frequency = constant load floor.

**Use cases**

- Background "is my batch job done yet?" checks.
- Low-frequency status displays (every 30 seconds is fine).
- Fallback for clients/networks that cannot hold a persistent connection.

### 4.2 Long Polling

The client makes a request; the server *holds the response open* until it has data (or a timeout). When the client receives the answer it immediately reconnects.

**Architecture**

```
Client ──GET /updates──► Server  (holds…holds…)
                          ↓ data arrives
                         answers
Client ◄────payload──── Server
Client ──GET /updates──► Server (reconnects immediately)
```

**Pros**

- Near-real-time delivery without inventing a new protocol.
- Survives any HTTP-friendly proxy, firewall, or corporate network.
- Each "tick" is still one HTTP request — easy to log, trace, and authenticate.

**Cons**

- Server has to *hold* many sockets open (looks like idle traffic).
- One message per round-trip: bursty data → many reconnect cycles.
- Reconnection windows can drop messages without careful ID tracking.

**Use cases**

- Mobile/legacy environments where WebSockets are blocked.
- The hidden fallback inside SignalR and other abstractions.
- Quick "good enough" real-time when adding WS infrastructure is overkill.

### 4.3 When polling is the *wrong* choice

- High-frequency updates (>1/sec) to many users — you will burn CPU and bandwidth.
- Truly bidirectional or low-latency chat-style traffic.
- IoT or game state — get a real persistent channel instead.

### 4.4 Real-world example: GitHub Events and Notifications API

GitHub documents its Events and Notifications endpoints as optimized for polling. They show the cooperative form of short polling: the server tells clients how often they may ask, and an unchanged answer is nearly free.

- **Server sets the pace.** Both the Events API (for example `GET /users/{username}/events`) and `GET /notifications` return an `X-Poll-Interval` header (the docs show `60`) that "specifies how often (in seconds) you are allowed to poll". "In times of high server load, the time may increase. Please obey the header." ([Events](https://docs.github.com/en/rest/activity/events), [Notifications](https://docs.github.com/en/rest/activity/notifications))
- **Conditional polling.** Events are optimized for polling with the `ETag` header and notifications with `Last-Modified`. Send `If-None-Match` (events) or `If-Modified-Since` (notifications); with nothing new you get `304 Not Modified` and "your current rate limit will be untouched".
- **Trade-off.** Latency can never be lower than the poll interval. For the public events endpoints GitHub notes that the API "is not built to serve real-time use cases" and that event latency "can be anywhere from 30s to 6h". The timeline holds up to 300 events from the last 30 days.

### 4.5 Real-world example: Telegram Bot API (getUpdates)

Telegram bots can receive messages by long polling: the bot calls `getUpdates` on `api.telegram.org` and the server holds the request open until there is something to deliver.

- **How it works.** `getUpdates` is documented as the method "to receive incoming updates using long polling". Its `timeout` parameter is the "Timeout in seconds for long polling"; it defaults to `0`, "i.e. usual short polling", which "should be used for testing purposes only". ([Bot API](https://core.telegram.org/bots/api#getupdates))
- **Acknowledging.** The next call passes `offset` one higher than the highest `update_id` already received; an update "is considered confirmed as soon as getUpdates is called with an offset higher than its update_id". Updates are stored on the server until the bot receives them, but "they will not be kept longer than 24 hours". `getUpdates` does not work while an outgoing webhook is set up.
- **Same idea in libraries.** Socket.IO clients start with the HTTP long-polling transport by default and then upgrade ([how it works](https://socket.io/docs/v4/how-it-works/)); SignalR negotiates in order of graceful fallback: WebSockets, Server-Sent Events, Long Polling ([SignalR introduction](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction)).

---

## 5. HTTP Streaming

Between polling and SSE there is a humble but powerful technique: **stream the body of one HTTP response**. The server sets `Transfer-Encoding: chunked` (HTTP/1.1) or just writes a long HTTP/2 stream, and the client reads it incrementally via the **Streams API** / `fetch().body.getReader()`.

This is exactly how most LLM "typing" UIs work today (OpenAI, Anthropic, Azure OpenAI, the GPT-style chat in your IDE) — they ship newline-delimited JSON chunks back over one POST. SSE is a *standardized framing* on top of this idea; raw HTTP streaming is the looser cousin.

### 5.1 Architecture

```
Client ──POST /chat──► Server
        ◄──chunk 1──── (token 1)
        ◄──chunk 2──── (token 2)
        ◄──chunk 3──── (token 3)
        ◄────────────  (end of stream)
```

- One HTTP response, body delivered incrementally.
- Any payload format you want (JSON lines, NDJSON, raw text, binary).
- The client uses `ReadableStream` / async iterators.

### 5.2 Pros

- Lets the **client POST a request** (with headers, body, auth) and *also* receive a stream back — SSE cannot do that with `EventSource`.
- No new protocol: ordinary HTTP, works through proxies, CDNs, and auth middleware.
- Binary-safe.
- Perfect match for LLM token streaming and large-result paging.

### 5.3 Cons

- No automatic reconnection (you write that yourself).
- No standard framing — you and your consumer must agree on a format.
- Buffering middleboxes can hold chunks back until "done" if not configured properly.
- One-way (server → client) within the same response, like SSE.

### 5.4 Use cases

- **AI / LLM token streaming** with an authenticated POST body.
- **Large result sets** delivered incrementally instead of all at once.
- **Server-driven render of progressive HTML** (a la React Server Components / streaming SSR).
- **File generation** progress that streams partial bytes.

> Treat HTTP streaming as the **substrate**. Reach for **SSE** when you want a standard event framing and built-in reconnection. Reach for **WebSockets** when the client also needs to *send* during the stream.

### 5.5 Real-world example: Kubernetes API watch

The Kubernetes API server lets clients follow changes to a resource with a *watch*: a long-lived HTTP response that carries a stream of JSON change events. It is HTTP streaming used as an infrastructure protocol.

- **The request.** `GET /api/v1/namespaces/test/pods?watch=1&resourceVersion=10245` is answered with `200 OK` and `Transfer-Encoding: chunked`. The body is a series of JSON documents such as `{"type": "ADDED", "object": {...}}`, followed by `MODIFIED` events and, with `allowWatchBookmarks=true`, `BOOKMARK` events. ([API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/), "Efficient detection of changes")
- **Resuming.** Every object carries a `resourceVersion`. If the watch is disconnected, the client can start a new watch from the last returned `resourceVersion`.
- **Failure mode.** History is limited: clusters using etcd 3 preserve changes in the last 5 minutes by default. A watch from a version that is too old fails with `410 Gone`; the client must clear its local cache, list again, and restart the watch from the `resourceVersion` the list returned.

---

## 6. Server-Sent Events (SSE)

**Server-Sent Events** is a W3C/HTML5 standard for *one-way* server-to-client streaming over a single, long-lived HTTP response with content type `text/event-stream`. The browser exposes it through the `EventSource` API.

### 6.1 Architecture & how it works

```
Client ──GET /stream (Accept: text/event-stream)──► Server
              ↑                                       │
              │   data: {…}                           │
              │   data: {…}                           │
              │   event: update                       │
              │   data: {…}                           │
              └───────────────────────────────────────┘
                  (one persistent HTTP response)
```

- A single HTTP/1.1 (or HTTP/2 stream) connection stays open.
- Server writes UTF-8 text frames consisting of named fields: `data:`, `event:`, `id:`, `retry:`.
- The browser automatically reconnects on drop and resumes from `Last-Event-ID`.
- HTTP/2 multiplexing removes the historical "6 connections per origin" limit.

### 6.2 Capabilities

- **Server → client only.** The client cannot push back on the same channel.
- **Text/UTF-8 only** (binary must be base64-encoded).
- **Built-in retry & resume** — the browser handles it without code.
- **Friendly to HTTP infrastructure** — proxies, load balancers, WAFs, TLS termination, observability tools all work unchanged.
- **Lightweight** — small constant overhead per connection, no framing protocol of its own.

### 6.3 Pros

- Simplest persistent-channel technology to learn and operate.
- Just HTTP — no upgrade dance, no extra firewall rules.
- Automatic reconnection is a feature, not your problem.
- Excellent for streaming AI/LLM token responses (the entire ChatGPT/Claude/Copilot-style "typing" effect is SSE under the hood for many providers).
- Compresses well over HTTP/2 and HTTP/3.

### 6.4 Cons

- Unidirectional. Need to send anything back? Make a separate request.
- Text-only payloads.
- Long-lived connections consume server file descriptors and memory.
- Some intermediaries buffer responses — destroying "real time" — unless you configure them.
- **`EventSource` cannot set custom HTTP headers** (no `Authorization: Bearer …`). You're forced to either (a) use **cookie-based auth**, (b) put a short-lived token in the query string (then never log it), or (c) use a polyfill like `fetch-event-source` that wraps the protocol around `fetch()` so you *can* send headers.
- Not great when you need fine-grained connection control (binary frames, custom subprotocols, etc.).

### 6.5 Use cases

- **AI/LLM token streaming** ("typing" effect, code assistants, summarization).
- **Real-time dashboards** — stock tickers, sensor data, build pipelines, system metrics.
- **Live feeds** — sports scores, election results, news, comment streams.
- **Notification fan-out** — toast popups, "X has been updated" pings.
- **Log tailing** in DevOps dashboards.

### 6.6 When *not* to use SSE

- Chat (need client → server too).
- Multiplayer games (need symmetric low-latency).
- Anything that must carry binary data efficiently.

### 6.7 Real-world example: Wikimedia EventStreams

Wikimedia publishes live streams of wiki activity, such as `recentchange`, as Server-Sent Events. It is a read-only, resumable stream that any HTTP client can consume.

- **The stream.** `https://stream.wikimedia.org/v2/stream/recentchange` serves `text/event-stream` "over HTTP using chunked transfer encoding following the Server-Sent Events protocol". Read it with the browser `EventSource` or any HTTP client. Server-side filtering is not supported, so filter client-side. ([EventStreams docs](https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams_HTTP_Service))
- **Resuming.** EventStreams is internally backed by Apache Kafka, and each event's `id` is a JSON array of Kafka topic, partition and offset (or timestamp) metadata. A reconnecting `EventSource` sends it back as `Last-Event-ID` and continues where it stopped; a `since=` timestamp query parameter is also supported. WMF's HTTP layer enforces a 15-minute connection timeout, and the docs say: "A good SSE / EventSource client should be able to automatically reconnect and begin consuming at the right location using the Last-Event-ID header."
- **Why SSE, not WebSockets.** The previous RCStream service used Socket.IO. The docs explain the change: EventStreams "is read-only and only needs to send events from the server to a client. By using only 100% standard HTTP, EventStreams can be consumed from any HTTP client out there".
- **Same pattern in LLM APIs.** Token streaming uses SSE too: Anthropic's Messages API streams server-sent events when `"stream": true` ([docs](https://platform.claude.com/docs/en/build-with-claude/streaming)), and OpenAI's Responses API offers HTTP streaming (`stream=true`) over server-sent events ([docs](https://developers.openai.com/api/docs/guides/streaming-responses)).

---

## 7. WebSockets

**WebSockets** (RFC 6455) are a *protocol-level* technology that upgrades a single HTTP connection into a full-duplex, persistent TCP channel. After the upgrade handshake, both ends can send framed messages — text or binary — at any time, with very low per-frame overhead.

### 7.1 Architecture & how it works

```
Client                                  Server
  │  HTTP/1.1 GET /ws                     │
  │  Upgrade: websocket  ───────────────► │
  │  Sec-WebSocket-Key: …                 │
  │                                       │
  │  ◄──── 101 Switching Protocols ───────│
  │                                       │
  │  ◄═══ framed messages (text/binary) ══│
  │  ═══ framed messages (text/binary) ══►│
  │             (full-duplex)             │
```

- After the 101 handshake, the socket no longer speaks HTTP.
- Both peers can send unsolicited messages.
- A simple framing protocol carries payloads with very low overhead (2–14 bytes/frame).
- TLS-wrapped variant is `wss://`.

### 7.2 Capabilities

- **True bidirectional, low-latency messaging.**
- **Text *or* binary payloads.**
- **Per-message compression** via the `permessage-deflate` extension.
- **Subprotocols** — agree on higher-level semantics (`json`, `graphql-ws`, `mqtt`, etc.).
- **Browser-native** — first-class `WebSocket` API everywhere.

### 7.3 Pros

- The lowest-overhead bidirectional channel widely available in browsers.
- Symmetrical: either side can initiate a message at any time.
- Predictable latency — no negotiation, no polling, no buffering.
- Excellent ecosystem (Node `ws`, ASP.NET Core, Spring, Go, Python `websockets`, etc.).

### 7.4 Cons

- **You own the lifecycle.** Reconnection, heartbeats, message acknowledgment, replay, ordering, and authentication after upgrade are all *your* responsibility unless a library helps.
- **Sticky sessions** typically required behind a load balancer because the connection lives on a single node.
- **Scaling needs a backplane** (Redis pub/sub, NATS, Kafka, Azure Web PubSub) to fan messages out across server nodes.
- **Proxy hostility.** Some corporate proxies strip the upgrade or aggressively idle-close — you need pings.
- **No HTTP semantics after upgrade.** Cache headers, conditional gets, CORS preflight don't apply once you're on the socket; you must design auth and authorization explicitly.

### 7.5 Use cases

- **Chat & collaboration** — Slack, Teams, Discord text channels.
- **Live collaborative editing** — Google Docs, Figma, Miro (often combined with CRDTs/OT).
- **Multiplayer games & real-time strategy** — low-latency state sync.
- **Trading & financial dashboards** — high-frequency market data.
- **IoT control plane** — bidirectional command/telemetry.
- **Live auctions, sports betting odds, real-time bidding.**

### 7.6 Common pitfalls

- Forgetting to send periodic pings → idle-cut by intermediaries.
- Putting authentication in the URL query string and then logging it.
- Letting a single node hold all connections — no graceful drain on deploy.
- Sending one giant message instead of streaming chunks.

### 7.7 Real-world example: Discord Gateway

Discord's Gateway lets apps open a secure WebSocket connection to receive events about what happens in a server. The protocol makes the client responsible for the connection lifecycle: heartbeats, identification and resuming. Community libraries wrap this, but the rules are visible in the docs, which makes it a good illustration of "you own the lifecycle".

- **Handshake.** After connecting, the server sends Hello with a `heartbeat_interval`. The client sends Heartbeats on that interval, then an Identify payload (token and intents), and receives Ready, which carries a `session_id`. ([Gateway docs](https://docs.discord.com/developers/events/gateway))
- **Dead-link detection.** Discord answers each Heartbeat with a Heartbeat ACK (opcode 11). If no ACK arrives, the connection may be failed or "zombied": the client should terminate it with any close code besides 1000 or 1001, then reconnect and attempt to Resume.
- **Resume.** After reconnecting to the `resume_gateway_url` from Ready, the client sends a Resume (opcode 6) with its `session_id` and the sequence number of the last event it received; the Gateway "will send the missed events in order, finishing with a Resumed event". Identify calls are limited to 1,000 per 24 hours across all shards, and Resume calls do not count toward that limit.

---

## 8. SignalR

**SignalR** is Microsoft's high-level real-time library for ASP.NET Core. It is *not* a separate wire protocol. Instead, it **abstracts** the choice of transport (WebSockets → SSE → Long Polling) behind a **Hub** programming model. You write methods on a `Hub` class; clients call them by name; the server can call back into clients by name. It handles connection lifecycle, reconnection, group management, serialization (JSON or MessagePack), and offers a managed cloud variant (Azure SignalR Service).

### 8.1 Architecture & how it works

```
Client ──POST /chathub/negotiate──► Server
         ◄──{transports, connectionId, [redirect]}──
Client ──Upgrade chosen transport──► Hub
              ▲                       │
              │   strongly-typed       │
              │   method invocations   │
              ▼                       │
            Client ◄═══════════════► Hub
                                      │
                                  ┌───┴────┐
                                  │Backplane│ (Redis / Azure / SQL)
                                  └─────────┘
```

- **Negotiation step** discovers the best transport at runtime.
- **Hubs** are server-side classes; the framework auto-wires client proxies.
- **Groups** allow targeted broadcast (`Clients.Group("room42").SendAsync(...)`).
- **Backplane** distributes messages across hub server instances.
- **Azure SignalR Service** can replace your hub fleet with a managed, globally distributed broker.

### 8.2 Capabilities

- Bidirectional RPC-style messaging with automatic serialization.
- Transparent transport fallback for hostile networks.
- Built-in user/group/connection targeting.
- First-class auth integration with ASP.NET Core (JWT, cookies, claims).
- Server-side streams (large or infinite results streamed to a client).
- Client-side strongly typed proxies in C#, TypeScript, Java, Python.

### 8.3 Pros

- **Massive productivity win** vs. raw WebSockets when you're in .NET.
- Handles reconnection, heartbeats, fallback, and scale-out for you.
- Group & user targeting without writing your own registry.
- Plays nicely with ASP.NET Core middleware (auth, logging, exception filters).
- A clear managed-service upgrade path (Azure SignalR) when you outgrow self-hosting.

### 8.4 Cons

- Framework dependency — you're committing to the .NET / ASP.NET Core stack.
- A little overhead vs. raw WebSockets (JSON by default; switch to MessagePack for hot paths).
- The negotiation endpoint becomes a hotspot you must protect & cache.
- "Magic" can hide problems — silent fallback to long polling under a broken proxy looks fine until you look at metrics.
- Group churn at scale can saturate the backplane if abused.
- **SignalR does NOT escape the browser auth-header limitation.** When the chosen transport is WebSockets or SSE, the JS client passes the JWT as `?access_token=…` (via `accessTokenFactory`) — the same trade-off as raw WebSockets and `EventSource`. Make sure your reverse proxy and logs do not capture full URLs in production.

### 8.5 Use cases

- **Enterprise chat / collaboration apps** built on .NET.
- **Live dashboards** — operations, finance, support, telemetry consoles.
- **Real-time notifications** inside line-of-business applications.
- **Customer-support tools** with presence and typing indicators.
- **Online auctions, ticketing, and order flow** where rapid bidirectional updates matter.
- **AI streaming** to .NET clients (server can stream tokens via `IAsyncEnumerable`).

### 8.6 SignalR vs. raw WebSockets — when each wins

- **Choose SignalR** when you want productivity, .NET integration, automatic fallback, groups, presence, and a managed scale-out story.
- **Choose raw WebSockets** when you need wire-level control, lowest possible overhead, or you're outside the .NET ecosystem.

### 8.7 Real-world example: Blazor Server and Azure SignalR Service

Blazor Server runs C# UI components on the server inside an ASP.NET Core app, and the browser is a thin client. SignalR is the transport that makes this work, and Microsoft's recommended way to scale it out is Azure SignalR Service.

- **How it uses SignalR.** "UI updates, event handling, and JavaScript calls are handled over a SignalR connection using the WebSockets protocol." The state on the server for each connected client is a *circuit*, and each browser screen requires a separate circuit. ([Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models))
- **Scale-out.** "We recommend using the Azure SignalR Service for apps that adopt the Blazor Server hosting model." It lets a Blazor Server app scale to a large number of concurrent SignalR connections; the service lets multiple instances work together to scale to millions of client connections and also supports a serverless mode with Azure Functions. ([Azure SignalR Service overview](https://learn.microsoft.com/en-us/azure/azure-signalr/signalr-overview))
- **Trade-off.** The same hosting-models page lists: "Higher latency usually exists. Every user interaction involves a network hop. There's no offline support."

---

## 9. WebRTC

**WebRTC** (Web Real-Time Communication) is an open standard that allows browsers and native apps to establish **peer-to-peer**, low-latency channels for **audio**, **video**, and **arbitrary data** — without a plugin and without the server relaying media in the common case.

### 9.1 Architecture & how it works

WebRTC is three pillars plus a missing fourth:

1. **`MediaStream`** — capture mic, camera, screen.
2. **`RTCPeerConnection`** — negotiate codecs, NAT-traverse, transport encrypted media.
3. **`RTCDataChannel`** — bidirectional arbitrary data, ordered or unordered, reliable or unreliable.
4. **Signaling** — *not* part of WebRTC. You bring your own channel (commonly WebSockets, SignalR, or SSE) to exchange the initial SDP offer/answer and ICE candidates.

```
            ┌───────── Signaling Server ─────────┐
            │ (WebSocket / SignalR / HTTP)        │
   ┌────────┴─────────┐                ┌──────────┴────────┐
   │   Browser A      │   SDP offer    │     Browser B     │
   │                  ├───────────────►│                   │
   │                  │◄───SDP answer──┤                   │
   │                  │◄──ICE cand────►│                   │
   └──────────────────┘                └───────────────────┘
              │                                  │
              │  ICE / STUN / TURN negotiation   │
              │◄────────────────────────────────►│
              │                                  │
              │  Direct P2P (encrypted SRTP/DTLS)│
              │  Audio / Video / Data            │
              │◄════════════════════════════════►│
```

### 9.2 Supporting infrastructure

- **STUN** — discovers your public IP behind NAT. Free, lightweight.
- **TURN** — relays media when peers can't reach each other directly. Roughly **10–25% of real sessions** require TURN; corporate firewalls and symmetric NATs are the usual reason. TURN consumes real bandwidth and is the single largest cost driver of any P2P deployment.
- **SFU (Selective Forwarding Unit)** — server that receives each client's stream once and *forwards* (does not transcode) to others. Required beyond ~4–6 participants.
- **MCU (Multipoint Conferencing Unit)** — server that *mixes* and re-encodes streams; used for very large meetings/webinars.

> **Common student mistake:** demos work on the classroom LAN with only STUN configured, so students conclude "WebRTC is easy". Then it breaks for half the users on real networks. **You must plan for TURN.** Treat it as a non-negotiable production requirement, not an optimization.

### 9.3 Capabilities

- **Sub-100ms latency** for audio/video — the lowest of any browser tech.
- **Adaptive bitrate, simulcast, and SVC** built into the stack.
- **Mandatory encryption** (DTLS for data, SRTP for media).
- **Direct file/data transfer** between peers — no server storage required.
- **Screen sharing** (`getDisplayMedia`) and **virtual backgrounds / AI effects** (via Insertable Streams or canvas pipelines).
- **NAT traversal** that "just works" most of the time.

### 9.4 Pros

- The only browser-native technology designed for real-time A/V.
- Peer-to-peer saves bandwidth and reduces latency vs. server-relayed video.
- Strong security defaults (encryption is non-optional).
- Massive ecosystem: Google Meet, Discord, Microsoft Teams, Zoom (fallback), WhatsApp Web, Facebook Messenger, Jitsi, Twilio, Agora, Daily, 100ms, LiveKit.

### 9.5 Cons

- **Substantial complexity.** Signaling, ICE, codecs, simulcast, congestion control — there is a lot to know.
- **Infrastructure you must run or buy:** STUN, TURN, possibly SFU.
- **Doesn't scale by P2P alone** — mesh topology breaks past ~4–6 participants. You need an SFU.
- **Mobile devices throttle and burn battery** under sustained A/V.
- **Difficult observability** — peer-to-peer media is hard to inspect server-side.
- **Compliance challenges** — recording, archiving, lawful intercept require extra plumbing.

### 9.6 Use cases

- **Video conferencing** — Meet, Teams web, Jitsi, Whereby.
- **Voice calls in the browser** — Discord, WhatsApp Web.
- **Telehealth / telemedicine** — secure clinician-to-patient sessions.
- **Live customer support with video / screen share.**
- **Remote desktop & co-browsing.**
- **Multiplayer browser games** using `RTCDataChannel` for very low latency.
- **Peer-to-peer file transfer** and end-to-end-encrypted chat.
- **Live AI avatars / agent video** with sub-second response.

### 9.7 Don't forget Data Channels

Students hear "WebRTC" and think *video*. **`RTCDataChannel`** is the same P2P pipe carrying arbitrary application data — text, JSON, binary, files. It can be configured **ordered or unordered**, **reliable or unreliable**, just like UDP-with-options. That makes it ideal for:

- Low-latency multiplayer game state.
- Direct peer-to-peer file transfer (no server storage).
- E2E-encrypted chat where the server never sees plaintext.
- IoT control planes where peers are on the same private mesh.

### 9.8 Common pitfalls

- Trying to build a 25-person mesh — bandwidth explodes; deploy an SFU.
- Skimping on TURN — works on your laptop, fails on the corporate Wi-Fi.
- Ignoring codec compatibility (H.264 vs VP8 vs VP9 vs AV1 vs hardware acceleration).
- Putting personally-identifying data in SDP / ICE logs.

### 9.9 Real-world example: Jitsi Meet

Jitsi Meet is a set of open-source projects for deploying video conferencing; the hosted service at `meet.jit.si` runs in the browser. It shows the peer-to-peer versus SFU trade-off in one product.

- **Two participants.** `config.js` has a `p2p` section: when enabled, the system "will try to establish a direct connection when there are exactly 2 participants in the room", and when a 3rd participant joins the conference is moved back to the JVB (videobridge) connection. A STUN server is configured for the direct path. ([config.js](https://github.com/jitsi/jitsi-meet/blob/master/config.js))
- **Larger calls.** Jitsi Videobridge is "a WebRTC-compatible Selective Forwarding Unit (SFU), i.e. a multimedia router": it receives each participant's media and forwards it to the others instead of every pair connecting directly. ([Videobridge README](https://github.com/jitsi/jitsi-videobridge))
- **Signaling is separate.** In the Jitsi architecture, Prosody is the "XMPP server used for signalling"; Jicofo "manages media sessions and acts as a load balancer between each of the participants and the videobridge"; Jigasi is the gateway to SIP and Jibri the broadcasting infrastructure. ([architecture handbook](https://jitsi.github.io/handbook/docs/architecture/))

---

## 10. Service Workers

A **service worker** is a JavaScript file the browser runs *in its own background thread*, completely separate from any page. Once registered, it becomes a **programmable network proxy** sitting between your app and the network. It is the single most important primitive behind PWAs and Web Push — understand it first.

### 10.1 Architecture

```
                          ┌──────────────────────┐
        ┌────fetch()─────►│                      │
        │                 │   Service Worker     │──── network ────► Server
   Web Page               │  (background script) │
        ▲                 │   - Cache API        │◄── push ─────────  Push Service
        │  postMessage    │   - IndexedDB        │
        ▼                 │   - sync / fetch /   │
   Other Tab              │     push handlers    │
                          └──────────────────────┘
```

- Lives in a **separate origin-scoped global** with no DOM access.
- Receives lifecycle events: `install`, `activate`, `fetch`, `push`, `sync`, `notificationclick`.
- Has access to the **Cache API** (HTTP response storage) and **IndexedDB** (structured client-side database).
- Persists across page reloads, tab closes, and (with Web Push) full app closure.

### 10.2 Capabilities

- Intercept and reshape every network request from controlled pages.
- Serve responses **from cache** when offline, or pre-fetch eagerly.
- Receive **Web Push** messages while the app is closed (see §11).
- Run **Background Sync** to retry failed POSTs when connectivity returns.
- Run **Periodic Background Sync** (limited support) for scheduled refresh.
- Show notifications (`registration.showNotification`).

### 10.3 Caching strategies (pick one per resource type)

| Strategy | Behavior | Use for |
| --- | --- | --- |
| Cache-first | Try cache, fall back to network | Static assets (JS, CSS, images, fonts) |
| Network-first | Try network, fall back to cache | API responses where freshness matters |
| Stale-while-revalidate | Serve cache, refresh in background | Avatar, badge, feed thumbnails |
| Cache-only | Cache, never network | Truly immutable, offline-only resources |
| Network-only | Skip the service worker | Auth, payments, anything that must be live |

### 10.4 Pros

- Foundation for offline UX, push, and install-to-home-screen.
- Once registered, runs invisibly — no extra UI required.
- Massive performance wins on repeat visits via cache.
- Works on top of *any* backend — language-agnostic.

### 10.5 Cons & pitfalls

- **Cache invalidation is hard.** Forget to bump your version and users see a stale app for days.
- The **service-worker lifecycle** (install → waiting → active) confuses everyone the first time.
- A buggy SW can lock users out of new releases. *Always* support a "skip waiting + claim clients" escape hatch and a "kill switch" you can deploy.
- Only works over **HTTPS** (and `localhost` for development).
- Storage is **best-effort** — the browser can evict caches under pressure.

### 10.6 Use cases

- **Offline-capable apps** (notes, docs, news, field-service).
- **Performance acceleration** (cache-first asset serving).
- **Background push handling** (see §11).
- **Background retry queues** for unreliable mobile networks.

### 10.7 Real-world example: Squoosh and Excalidraw

Two open-source web apps show service workers at both ends of the effort scale. Squoosh, an image compressor from Google Chrome Labs, hand-writes its worker; its README says it "does not send your image to a server", so compression runs locally. Excalidraw generates its worker with Workbox through `vite-plugin-pwa`.

- **Squoosh (hand-written).** `install` precaches the app into a versioned cache; `activate` takes control of clients and deletes caches that are no longer expected; `fetch` answers same-origin GET requests from the cache first and falls back to the network, caching some responses dynamically. A `message` handler accepts `skip-waiting` so the page can activate a new worker. ([src/sw](https://github.com/GoogleChromeLabs/squoosh/tree/dev/src/sw))
- **Excalidraw (generated).** The README lists "PWA support (works offline)". `excalidraw-app/vite.config.mts` configures `VitePWA` with `registerType: "autoUpdate"` and Workbox options. ([vite.config.mts](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/vite.config.mts))
- **Caching rules.** A code comment says "don't precache fonts, locales and separate chunks"; at runtime `.woff2` files, locale files and chunks use `CacheFirst`, and `fonts.css` uses `StaleWhileRevalidate`. [Workbox](https://developer.chrome.com/docs/workbox/what-is-workbox) is "a set of modules that simplify common service worker routing and caching".

---

## 11. Web Push

**Web Push** lets a server deliver a notification to a user **even when the browser tab is closed**, by leveraging push services run by the browser vendor (Chrome ↔ FCM, Firefox ↔ Mozilla autopush, Edge ↔ Windows Notification Service, Safari ↔ Apple Push). It is **not** a real-time channel for application data — it is a **doorbell**.

### 11.1 Architecture

```
Server ──(HTTPS, VAPID-signed)──► Push Service (Google/Mozilla/Apple)
                                            │
                                            ▼
                                   User's browser (background)
                                            │
                                            ▼
                                  Service Worker `push` event
                                            │
                                            ▼
                                  showNotification() → user
```

- The browser registers a **subscription URL** with its push service.
- The server stores subscriptions and sends payloads to those URLs, signed with **VAPID** (Voluntary Application Server Identification).
- A **Service Worker** wakes up to handle the push event even with the page closed.
- The user grants explicit permission, per origin.

### 11.2 Capabilities

- Background delivery while the site is closed.
- Payload up to ~4KB (encrypted end-to-end between server and service worker).
- Works across desktop and most mobile browsers (iOS supported since 16.4 *only for installed PWAs*).
- Optional notification UI (`showNotification`) with actions, icons, and click-to-focus.

### 11.3 Pros

- Re-engages users without an app store.
- Reuses existing browser-vendor push infrastructure (you do not run your own push pipeline).
- Strong opt-in model — permission is per-origin and revocable.

### 11.4 Cons

- **Permission friction** — many users decline immediately. Ask in context, never on first load.
- **iOS support requires the user to install the PWA to the Home Screen first.**
- Not a real-time data channel — payloads are best-effort and small.
- Easy to abuse → users will mute or block; design notifications with care.
- Delivery is **not guaranteed** and not low-latency. Don't use Web Push to deliver application state.

### 11.5 Use cases

- Chat / mention notifications when the user isn't on the site.
- Calendar / meeting reminders.
- Order-status, shipping, ride-share updates.
- Time-sensitive alerts (price drops, breaking news, security warnings).

### 11.6 Real-world example: Mastodon Web Push

Mastodon "natively supports the Web Push API", so a web or native client can receive alerts (for example mentions, favourites, reblogs and follows) by registering a push subscription with its server.

- **Subscribing.** `POST /api/v1/push/subscription` needs a user token with the `push` scope. The form carries the browser's `subscription[endpoint]`, `subscription[keys][p256dh]` and `subscription[keys][auth]`, plus `data[alerts][...]` flags for the alert types wanted. ([Push methods](https://docs.joinmastodon.org/methods/push/))
- **Standards.** `subscription[standard]=true` selects standardized Web Push (RFC 8030 + RFC 8291 + RFC 8292, the VAPID specification); otherwise Mastodon follows a legacy draft-based format. The response contains a `server_key`, the VAPID key. ([WebPushSubscription](https://docs.joinmastodon.org/entities/WebPushSubscription/))
- **Limits.** Each access token can have one push subscription; creating a new one deletes the old one. Mastodon does not connect to Android's or Apple's proprietary notification gateways directly, so native apps use a proxy server that translates between Web Push and those gateways.

---

## 12. Progressive Web Apps (PWA)

A **Progressive Web App** is not a single technology — it's a *pattern* that combines:

- A **Web App Manifest** (`manifest.webmanifest`) — name, icons, theme, display mode.
- A **Service Worker** — programmable network proxy that lives in the background.
- **HTTPS** — non-negotiable.
- Responsive UI, install prompt, offline support, push, and background sync where supported.

The goal: make a web site feel like an installed app — launchable from the home screen, runnable offline, capable of background updates and notifications — without going through an app store.

### 12.1 Architecture

```
        Browser
   ┌──────────────────────┐
   │   Web App (React)    │◄───── manifest.webmanifest
   │          ▲           │
   │          │ fetch()    │
   │          ▼           │
   │  Service Worker      │◄───── push events
   │  (network proxy +    │       background sync
   │  cache + push)       │
   │          ▲           │
   │          │ Cache API │
   │          ▼           │
   │   On-device storage  │
   │  (Cache, IndexedDB)  │
   └──────────────────────┘
              │
              ▼
            Server
```

The service worker sits between the page and the network. It can serve from cache, fall through to network, sync in the background, and receive push messages.

### 12.2 Capabilities

- **Installable** to home screen / desktop, runs in its own window.
- **Offline mode** via Cache API and IndexedDB (with strategies: cache-first, network-first, stale-while-revalidate).
- **Background sync** — queue actions while offline, replay on reconnect (where supported).
- **Push notifications** (see §11).
- **Periodic background sync** (limited support).
- **Hardware access** — camera, mic, geolocation, Bluetooth, USB, NFC (varying support).
- **Single codebase, all platforms.**

### 12.3 Pros

- Zero install friction vs. native — no store gatekeeping, no signing certificates.
- One codebase, many platforms (web + iOS + Android + desktop).
- Automatic updates — no version sprawl.
- Cheaper than native development; great for MVPs and indie/startup teams.
- Discoverable via the open web (SEO, links).

### 12.4 Cons

- **iOS lags.** Some APIs (background sync, periodic sync, push pre-16.4) are limited.
- **Hardware access** is still narrower than native (no Bluetooth on iOS Safari, etc.).
- **Storage quotas** can be reclaimed by the browser when disk pressure rises.
- **Service worker debugging** is a learning curve — cached versions, registration scope, update lifecycle.
- **App store presence** still matters for discoverability in some segments.

### 12.5 Use cases

- News / media reading apps where offline-while-commuting matters.
- Field-service & logistics apps that work in poor connectivity.
- E-commerce mobile experiences (Twitter Lite, Pinterest, Starbucks, Uber).
- Internal tools where you don't want app-store friction.
- Productivity apps with cache-first behavior (notes, todo, time-tracking).

### 12.6 Common pitfalls

- Shipping a buggy service worker → users see a broken cached site for days.
- Not versioning your cache — old assets served alongside new ones.
- Overusing cache-first → stale data shown when the network would have been fine.
- Treating PWA as "I added a manifest and called it done" instead of designing for offline.

### 12.7 Real-world example: Twitter Lite

Twitter Lite is Twitter's mobile-web PWA. The [web.dev case study](https://web.dev/case-studies/twitter) says it "became the default mobile web experience for all users globally in April 2017". The numbers below are Twitter's own figures as reported there, not an independent benchmark.

- **What it uses.** A service worker introduced in stages (a custom offline page first, then offline caching of static resources such as CSS, images and JavaScript bundles, then the application shell), plus an Add to Home Screen prompt and web push. Returning visits boot in under 3 seconds.
- **Reported results.** 65% increase in pages per session, 75% increase in Tweets sent and 20% decrease in bounce rate. The PWA is "only 600KB over the wire vs. 23.5MB of downloaded data needed to install the native Android app", and first loads take under 5 seconds over 3G on most devices.
- **Re-engagement.** After the Add to Homescreen prompt, Twitter saw 250,000 unique daily users launch Twitter Lite from the homescreen 4 times a day on average, and web push delivers over 10M notifications a day.

---

## 13. Adjacent Technologies

These don't all fit in one lecture, but you'll meet them in production and AI-generated code. Recognize the shape of each.

### 13.1 gRPC and gRPC-Web Streaming

Google's high-performance RPC framework over HTTP/2 with Protocol Buffers. Supports four call styles, including **server streaming**, **client streaming**, and **bidirectional streaming**. In the browser, **gRPC-Web** restricts you to unary + server streaming (no client streaming) until WebTransport becomes ubiquitous.

- **Best for:** strongly typed microservice-to-microservice traffic; mobile/native clients; high-throughput backends.
- **Less great for:** the open web (binary, harder to debug, requires a proxy like Envoy).

### 13.2 MQTT

A pub/sub messaging protocol designed for IoT devices on constrained networks. Tiny header, QoS levels (0/1/2), retained messages, last-will, broker-based topology.

- **Best for:** IoT telemetry, sensor fleets, home automation, vehicle data.
- **Reachable from the browser** via MQTT-over-WebSockets.

### 13.3 GraphQL Subscriptions

Pushes updates to a subscribed query result, typically over WebSockets (`graphql-ws`) or SSE. Pairs naturally with GraphQL queries and mutations.

- **Best for:** apps that already use GraphQL and want "live queries" without inventing a parallel channel.
- **Watch for:** N+1 subscription explosion and authorization complexity.

### 13.4 WebTransport

A newer browser API built on **HTTP/3 + QUIC** that offers reliable streams *and* unreliable datagrams, multiplexed over a single connection. Think "WebSockets done right for the next decade".

- **Best for:** real-time games, low-latency telemetry, future-proof apps.
- **Status (late 2025/early 2026):** Chrome/Edge/Firefox shipping; Safari catching up; libraries maturing.

### 13.5 Webhooks (server-to-server contrast)

Don't conflate browser real-time with **webhooks**. A webhook is just *"I will POST to your URL when an event happens."* It's server-to-server, fire-and-forget, with retries and signing. It is how Stripe, GitHub, Slack, Twilio, and most SaaS notify *your* server of changes — not how your browser stays in sync with users.

- **Pros:** dead simple; ordinary HTTP; provider keeps no socket open.
- **Cons:** requires your server to be reachable; you must verify signatures and handle replays.
- **Use cases:** payment events, CI pipelines, third-party integrations, "external system → my backend".

### 13.6 BroadcastChannel & Shared Workers (client-side coordination)

Sometimes the "real-time" problem is *between tabs* of the same user, not between user and server:

- **`BroadcastChannel`** — same-origin tabs publish/subscribe by string name. Great for "user logged out in one tab, log out everywhere".
- **`SharedWorker`** — a single script shared by all tabs of an origin. Useful for a one-socket-many-tabs pattern.
- **Web Worker** — background thread for CPU-bound work (not network, but real-time UX).

### 13.7 HTTP/2 Server Push — *deprecated, do not use*

For a few years HTTP/2 had a "push promise" feature that let the server preemptively send resources. **Chrome removed support in 2022.** It is no longer a viable mechanism. If you see AI-generated code or older blog posts reaching for it, replace it with HTTP streaming, SSE, or `<link rel="preload">`.

### 13.8 Background Sync, Periodic Sync

Smaller browser primitives that complement PWAs:

- **Background Sync** — retry failed POSTs once back online.
- **Periodic Background Sync** — wake up periodically to refresh.
- **BroadcastChannel** — same-origin tabs talking to each other.
- **Shared Worker / Service Worker** — single background script across tabs.

### 13.9 Push services beyond Web Push

For native mobile installed apps you'll still meet **APNs** (Apple), **FCM** (Google), **WNS** (Windows). PWAs largely shield you from these directly via Web Push.

### 13.10 Real-world example: one product per adjacent technology

Each adjacent technology above has a documented production user. Use these as concrete anchors when you meet the technology.

- **gRPC streaming — etcd.** "Every API request sent to an etcd server is a gRPC remote procedure call." The `Watch` API uses long-running gRPC streams: "a single watch stream can multiplex many distinct watches". ([etcd API](https://etcd.io/docs/v3.5/learning/api/#watch-api))
- **MQTT — AWS IoT Core.** Supports MQTT 3.1.1 and 5.0 with QoS levels, persistent sessions and retained messages, and MQTT over WebSocket Secure (WSS) for browsers. ([MQTT](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html), [protocols](https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html))
- **GraphQL subscriptions — Hasura.** The client sends a `subscription` operation and Hasura pushes results over WebSocket using the `graphql-ws` or `subscriptions-transport-ws` sub-protocol, chosen through the `Sec-WebSocket-Protocol` header. ([Hasura docs](https://hasura.io/docs/2.0/subscriptions/postgres/index/))
- **Webhooks — Stripe.** Stripe sends signed JSON `POST` requests to an HTTPS endpoint you register; verify the `Stripe-Signature` header against the raw request body and return a 2xx quickly. ([Stripe webhooks](https://docs.stripe.com/webhooks))
- **WebTransport — Cloudflare Media over QUIC.** Cloudflare runs Media over QUIC (MoQ) relays, free during the beta period; the MoQ transport can run over raw QUIC or "over WebTransport, which is required for use in a web browser". MDN lists WebTransport as Baseline "newly available" since March 2026, with some parts varying by browser. ([Cloudflare MoQ](https://developers.cloudflare.com/moq/), [blog](https://blog.cloudflare.com/moq/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API))
- **BroadcastChannel — VS Code.** VS Code's storage layer tells other windows and tabs about changes through a `BroadcastChannel` wrapper and falls back to `localStorage` events when `BroadcastChannel` is unavailable. This is a source-code example, not product documentation. ([broadcast.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/broadcast.ts))

---

## 14. Decision Framework

A practical, narrow-to-broad decision tree for picking a technology:

1. **Does anything need to be real-time?**
   - *No* → REST/HTTP. Stop.
2. **Is the data flow server-to-client only?**
   - *Yes, low frequency* → polling.
   - *Yes, high frequency or streaming* → **SSE**.
3. **Do clients need to send messages too?**
   - *Yes, .NET shop, want productivity* → **SignalR**.
   - *Yes, want wire-level control or non-.NET stack* → **WebSockets**.
4. **Is it audio / video / sub-100ms data between users?**
   - **WebRTC** (with WS/SignalR for signaling).
5. **Do we need to reach users while the app is closed?**
   - **Web Push + Service Worker**.
6. **Do we want home-screen install + offline?**
   - **PWA** (manifest + service worker, on top of any of the above).
7. **IoT / device fleet?** → **MQTT** (often over WebSockets).
8. **Already on GraphQL?** → **GraphQL Subscriptions** for live data.
9. **Greenfield, future-looking, gaming/telemetry?** → Evaluate **WebTransport**.

### Comparison cheat sheet

| Technology | Direction | Protocol | Best Sweet Spot | Worst Sweet Spot |
| --- | --- | --- | --- | --- |
| Short Polling | C ↔ S | HTTP | "Is job done?" | High-frequency anything |
| Long Polling | C ↔ S | HTTP | Hostile networks fallback | Bursty data |
| HTTP Streaming | S → C (one POST) | HTTP | LLM token streams | Anything needing reconnect |
| SSE | S → C | HTTP | Dashboards, notifications, feeds | Chat, games |
| WebSockets | C ↔ S | TCP upgrade | Chat, collab, games | Audio/video |
| SignalR | C ↔ S | WS / SSE / LP | Real-time on .NET, with groups | Non-.NET shops |
| WebRTC | P ↔ P | UDP (SRTP/SCTP) | A/V, P2P data | Notifications, simple updates |
| Service Worker | n/a | n/a | Offline, caching, background | Anything you need on first load |
| Web Push | S → C | HTTPS via vendor | Background notifications | Bulk data delivery |
| PWA pattern | n/a | n/a | Installable, offline-capable web app | Heavy native-only features |

---

## 15. Cross-Cutting Concerns

Every real-time technology brings the same family of operational concerns. Address them up front.

### 15.1 Scaling

- **Sticky sessions** for stateful connections (WebSockets, SignalR fallbacks).
- **Backplanes** (Redis, NATS, Kafka, Azure Web PubSub / SignalR Service) to fan messages across nodes.
- **Region locality** — connect users to the nearest cluster; replicate only what truly must be global.
- **Connection per resource ratio** — track memory per connection (typically 1–8 KB) and CPU per broadcast.
- **Backpressure** — slow consumers must never stall the whole node.

### 15.2 Security

- **TLS everywhere** (`wss://`, `https://`) — non-negotiable.
- **JWT or session cookies** validated at connection establishment, then again on every privileged call.
- **Rate limiting** at the edge and per connection.
- **Input validation & size limits** on every frame.
- **Don't log PII** — connection metadata is fine; payloads are not.
- **CORS** for SSE/HTTP endpoints; explicit origin allow-lists for sockets.

### 15.3 Observability

- **Connection counts** per node and per shard.
- **Message latency p50/p95/p99** (publish → delivery).
- **Reconnect rate** — spikes indicate deploys, network issues, or bugs.
- **Fanout amplification** — recipients per message.
- **Transport mix** for SignalR — silent fallback to long polling is a smell.
- **Per-technology custom telemetry** (in this lecture's lab we use Application Insights).

### 15.4 Cost

- **Egress bytes** dominate at scale (especially WebRTC TURN and WebSocket broadcasts).
- **Idle connections** are not free — memory and FDs cost money in big numbers.
- **Managed services** (Azure SignalR / Web PubSub, LiveKit Cloud, Twilio) trade dollars for engineering time.

---

## 16. Model Context Protocol (MCP)

MCP is an open protocol for connecting AI applications to external capabilities and context. It standardizes the conversation between an **MCP host** (the AI application), its **MCP client** (the protocol connection), and one or more **MCP servers** (providers of tools and context). MCP is not a model, an agent framework, or a replacement for your application API: it is an interoperability layer that lets different hosts discover and use server capabilities.

### 16.1 The three server primitives

- **Tools** are callable operations, such as `search_orders`, `create_ticket`, or `start_export`. The server provides a name, description, input schema, and handler. The host/model can request a call; the application should keep approval and authorization decisions in the host and server.
- **Resources** are addressable context, such as a document, a report, or a current application state snapshot. A client reads a resource when it needs data; a resource is not automatically a live subscription.
- **Prompts** are reusable, server-provided prompt templates that help a user or host start a task with consistent instructions and arguments.

Most application integrations begin with one narrowly scoped tool, then add resources or prompts when a concrete use case needs them.

### 16.2 Request lifecycle and transports

MCP messages use JSON-RPC. Each request carries the protocol version and client capabilities in `_meta`; `server/discover` advertises server versions and capabilities. The selected transport carries those messages:

- **stdio** is a good fit when a desktop host launches a local server process. Reserve stdout for protocol messages; log to stderr.
- **Streamable HTTP** is a network transport for remote servers. Use it with HTTPS, authentication, and origin protections appropriate to the deployment. Its ability to stream a response does not make every tool a durable event subscription.

Use the official SDK for your language rather than hand-writing protocol framing. The current SDK quickstarts cover tool registration and transports; SDK APIs and minimum versions evolve, so check the matching versioned docs when implementing.

### 16.3 Implementing a useful, safe tool

1. **Choose a user task**, not an API endpoint: e.g., “look up an order” rather than a generic database query tool.
2. **Define a precise schema.** Name each argument, constrain its type/range, mark required inputs, and explain the tool's effect in plain language.
3. **Implement the handler** using existing application services. Validate all inputs again on the server, enforce the signed-in user's authorization and tenant boundary, and return a bounded, structured result.
4. **Make side effects explicit.** Separate preview/read operations from writes; require confirmation for consequential actions through the host/product's approval flow. Make retried writes idempotent where possible.
5. **Choose transport and deploy** for the host: stdio for local process integration; authenticated Streamable HTTP for a remote service. Keep protocol logs separate from stdout on stdio.
6. **Test through a real MCP client.** Check discovery, valid and invalid inputs, authorization, expected errors, cancellation, and behavior when the underlying service is unavailable.

Illustrative SDK-neutral shape:

```text
tool: lookup_order
input: { order_id: string }
handler:
  validate order_id
  authorize current user for this order
  order = orderService.lookup(order_id)
  return { status, updated_at, items }
```

Treat tool descriptions and results as a public API contract: small, predictable, well documented, and safe to expose to a model. See the [official server build guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server) for a versioned SDK walkthrough.

### 16.4 Real-world example: GitHub MCP Server

GitHub's MCP server is a documented example of one server offered through both transports from 16.2: a local stdio process and a remote Streamable HTTP endpoint hosted by GitHub.

- **What it does.** The README says: "The GitHub MCP Server connects AI tools directly to GitHub's platform. This gives AI agents, assistants, and chatbots the ability to read repositories and code files, manage issues and PRs, analyze code, and automate workflows." ([github/github-mcp-server](https://github.com/github/github-mcp-server))
- **Remote server (Streamable HTTP).** Hosted by GitHub at `https://api.githubcopilot.com/mcp/`. In VS Code it is configured with `"type": "http"` and signs in with OAuth or a personal access token; VS Code "first tries the HTTP Stream transport and falls back to SSE" for HTTP servers. ([VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration))
- **Local server (stdio).** Run the Docker image `ghcr.io/github/github-mcp-server` with `GITHUB_PERSONAL_ACCESS_TOKEN` set in the environment.
- **Narrowing the tool surface.** Remote URLs select toolsets (`/mcp/x/actions`, `/mcp/x/all`), and adding `/readonly` to a URL restricts it to read-only tools; the `X-MCP-Toolsets` and `X-MCP-Readonly` headers do the same, and `/mcp/insiders` enables early-access features. ([remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)) The README adds that GitHub Enterprise Server does not support remote server hosting, so use the local server there.

---

## 17. MCP Apps: Interactive Views

An MCP App combines an ordinary MCP tool with an associated UI resource. The tool remains the operation the host can discover and call; the UI is an optional richer presentation for hosts that support the MCP Apps extension. Text-only hosts can still use the tool's normal result.

### 17.1 The implementation pattern

1. Build the MCP server and register a tool with a clear input schema and handler.
2. Build a small HTML/JavaScript view and expose it as a UI resource using the `ui://` URI scheme and the MCP Apps HTML media type (`text/html;profile=mcp-app`).
3. Associate the tool and view through the tool's UI metadata (the SDK's app-tool registration helper can do this).
4. In a compatible host, the host fetches the resource and renders it in a sandboxed iframe when the tool is invoked.
5. Use the Apps SDK to complete the host/view initialization handshake and communicate with the host through the supported JSON-RPC bridge. The view can request approved tool calls and receive results; do not treat it as a privileged page with direct host access.

The host controls whether Apps are supported, how they are displayed, and which capabilities are available. Always retain a useful non-visual tool response. The [MCP Apps quickstart](https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html) provides a working TypeScript SDK example.

### 17.2 Security and UX

- Keep the view focused on the tool's task; pass only the context it needs.
- Use the host's sandbox and least-privilege content security policy. Declare only required network/resource origins and browser permissions.
- Do not embed API keys, bearer tokens, or privileged service credentials in the HTML, JavaScript, or tool result.
- Route sensitive actions through server-side tools that re-check identity, authorization, and input. The iframe is not a trust boundary for business rules.
- Handle loading, empty, error, and unsupported-host states. Provide accessible controls and a text/structured result as a fallback.

### 17.3 Real-world example: MCP Apps in Claude, VS Code and other hosts

MCP Apps is new enough that the best evidence is the reference repository and the host support lists. Treat this as a snapshot and check the client matrix before promising a particular host.

- **Example apps.** The `modelcontextprotocol/ext-apps` repository includes a CesiumJS 3D globe (`map-server`), a Three.js scene renderer, an interactive PDF viewer with chunked loading and a real-time system monitor; its README shows "Excalidraw built with MCP Apps, running in Claude". ([ext-apps](https://github.com/modelcontextprotocol/ext-apps))
- **Hosts.** The MCP client matrix lists Claude, ChatGPT, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, Cursor, Archestra.AI and PostHog Code as supporting MCP Apps. It is community-maintained and changes over time. ([client matrix](https://modelcontextprotocol.io/extensions/client-matrix))
- **VS Code.** VS Code announced MCP Apps support on 26 January 2026; Storybook added MCP Apps support to its open-source MCP server, so an agent can render an interactive component preview in chat. The VS Code docs still label MCP Apps "(Experimental)". ([VS Code blog](https://code.visualstudio.com/blogs/2026/01/26/mcp-apps-support), [VS Code docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers))
- **Mechanics.** A tool's `_meta.ui.resourceUri` points at a `ui://` resource with MIME type `text/html;profile=mcp-app`; the host renders it in a sandboxed iframe and talks to it with JSON-RPC over `postMessage`. Keep a useful text result for hosts that do not render apps. ([overview](https://modelcontextprotocol.io/extensions/apps/overview), [specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx))

---

## 18. Integrating MCP with Real-Time Communication

MCP and real-time web technologies solve different parts of the interaction. **MCP is the interoperable command/context plane**: discover a tool, submit a request, read a resource, or return a result. **SSE, WebSockets/SignalR, and WebRTC are communication channels** for timely events, collaboration, or media. Do not assume MCP tool calls replace a live connection—or that a live connection replaces MCP's capability and consent model.

### 18.1 A job-status example

Suppose a user asks an assistant to start a long export and watch its progress:

1. The host calls an MCP tool such as `start_export`; the server authenticates and authorizes the request, creates a job, and returns a `job_id` and initial status.
2. The browser or host subscribes to application events for that job over **SSE** (one-way progress), or **WebSocket/SignalR** (bidirectional collaboration/control).
3. The export worker publishes progress and terminal status. The application event service checks that the subscriber may see the job, then sends only the permitted event data.
4. The MCP App can render progress in its view; the host remains responsible for displaying tool results and mediating further tool calls.
5. If the connection drops, reconnect and resume using an event ID / sequence number, or read the current status from a resource/tool. Make cancellation an explicit, authorized MCP operation.

```text
User → AI host → MCP tool: start_export → job_id
                         Export service → event broker
Browser / MCP App ← SSE or SignalR ← authorized job events
```

### 18.2 Pick the live channel from the data flow

- **SSE**: server → client progress, logs, or status; simple HTTP reconnect and event IDs fit many job updates.
- **WebSockets / SignalR**: both directions, frequent updates, presence, or interactive collaboration.
- **WebRTC**: peer audio/video or peer data, with a separate signaling channel.
- **Web Push**: a background “something changed” notification when the app is closed—not the progress stream itself.

The MCP transport can itself stream a response, but that is distinct from a browser-facing application event subscription that can live beyond one tool call or deliver updates to multiple viewers.

### 18.3 Production checklist

- Correlate tool calls, job IDs, and event streams; do not use an MCP request ID as a permanent job ID.
- Re-check authorization when creating a job, reading its status, subscribing, and cancelling. Authenticate each channel; do not trust a job ID as a secret.
- Define event ordering, duplicate handling, reconnect/resume, retention, and terminal states. Keep a status resource or endpoint as the source of truth.
- Return bounded progress updates and final results; use cancellation/timeouts and backpressure for slow consumers.
- Keep credentials out of UI resources and event payloads; log metadata and correlation IDs without sensitive content.

The design rule is simple: **use MCP to describe and invoke the action; use the real-time channel to deliver the ongoing experience.**

### 18.4 Real-world example: MCP over Streamable HTTP (spec 2026-07-28)

MCP is itself built from technologies in this lecture. The statements below were checked against the **2026-07-28** revision of the specification, the current revision on modelcontextprotocol.io when this was written.

- **Streamable HTTP is POST plus SSE.** Each client message is an HTTP `POST` whose body is one JSON-RPC request or notification, sent with an `Accept` header listing `application/json` and `text/event-stream`. For a request, the server answers with either a single `application/json` response or a `text/event-stream` (SSE) response stream. Closing that stream is the cancellation signal on Streamable HTTP, and servers must validate the `Origin` header. ([transport spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http))
- **Progress and live changes.** A `progressToken` in `_meta` lets the server send `notifications/progress` (an increasing `progress` value, optional `total` and `message`) on that request's own response stream ([progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)). `subscriptions/listen` opens a long-lived notification stream whose filter can request `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed` and `notifications/resources/updated` for chosen URIs; it replaces the former `resources/subscribe` RPC and the HTTP GET endpoint ([subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)).
- **Long-running work: Tasks.** The Tasks extension (`io.modelcontextprotocol/tasks`) lets a server return a `CreateTaskResult` (`resultType: "task"`, `taskId`, status, `ttlMs`, `pollIntervalMs`) instead of a final result. The client polls `tasks/get` and may call `tasks/cancel`, which is cooperative. Task IDs survive disconnects. ([Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview))
- **What changed in 2026-07-28.** There is no `initialize` handshake any more: each request carries its protocol version and client capabilities in `_meta`, and `server/discover` advertises server versions and capabilities. There is no `Mcp-Session-Id` and no SSE resumability ("Resumable SSE streams via Last-Event-ID are not supported"), so a broken response stream loses the in-flight request and the client re-issues it with a new request ID. `ping`, `logging/setLevel` and `notifications/roots/list_changed` were removed. The initialize-and-negotiate wording in 16.2 describes earlier revisions (up to 2025-11-25). ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog))

---

## 19. Lecture Recap

- HTTP pulls; polling simulates push; HTTP streaming and SSE stream server output.
- WebSockets and SignalR support low-latency, bidirectional application messaging; WebRTC handles peer media/data.
- Service Workers, Web Push, and PWAs support offline and background experiences.
- MCP standardizes how AI hosts discover and invoke tools and access resources/prompts.
- MCP Apps pair a tool with a sandboxed interactive view for capable hosts.
- Pair MCP commands with SSE, WebSockets/SignalR, or WebRTC when the experience needs ongoing updates or peer media.
