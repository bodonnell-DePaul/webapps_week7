// =============================================================================
// JobEventsController  (Server-Sent Events, ticket-authenticated)
// -----------------------------------------------------------------------------
//   GET /api/jobs/{jobId}/events?ticket=...[&lastEventId=N]
//
// The live channel for the MCP App view. It is plain SSE — the same technique as
// SseController — with three differences that come from where it is used:
//
//   • Auth is a short-lived, single-job ticket (see JobTicketService) instead of
//     a login JWT. The view lives in a sandboxed iframe: no login, no cookies, and
//     EventSource cannot set an Authorization header anyway.
//   • CORS allows any origin for GET. The iframe's origin is chosen by the host
//     app, and the ticket — not the origin — is what protects the stream. No
//     credentials are ever sent, so "*" is safe here.
//   • Reconnect works. Every event carries an id; a browser that reconnects sends
//     Last-Event-ID and gets only what it missed. (After a terminal event the
//     stream ends, and the view closes its EventSource so it does not reconnect.)
// =============================================================================

using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Cors;
using Microsoft.AspNetCore.Mvc;
using RealtimeDemo.Api.Mcp;
using RealtimeDemo.Api.Telemetry;

namespace RealtimeDemo.Api.Controllers;

[ApiController]
[AllowAnonymous]
[Route("api/jobs")]
[EnableCors(CorsPolicy)]
public class JobEventsController : ControllerBase
{
    public const string CorsPolicy = "McpJobStream";

    private readonly JobService _jobs;
    private readonly JobTicketService _tickets;
    private readonly TelemetryService _tele;

    public JobEventsController(JobService jobs, JobTicketService tickets, TelemetryService tele)
    {
        _jobs = jobs; _tickets = tickets; _tele = tele;
    }

    [HttpGet("{jobId}/events")]
    public async Task Stream(string jobId, [FromQuery] string? ticket, [FromQuery] int lastEventId, CancellationToken ct)
    {
        // Same answer for "bad ticket" and "unknown job": do not reveal which ids exist.
        if (!JobService.IsValidId(jobId) || !_tickets.IsValid(ticket, jobId))
        {
            Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        // On automatic reconnects the browser sends Last-Event-ID itself.
        if (Request.Headers.TryGetValue("Last-Event-ID", out var header) && int.TryParse(header, out var fromHeader))
            lastEventId = fromHeader;

        using var subscription = _jobs.Subscribe(jobId, Math.Max(0, lastEventId));
        if (subscription is null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no"; // stop nginx-style proxies from buffering

        _tele.Track("MCP", "job_stream_open", detail: jobId);
        try
        {
            // A comment line gets the headers flushed, so EventSource fires `open` right away.
            await WriteAsync(": open\n\n", ct);

            foreach (var ev in subscription.Replay)
                await WriteAsync(Format(ev), ct);

            if (subscription.Live is { } live)
                await foreach (var ev in live.ReadAllAsync(ct))
                    await WriteAsync(Format(ev), ct);
        }
        catch (OperationCanceledException)
        {
            // The viewer closed the stream; nothing to clean up beyond the finally block.
        }
        finally
        {
            _tele.Track("MCP", "job_stream_close", detail: jobId);
        }
    }

    private static string Format(JobEvent ev) =>
        $"id: {ev.Id}\nevent: {ev.Type}\ndata: {JsonSerializer.Serialize(ev.Snapshot, JobService.Json)}\n\n";

    private async Task WriteAsync(string frame, CancellationToken ct)
    {
        await Response.Body.WriteAsync(Encoding.UTF8.GetBytes(frame), ct);
        await Response.Body.FlushAsync(ct);
    }
}
