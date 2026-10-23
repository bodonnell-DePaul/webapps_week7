// =============================================================================
// RealtimeTools — the MCP "tools" this server exposes
// -----------------------------------------------------------------------------
// MCP in one sentence: a standard way for an AI host (Copilot, Claude, VS Code…)
// to discover and call capabilities of your app. Tools are the "verbs".
//
//   start_export          model + app   starts a background job; shows the live monitor
//   get_job_status        model + app   one-shot status read
//   cancel_job            model + app   stops a running job
//   open_job_stream       app only      hands the monitor view a ticketed SSE URL
//   send_chat_message     model         posts into the SignalR chat room
//   get_telemetry_summary model         per-technology event counts
//
// MCP Apps adds one idea on top: a tool can point at a `ui://` resource through
// `_meta.ui.resourceUri`. Hosts that support it render that HTML in a sandboxed
// iframe next to the tool result. The view then talks back to this server through
// the host (`tools/call`) and — because MCP is request/response — opens its own
// real-time channel (SSE) for live progress. That is the MCP + real-time pattern.
//
// Errors the model can act on are thrown as McpException: the message is returned
// to the model as a tool error so it can correct itself. Anything else becomes a
// generic error with no details.
// =============================================================================

using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using RealtimeDemo.Api.Data;
using RealtimeDemo.Api.Hubs;
using RealtimeDemo.Api.Models;

namespace RealtimeDemo.Api.Mcp;

[McpServerToolType]
public sealed partial class RealtimeTools
{
    public const string JobMonitorUri = "ui://realtime-demo/job-monitor.html";
    public const string ChatUser = "mcp-assistant";

    [GeneratedRegex(@"^[a-zA-Z0-9_\- ]{1,40}$")]
    private static partial Regex DatasetPattern();

    private readonly JobService _jobs;
    private readonly JobTicketService _tickets;
    private readonly AppDbContext _db;
    private readonly McpActivity _activity;
    private readonly IHubContext<ChatHub> _hub;
    private readonly IHttpContextAccessor _http;
    private readonly McpOptions _options;

    public RealtimeTools(
        JobService jobs, JobTicketService tickets, AppDbContext db, McpActivity activity,
        IHubContext<ChatHub> hub, IHttpContextAccessor http, IOptions<McpOptions> options)
    {
        _jobs = jobs; _tickets = tickets; _db = db; _activity = activity;
        _hub = hub; _http = http; _options = options.Value;
    }

    // `ui` is the current key; `ui/resourceUri` is the older flat form some hosts still read.
    [McpServerTool(Name = "start_export", Title = "Start data export", OpenWorld = false)]
    [McpMeta("ui", JsonValue = """{"resourceUri":"ui://realtime-demo/job-monitor.html"}""")]
    [McpMeta("ui/resourceUri", JobMonitorUri)]
    [Description(
        "Starts a long-running data export as a background job and returns its job id straight away. " +
        "Progress is pushed to a live monitor and to the web app, so do not poll in a loop.")]
    public CallToolResult StartExport(
        [Description("Dataset to export, for example orders, customers or invoices.")] string dataset = "orders",
        [Description("Number of rows to export, 1 to 1,000,000.")] int rows = 10_000,
        [Description("How long the simulated export takes, 5 to 60 seconds.")] int durationSeconds = 15)
    {
        dataset = (dataset ?? "").Trim();
        if (!DatasetPattern().IsMatch(dataset))
            throw new McpException("dataset must be 1-40 characters: letters, digits, spaces, '-' or '_'.");
        if (rows is < 1 or > 1_000_000)
            throw new McpException("rows must be between 1 and 1,000,000.");
        if (durationSeconds is < 5 or > 60)
            throw new McpException("durationSeconds must be between 5 and 60.");

        if (!_jobs.TryStart(dataset, rows, durationSeconds, out var job))
            throw new McpException(
                $"{JobService.MaxRunning} exports are already running. Wait for one to finish, or stop one with cancel_job.");

        _activity.Publish("tool", "start_export", $"start_export dataset={dataset} rows={rows} duration={durationSeconds}s");

        return ToolResults.Ok(
            $"Started export job {job.JobId}: {rows:N0} rows of \"{dataset}\" over about {durationSeconds}s. " +
            "Progress streams to the live monitor and to the web app over SSE and SignalR. " +
            "One get_job_status call after it should have finished is enough; please do not poll.",
            job,
            new JsonObject { ["jobId"] = job.JobId });
    }

