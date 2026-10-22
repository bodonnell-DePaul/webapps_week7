using ModelContextProtocol;

namespace RealtimeDemo.Api.Mcp;

public static class McpUrls
{
    /// <summary>
    /// The address the MCP App view should call back to. Taken from configuration if set,
    /// otherwise from the request itself: the Host header has already been checked against
    /// the allow-list by <see cref="McpSecurityMiddleware"/>, so it is safe to echo.
    /// </summary>
    public static string BaseUrl(IHttpContextAccessor http, McpOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.PublicBaseUrl))
            return options.PublicBaseUrl.TrimEnd('/');

        var request = http.HttpContext?.Request
            ?? throw new McpException("Cannot work out this server's address. Set Mcp:PublicBaseUrl.");
        return $"{request.Scheme}://{request.Host}";
    }
}
