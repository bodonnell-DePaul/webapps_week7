// =============================================================================
// JobTicketService
// -----------------------------------------------------------------------------
// The MCP App view runs in a sandboxed iframe and opens an EventSource straight
// to this server. EventSource cannot send an Authorization header (see the SSE
// page), and the iframe has no login of its own, so we hand it a *ticket*:
//
//     <jobId>|<expiry>  +  HMAC-SHA256 signature, base64url encoded
//
//   • scoped to one job        — useless for any other endpoint or job
//   • short lived (15 minutes) — leaking it in a URL or log has a small blast radius
//   • issued only through MCP  — by the app-only tool `open_job_stream`, so the
//                                model never sees it
//
// The signing key lives in memory, so tickets stop working when the process
// restarts. That is fine here: the view simply asks for a new one.
// =============================================================================

using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace RealtimeDemo.Api.Mcp;

public sealed class JobTicketService
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

    public string Issue(string jobId, out DateTimeOffset expiresAt)
    {
        expiresAt = DateTimeOffset.UtcNow.Add(Lifetime);
        var payload = $"{jobId}|{expiresAt.ToUnixTimeSeconds()}";
        return $"{WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(payload))}.{WebEncoders.Base64UrlEncode(Sign(payload))}";
    }

    public bool IsValid(string? ticket, string jobId)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length > 256) return false;

        var parts = ticket.Split('.');
        if (parts.Length != 2) return false;

        try
        {
            var payload = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(parts[0]));
            var signature = WebEncoders.Base64UrlDecode(parts[1]);
            if (!CryptographicOperations.FixedTimeEquals(signature, Sign(payload))) return false;

            var fields = payload.Split('|');
            return fields.Length == 2
                && fields[0] == jobId
                && long.TryParse(fields[1], out var expiry)
                && DateTimeOffset.UtcNow.ToUnixTimeSeconds() < expiry;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private byte[] Sign(string payload) => HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(payload));
}