    [McpServerTool(Name = "get_job_status", Title = "Get job status", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Returns the current state of an export job: status, percent complete and rows processed.")]
    public CallToolResult GetJobStatus(
        [Description("Job id returned by start_export, for example job_1a2b3c4d5e6f.")] string jobId)
    {
        var job = RequireJob(jobId);
        _activity.Publish("tool", "get_job_status", $"get_job_status {jobId} -> {job.Status}", track: false);
        return ToolResults.Ok(Describe(job), job);
    }

    [McpServerTool(Name = "cancel_job", Title = "Cancel job", Destructive = true, Idempotent = true, OpenWorld = false)]
    [Description("Stops a running export job. Has no effect on a job that already finished.")]
    public CallToolResult CancelJob(
        [Description("Job id returned by start_export.")] string jobId)
    {
        RequireJob(jobId);
        var (job, cancelled) = _jobs.Cancel(jobId);
        if (job is null) throw new McpException($"No job with id {jobId}.");

        _activity.Publish("tool", "cancel_job", $"cancel_job {jobId} -> {(cancelled ? "cancelled" : job.Status)}", track: false);
        var text = cancelled
            ? $"Cancelled job {job.JobId} at {job.Percent:0.#}% ({job.ProcessedRows:N0} of {job.TotalRows:N0} rows)."
            : $"Job {job.JobId} had already {job.Status}; nothing to cancel.";
        return ToolResults.Ok(text, job);
    }

    // `visibility: ["app"]` hides this tool from the model's tool list. Only the MCP App
    // view can call it, through the host — and only on this same server.
    [McpServerTool(Name = "open_job_stream", Title = "Open job event stream", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [McpMeta("ui", JsonValue = """{"visibility":["app"]}""")]
    [Description("For the job monitor view only, not the model. Returns a short-lived SSE URL for one job's live events.")]
    public CallToolResult OpenJobStream(
        [Description("Job id returned by start_export.")] string jobId)
    {
        RequireJob(jobId);

        var ticket = _tickets.Issue(jobId, out var expiresAt);
        var url = $"{McpUrls.BaseUrl(_http, _options)}/api/jobs/{jobId}/events?ticket={Uri.EscapeDataString(ticket)}";
        var payload = new { jobId, url, transport = "sse", expiresAt };

        _activity.Publish("tool", "open_job_stream", $"open_job_stream {jobId} (ticket issued)");

        // The JSON also goes in the text block: hosts differ in whether the view receives
        // structuredContent, and this result is not meant for the model anyway.
        return ToolResults.Ok(JsonSerializer.Serialize(payload, JobService.Json), payload);
    }

    [McpServerTool(Name = "send_chat_message", Title = "Post to the team chat", OpenWorld = false)]
    [Description("Posts a message to the app's shared SignalR chat room as 'mcp-assistant'. Everyone connected sees it instantly.")]
    public async Task<CallToolResult> SendChatMessage(
        [Description("Message text, 1 to 500 characters.")] string text,
        CancellationToken cancellationToken)
    {
        text = (text ?? "").Trim();
        if (text.Length is 0 or > 500)
            throw new McpException("text must be 1-500 characters.");

        var message = new ChatMessage { User = ChatUser, Text = text };
        _db.ChatMessages.Add(message);
        await _db.SaveChangesAsync(cancellationToken);

        // Same event name and arguments as ChatHub.SendMessage, so web clients cannot tell the difference.
        await _hub.Clients.All.SendAsync("ReceiveMessage", message.User, message.Text, message.SentAt, cancellationToken);

        _activity.Publish("tool", "send_chat_message", $"send_chat_message ({text.Length} chars)");
        return ToolResults.Ok(
            $"Posted to the chat room as {ChatUser}.",
            new { posted = true, user = message.User, text = message.Text, sentAt = message.SentAt });
    }

    [McpServerTool(Name = "get_telemetry_summary", Title = "Get telemetry summary", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description("Event counts per technology (SSE, WebSocket, SignalR, MCP, ...) recorded by this app.")]
    public async Task<CallToolResult> GetTelemetrySummary(CancellationToken cancellationToken)
    {
        var technologies = await _db.TelemetryEvents
            .GroupBy(t => t.Technology)
            .Select(g => new { technology = g.Key, events = g.Count(), lastAt = g.Max(t => t.At) })
            .ToListAsync(cancellationToken);

        _activity.Publish("tool", "get_telemetry_summary", "get_telemetry_summary", track: false);

        var text = technologies.Count == 0
            ? "No telemetry has been recorded yet."
            : string.Join('\n', technologies
                .OrderByDescending(t => t.events)
                .Select(t => $"{t.technology}: {t.events:N0} events, last at {t.lastAt:u}"));

        // structuredContent must be a JSON object, so the list is wrapped.
        return ToolResults.Ok(text, new { technologies });
    }

    private JobSnapshot RequireJob(string jobId)
    {
        if (!JobService.IsValidId(jobId))
            throw new McpException("jobId must look like job_1a2b3c4d5e6f.");

        return _jobs.Get(jobId)
            ?? throw new McpException($"No job with id {jobId}. Finished jobs are forgotten after 30 minutes.");
    }

    private static string Describe(JobSnapshot job) =>
        $"Job {job.JobId} ({job.Dataset}) is {job.Status}: {job.Percent:0.#}% " +
        $"({job.ProcessedRows:N0} of {job.TotalRows:N0} rows). {job.Message}";
}

internal static class ToolResults
{
    public static CallToolResult Ok(string text, object structured, JsonObject? meta = null) => new()
    {
        Content = [new TextContentBlock { Text = text }],
        StructuredContent = JsonSerializer.SerializeToElement(structured, JobService.Json),
        Meta = meta,
    };
}
