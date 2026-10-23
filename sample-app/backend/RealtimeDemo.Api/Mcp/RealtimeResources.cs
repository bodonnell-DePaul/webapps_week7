// =============================================================================
// RealtimeResources — the MCP "resources" this server exposes
// -----------------------------------------------------------------------------
// Resources are the "nouns" of MCP: things a host can read (and show or attach to
// the conversation) by URI.
//
//   ui://realtime-demo/job-monitor.html   the MCP App view  (an HTML page)
//   realtime://technologies               a decision catalogue (static JSON)
//   realtime://jobs/{jobId}               one export job       (resource template)
//
// An MCP App is just a resource whose MIME type is `text/html;profile=mcp-app`.
// The host fetches it with resources/read and renders it in a sandboxed iframe.
// Its `_meta.ui` tells the host what the page is allowed to do — here, open an
// EventSource to this server, which the default Content-Security-Policy blocks.
// =============================================================================

using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace RealtimeDemo.Api.Mcp;

[McpServerResourceType]
public sealed class RealtimeResources
{
    public const string AppMimeType = "text/html;profile=mcp-app";

    // Read once from the assembly; see the <EmbeddedResource> item in the csproj.
    private static readonly Lazy<string> JobMonitorHtml = new(() =>
    {
        using var stream = typeof(RealtimeResources).Assembly.GetManifestResourceStream("Mcp.Views.job-monitor.html")
            ?? throw new InvalidOperationException("job-monitor.html is not embedded in the assembly.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    private static readonly object[] Catalog =
    [
        new { technology = "Short polling", direction = "client<->server", bestFor = "Occasional \"is it done yet?\" checks", avoidFor = "High-frequency updates", demoRoute = "/polling" },
        new { technology = "Long polling", direction = "client<->server", bestFor = "Hostile networks and older proxies", avoidFor = "Bursty, high-volume traffic", demoRoute = "/polling" },
        new { technology = "HTTP streaming", direction = "server->client", bestFor = "LLM token streams", avoidFor = "Anything needing automatic reconnect", demoRoute = "/streaming" },
        new { technology = "Server-Sent Events", direction = "server->client", bestFor = "Dashboards, feeds and job progress", avoidFor = "Chat or games (lots of client->server traffic)", demoRoute = "/sse" },
        new { technology = "WebSockets", direction = "client<->server", bestFor = "Chat, collaboration, games", avoidFor = "Audio and video", demoRoute = "/websocket" },
        new { technology = "SignalR", direction = "client<->server", bestFor = "Real time on .NET (falls back automatically)", avoidFor = "Non-.NET stacks", demoRoute = "/signalr" },
        new { technology = "WebRTC", direction = "peer<->peer", bestFor = "Audio, video and peer-to-peer data", avoidFor = "Simple notifications", demoRoute = "/webrtc" },
        new { technology = "Web Push", direction = "server->client (background)", bestFor = "Reaching users when the app is closed", avoidFor = "Bulk data", demoRoute = "/push" },
        new { technology = "MCP", direction = "AI host<->server", bestFor = "Letting AI hosts call your app's capabilities", avoidFor = "High-frequency streaming on its own; pair it with SSE or WebSockets", demoRoute = "/mcp" },
    ];

    private readonly IHttpContextAccessor _http;
    private readonly McpOptions _options;
    private readonly JobService _jobs;

    public RealtimeResources(IHttpContextAccessor http, IOptions<McpOptions> options, JobService jobs)
    {
        _http = http; _options = options.Value; _jobs = jobs;
    }

    [McpServerResource(
        UriTemplate = RealtimeTools.JobMonitorUri,
        Name = "job_monitor_view",
        Title = "Export job monitor",
        MimeType = AppMimeType)]
    [Description("MCP App view: live progress for an export job, with a cancel button.")]
    public TextResourceContents JobMonitor()
    {
        var baseUrl = McpUrls.BaseUrl(_http, _options);

        return new TextResourceContents
        {
            Uri = RealtimeTools.JobMonitorUri,
            MimeType = AppMimeType,
            Text = JobMonitorHtml.Value,
            // The host builds the iframe's Content-Security-Policy from this. Without
            // connectDomains the page could not open its EventSource to our server.
            Meta = new JsonObject
            {
                ["ui"] = new JsonObject
                {
                    ["csp"] = new JsonObject { ["connectDomains"] = new JsonArray(baseUrl) },
                    ["prefersBorder"] = true,
                },
            },
        };
    }

    [McpServerResource(
        UriTemplate = "realtime://technologies",
        Name = "realtime_technologies",
        Title = "Real-time technology catalogue",
        MimeType = "application/json")]
    [Description("What each real-time technology in this course is best and worst at, with the demo page for each.")]
    public static string Technologies() =>
        JsonSerializer.Serialize(new { technologies = Catalog }, JobService.Json);

    [McpServerResource(
        UriTemplate = "realtime://jobs/{jobId}",
        Name = "export_job",
        Title = "Export job",
        MimeType = "application/json")]
    [Description("The current state of one export job.")]
    public string Job(string jobId)
    {
        var job = JobService.IsValidId(jobId) ? _jobs.Get(jobId) : null;
        return job is null
            ? throw new McpProtocolException($"No job with id {jobId}.", McpErrorCode.InvalidParams)
            : JsonSerializer.Serialize(job, JobService.Json);
    }
}
