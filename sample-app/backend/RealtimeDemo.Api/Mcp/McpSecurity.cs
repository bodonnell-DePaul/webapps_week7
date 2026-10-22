// =============================================================================
// McpSecurity — guards the /mcp endpoint
// -----------------------------------------------------------------------------
// An MCP server that can start jobs and post chat messages is an API like any
// other. Local MCP servers also face DNS rebinding: a web page in your browser
// talking to http://localhost:<port> on an attacker's behalf. The MCP
// specification therefore asks servers to validate the Origin header, and we
// pin the Host header to loopback names as well.
//
//   1. Host    must be localhost / 127.0.0.1 / [::1]        (Mcp:AllowedHosts)
//   2. Origin  if present, must be one of our web origins   (Mcp:AllowedOrigins)
//              native clients such as Copilot send no Origin at all
//   3. ApiKey  optional shared secret                       (Mcp:ApiKey)
//
// Running behind a tunnel or a LAN address? Add that host to Mcp:AllowedHosts
// and set Mcp:ApiKey so the endpoint is not open to everyone who can reach it.
// =============================================================================

using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using RealtimeDemo.Api.Telemetry;

namespace RealtimeDemo.Api.Mcp;

/// <summary>Settings bound from the "Mcp" configuration section.</summary>
public sealed class McpOptions
{
    /// <summary>Host names the endpoint answers to. Null/empty means loopback only.</summary>
    public string[]? AllowedHosts { get; set; }

    /// <summary>Browser origins allowed to call the endpoint. Defaults to the Vite origins.</summary>
    public string[]? AllowedOrigins { get; set; }

    /// <summary>When set, callers must send it as a bearer token or an X-Api-Key header.</summary>
    public string? ApiKey { get; set; }

    /// <summary>Base URL advertised to the MCP App view. Defaults to the request's own origin.</summary>
    public string? PublicBaseUrl { get; set; }

    public static readonly string[] DefaultHosts = ["localhost", "127.0.0.1", "[::1]"];
}

public sealed class McpSecurityMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IOptionsMonitor<McpOptions> _options;
    private readonly TelemetryService _tele;

    public McpSecurityMiddleware(
        RequestDelegate next, IOptionsMonitor<McpOptions> options, TelemetryService tele)
    {
        _next = next; _options = options; _tele = tele;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var o = _options.CurrentValue;
        var hosts = o.AllowedHosts is { Length: > 0 } ? o.AllowedHosts : McpOptions.DefaultHosts;
        var host = ctx.Request.Host.Host;

        if (!hosts.Contains(host, StringComparer.OrdinalIgnoreCase))
        {
            await Reject(ctx, StatusCodes.Status403Forbidden, "host_not_allowed", host);
            return;
        }

        var origin = ctx.Request.Headers.Origin.ToString();
        if (origin.Length > 0 &&
            !(o.AllowedOrigins ?? []).Contains(origin, StringComparer.OrdinalIgnoreCase))
        {
            await Reject(ctx, StatusCodes.Status403Forbidden, "origin_not_allowed", origin);
            return;
        }

        if (!string.IsNullOrEmpty(o.ApiKey) && !HasValidKey(ctx.Request, o.ApiKey))
        {
            ctx.Response.Headers.WWWAuthenticate = "Bearer realm=\"mcp\"";
            await Reject(ctx, StatusCodes.Status401Unauthorized, "api_key_missing_or_invalid", null);
            return;
        }

        await _next(ctx);
    }

    private async Task Reject(HttpContext ctx, int status, string reason, string? offending)
    {
        var detail = offending is null ? reason : $"{reason}: {Truncate(offending, 120)}";
        _tele.Track("MCP", "request_rejected", detail: detail);

        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync($$"""{"error":"{{reason}}"}""");
    }

    private static bool HasValidKey(HttpRequest request, string expected)
    {
        string? supplied = request.Headers["X-Api-Key"];
        var auth = request.Headers.Authorization.ToString();
        if (string.IsNullOrEmpty(supplied) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            supplied = auth["Bearer ".Length..].Trim();
        if (string.IsNullOrEmpty(supplied)) return false;

        // Hash first so the comparison is constant-time regardless of length.
        return CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(supplied)),
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
