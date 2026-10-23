// =============================================================================
// RealtimePrompts — the MCP "prompts" this server exposes
// -----------------------------------------------------------------------------
// Prompts are reusable, parameterised instructions the *user* picks (in Copilot
// they show up as slash-commands). Where a tool is something the model decides
// to call, a prompt is something the human chooses to start with.
// =============================================================================

using System.ComponentModel;
using ModelContextProtocol.Server;

namespace RealtimeDemo.Api.Mcp;

[McpServerPromptType]
public sealed class RealtimePrompts
{
    [McpServerPrompt(Name = "choose_realtime_technology", Title = "Choose a real-time technology")]
    [Description("Recommends polling, SSE, WebSockets, SignalR, WebRTC or Web Push for a feature.")]
    public static string ChooseRealtimeTechnology(
        [Description("What the feature must do, for example: live order tracking for 10,000 customers.")] string requirement) =>
        $"""
        You are advising on real-time communication for a web app.

        Requirement: {requirement}

        Read the realtime://technologies resource, then recommend ONE technology and at most one fallback.
        Decide in this order:
        1. Direction of data: server to client, client to server, both, or peer to peer?
        2. How often messages flow, and how large they are.
        3. Network limits: proxies, firewalls, mobile battery, delivery while the app is closed.
        4. Server stack and scale: connection counts, sticky sessions, what the team already runs.

        Answer with the pick, why it wins, why the closest alternative loses, and one risk to test first.
        """;
}
