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
            return ValidateBaseUrl(options.PublicBaseUrl);

        var request = http.HttpContext?.Request
            ?? throw new McpException("Cannot work out this server's address. Set Mcp:PublicBaseUrl.");
        return ValidateBaseUrl($"{request.Scheme}://{request.Host}");
    }

    private static string ValidateBaseUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(uri.UserInfo)
            || uri.AbsolutePath != "/"
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new McpException("Mcp:PublicBaseUrl must be an HTTP or HTTPS origin with no path, query, or fragment.");
        }

        return uri.GetLeftPart(UriPartial.Authority);
    }
}
