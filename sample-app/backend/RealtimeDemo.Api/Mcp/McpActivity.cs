// =============================================================================
// McpActivity
// -----------------------------------------------------------------------------
// One place where MCP activity (tool calls, job progress) turns into the other
// real-time channels of this app:
//
//   • SignalR   — every event is broadcast to connected browsers as "McpEvent",
//                 which is what the MCP page's live activity feed listens to.
//   • Telemetry — milestones are recorded under technology "MCP", exactly like
//                 SSE, WebSocket and SignalR events.
//
// This is the "MCP + real time" integration in one class: MCP carries the
// request/response part, SignalR carries the push part.
// =============================================================================

using Microsoft.AspNetCore.SignalR;
using RealtimeDemo.Api.Hubs;
using RealtimeDemo.Api.Telemetry;

namespace RealtimeDemo.Api.Mcp;

public sealed class McpActivity
{
    private readonly IHubContext<ChatHub> _hub;
    private readonly TelemetryService _tele;
    private readonly ILogger<McpActivity> _log;

    public McpActivity(IHubContext<ChatHub> hub, TelemetryService tele, ILogger<McpActivity> log)
    {
        _hub = hub; _tele = tele; _log = log;
    }

    /// <param name="kind">"tool" or "job".</param>
    /// <param name="name">Tool name or job event type.</param>
    /// <param name="track">False for high-frequency events such as progress ticks.</param>
    public void Publish(string kind, string name, string message, object? data = null, bool track = true)
    {
        if (track) _tele.Track("MCP", $"{kind}_{name}", detail: message);

        _ = BroadcastAsync(new
        {
            kind,
            name,
            message,
            at = DateTime.UtcNow,
            data,
        });
    }

    private async Task BroadcastAsync(object payload)
    {
        try { await _hub.Clients.All.SendAsync("McpEvent", payload); }
        catch (Exception ex) { _log.LogDebug(ex, "McpEvent broadcast failed"); }
    }
}
