// =============================================================================
// Program.cs — Week 8 Real-Time Demo (ASP.NET Core, .NET 8)
// -----------------------------------------------------------------------------
// Single composition root demonstrating every technology covered in the
// lecture. Each section is commented so students can read top-to-bottom and
// see exactly which lecture topic it serves.
// =============================================================================

using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using ModelContextProtocol.AspNetCore;
using RealtimeDemo.Api;
using RealtimeDemo.Api.Controllers;
using RealtimeDemo.Api.Data;
using RealtimeDemo.Api.Hubs;
using RealtimeDemo.Api.Mcp;
using RealtimeDemo.Api.Telemetry;
using WebPush;

var builder = WebApplication.CreateBuilder(args);

// -----------------------------------------------------------------------------
// CORS — frontend runs on a separate Vite dev server (default 5173).
// We allow it explicitly. For SignalR/WebSockets credentials are required.
// -----------------------------------------------------------------------------
string[] webOrigins =
[
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:5174", "http://127.0.0.1:5174",
    "http://localhost:4173", "http://127.0.0.1:4173",
];
builder.Services.AddCors(o =>
{
    o.AddDefaultPolicy(p => p
        .WithOrigins(webOrigins)
        .AllowAnyMethod()
        .AllowAnyHeader()
        .AllowCredentials());

    // The MCP App view that opens /api/jobs/{id}/events runs in an iframe whose origin
    // the host app picks, so no fixed origin list can work. The URL ticket protects the
    // stream instead; no credentials are involved, so allowing any origin is safe here.
    o.AddPolicy(JobEventsController.CorsPolicy, p => p
        .AllowAnyOrigin()
        .WithMethods("GET")
        .AllowAnyHeader());
});

// -----------------------------------------------------------------------------
// MVC + OpenAPI
// -----------------------------------------------------------------------------
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();


// -----------------------------------------------------------------------------
// SignalR — built-in to ASP.NET Core. JSON protocol is the default; in
// production you might also enable MessagePack for performance.
// -----------------------------------------------------------------------------
builder.Services.AddSignalR(o =>
{
    // Useful in class so we see errors instead of generic messages.
    o.EnableDetailedErrors = true;
});

// -----------------------------------------------------------------------------
// EF Core — SQLite for portability (no server install required).
// -----------------------------------------------------------------------------
var dbPath = builder.Configuration["Db:Path"]
             ?? Path.Combine(builder.Environment.ContentRootPath, "realtimedemo.db");
builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlite($"Data Source={dbPath}"));

// -----------------------------------------------------------------------------
// JWT Bearer auth
//
// IMPORTANT: For browser EventSource (SSE) and raw WebSocket, the JWT cannot
// be sent via the Authorization header. We therefore configure the JWT
// middleware to ALSO accept a `?access_token=...` query string parameter on
// the SSE, WS, and SignalR-hub paths. This is the standard ASP.NET Core
// pattern (see docs).
// -----------------------------------------------------------------------------
var jwtKey = builder.Configuration["Jwt:Key"]
             ?? "DEV_INSECURE_KEY_PLEASE_OVERRIDE_32B_xxxx";   // length >= 32 chars
var jwtIss = builder.Configuration["Jwt:Issuer"]   ?? "RealtimeDemo";
var jwtAud = builder.Configuration["Jwt:Audience"] ?? "RealtimeDemo";

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.RequireHttpsMetadata = false; // dev-only
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateIssuerSigningKey = true,
            ValidateLifetime = true,
            ValidIssuer = jwtIss,
            ValidAudience = jwtAud,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ClockSkew = TimeSpan.FromMinutes(1),
        };
        o.Events = new JwtBearerEvents
        {
            // Allow access_token in query string for SSE / WS / SignalR.
            OnMessageReceived = ctx =>
            {
                var t = ctx.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(t))
                {
                    var path = ctx.HttpContext.Request.Path;
                    if (path.StartsWithSegments("/api/sse") ||
                        path.StartsWithSegments("/ws") ||
                        path.StartsWithSegments("/hubs"))
                    {
                        ctx.Token = t;
                    }
                }
                return Task.CompletedTask;
            }
        };
    });
builder.Services.AddAuthorization();

// -----------------------------------------------------------------------------
// Application Insights
//
// If you set ApplicationInsights:ConnectionString in appsettings.json (or
// APPLICATIONINSIGHTS_CONNECTION_STRING env var), telemetry is published live.
// If not, we register a no-op TelemetryClient so injection still works and
// every demo can call _ai.TrackEvent(...) safely — telemetry simply stays
// local (mirrored in the TelemetryEvents table).
// -----------------------------------------------------------------------------
var aiConn = builder.Configuration["ApplicationInsights:ConnectionString"];
if (!string.IsNullOrWhiteSpace(aiConn))
{
    builder.Services.AddApplicationInsightsTelemetry(o => o.ConnectionString = aiConn);
}
else
{
    // Register a passive client so DI keeps working with no live telemetry.
    builder.Services.AddSingleton(_ =>
        new Microsoft.ApplicationInsights.TelemetryClient(
            new Microsoft.ApplicationInsights.Extensibility.TelemetryConfiguration()));
}
builder.Services.AddSingleton<TelemetryService>();

// -----------------------------------------------------------------------------
// MCP — Model Context Protocol. Lets an AI host such as GitHub Copilot discover
// and call this app, and (MCP Apps) render a small interactive view for the
// result. Streamable HTTP endpoint at /mcp; tools, resources and prompts live
// in the Mcp/ folder. Stateless: every request stands alone, so there is no
// session to track and nothing to lose when the server restarts.
//
// MCP carries the request/response half. The real-time half reuses what the
// lecture already built: job progress goes out over SSE (and SignalR).
// -----------------------------------------------------------------------------
builder.Services.AddHttpContextAccessor();
builder.Services.Configure<McpOptions>(builder.Configuration.GetSection("Mcp"));
builder.Services.PostConfigure<McpOptions>(o => o.AllowedOrigins ??= webOrigins);
builder.Services.AddSingleton<McpActivity>();
builder.Services.AddSingleton<JobTicketService>();
builder.Services.AddSingleton<JobService>();
builder.Services
    .AddMcpServer(o =>
    {
        o.ServerInfo = new() { Name = "realtime-demo", Title = "Week 8 Real-Time Demo", Version = "1.0.0" };
        o.ServerInstructions =
            "Tools for the Week 8 real-time demo app. Slow work is modelled as a job: start_export returns " +
            "a job id immediately and progress is pushed live over SSE, so do not poll get_job_status in a loop. " +
            "send_chat_message posts into the SignalR chat room; get_telemetry_summary reports events per technology.";
    })
    .WithHttpTransport(o => o.SessionMode = HttpServerSessionMode.Stateless)
    .WithTools<RealtimeTools>()
    .WithResources<RealtimeResources>()
    .WithPrompts<RealtimePrompts>();

// -----------------------------------------------------------------------------
// VAPID / Web Push key-pair
//
// In production these are configured. For class we auto-generate a dev pair
// on first startup and persist to disk so the same browser subscription
// remains valid across restarts.
// -----------------------------------------------------------------------------
builder.Services.AddSingleton(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    var subject = cfg["Vapid:Subject"]   ?? "mailto:teacher@example.edu";
    var pub     = cfg["Vapid:PublicKey"];
    var prv     = cfg["Vapid:PrivateKey"];

    var keyFile = Path.Combine(builder.Environment.ContentRootPath, "vapid.json");
    if (string.IsNullOrEmpty(pub) || string.IsNullOrEmpty(prv))
    {
        if (File.Exists(keyFile))
        {
            var saved = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(
                File.ReadAllText(keyFile))!;
            pub = saved["public"];
            prv = saved["private"];
        }
        else
        {
            var keys = VapidHelper.GenerateVapidKeys();
            pub = keys.PublicKey;
            prv = keys.PrivateKey;
            File.WriteAllText(keyFile, System.Text.Json.JsonSerializer.Serialize(new
            {
                @public = pub,
                @private = prv,
            }));
        }
    }
    return new VapidDetails(subject, pub, prv);
});

// -----------------------------------------------------------------------------
// Forwarded headers — useful behind reverse proxies / tunnels.
// -----------------------------------------------------------------------------
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});

// -----------------------------------------------------------------------------
// Build & migrate DB
// -----------------------------------------------------------------------------
var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    // EnsureCreated keeps the sample simple — no migrations to run.
    db.Database.EnsureCreated();
}

if (app.Environment.IsDevelopment())
{
    
}

app.UseForwardedHeaders();
app.UseCors();

// /mcp can start jobs and post chat messages, so check Host/Origin (and an optional
// API key) before the MCP handler ever sees the request. See Mcp/McpSecurity.cs.
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/mcp"),
    branch => branch.UseMiddleware<McpSecurityMiddleware>());

// -----------------------------------------------------------------------------
// WebSockets must be enabled in the pipeline BEFORE the WS endpoint mapping.
// -----------------------------------------------------------------------------
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
});

app.UseAuthentication();
app.UseAuthorization();

// REST controllers — Auth, Polling, SSE, HttpStreaming, Push, Telemetry, JobEvents.
app.MapControllers();

// SignalR hub (used for chat + WebRTC signaling).
app.MapHub<ChatHub>("/hubs/chat");

// MCP server (Streamable HTTP) — tools, resources and prompts for AI hosts.
app.MapMcp("/mcp");

// Raw WebSocket echo endpoint.
app.MapEchoWebSocket("/ws/echo");

// Simple health endpoint for smoke tests.
app.MapGet("/api/health", () => Results.Ok(new { ok = true, at = DateTime.UtcNow }));

app.Run();

// Top-level Program made partial so a future WebApplicationFactory<>-based
// test project could reference it; left here as a teaching nudge.
public partial class Program { }
