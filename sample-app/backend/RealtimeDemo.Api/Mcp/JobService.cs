// =============================================================================
// JobService — the long-running work behind the MCP tools
// -----------------------------------------------------------------------------
// An MCP tool call is a request/response exchange, so it has to come back fast.
// Slow work therefore follows the "job" pattern:
//
//   start_export    returns a job id immediately; the work continues here
//   job events      are pushed to whoever is watching: an SSE stream (the MCP
//                   App view), SignalR (the web app) and telemetry
//   get_job_status  and cancel_job are small request/response tools
//
// Everything is in memory — this is a demo, not a queue. Finished jobs are kept
// for 30 minutes so late viewers can still replay what happened.
// =============================================================================

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace RealtimeDemo.Api.Mcp;

/// <param name="Percent">0–100, one decimal.</param>
/// <param name="Status">running | completed | cancelled | failed</param>
public sealed record JobSnapshot(
    string JobId,
    string Dataset,
    string Status,
    double Percent,
    int ProcessedRows,
    int TotalRows,
    int DurationSeconds,
    string Message,
    DateTime StartedAt,
    DateTime? FinishedAt);

/// <param name="Type">started | progress | completed | cancelled | failed</param>
public sealed record JobEvent(int Id, string Type, JobSnapshot Snapshot);

/// <summary>Replay of past events plus, for a running job, a live reader.</summary>
public sealed class JobSubscription : IDisposable
{
    private readonly Action? _unsubscribe;

    public JobSubscription(IReadOnlyList<JobEvent> replay, ChannelReader<JobEvent>? live, Action? unsubscribe)
    {
        Replay = replay; Live = live; _unsubscribe = unsubscribe;
    }

    public IReadOnlyList<JobEvent> Replay { get; }

    /// <summary>Null when the job had already finished: the replay is the whole story.</summary>
    public ChannelReader<JobEvent>? Live { get; }

    public void Dispose() => _unsubscribe?.Invoke();
}

public sealed partial class JobService
{
    public const int MaxRunning = 5;

    private const int MaxRetained = 200;
    private static readonly TimeSpan Retention = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(500);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [GeneratedRegex("^job_[0-9a-f]{12}$")]
    private static partial Regex IdPattern();

    public static bool IsValidId(string? id) => id is not null && IdPattern().IsMatch(id);

    private readonly ConcurrentDictionary<string, Job> _jobs = new();
    private readonly object _startGate = new();
    private readonly IHostApplicationLifetime _lifetime;
    private readonly McpActivity _activity;
    private readonly ILogger<JobService> _log;

    public JobService(IHostApplicationLifetime lifetime, McpActivity activity, ILogger<JobService> log)
    {
        _lifetime = lifetime; _activity = activity; _log = log;
    }

    /// <summary>False when <see cref="MaxRunning"/> jobs are already in flight.</summary>
    public bool TryStart(string dataset, int rows, int durationSeconds, out JobSnapshot snapshot)
    {
        Sweep();

        var job = new Job(
            "job_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
            dataset, rows, durationSeconds,
            CancellationTokenSource.CreateLinkedTokenSource(_lifetime.ApplicationStopping));

        // Check-and-add must be atomic, or two simultaneous calls could both slip under the limit.
        lock (_startGate)
        {
            if (_jobs.Values.Count(IsRunning) >= MaxRunning)
            {
                job.Cts.Dispose();
                snapshot = default!;
                return false;
            }
            _jobs[job.Id] = job;
        }

        Apply(job, "started", $"Exporting {dataset}: {Rows(rows)} rows over {durationSeconds}s");
        _ = Task.Run(() => RunAsync(job));

        snapshot = Snapshot(job);
        return true;
    }

    public JobSnapshot? Get(string jobId) =>
        _jobs.TryGetValue(jobId, out var job) ? Snapshot(job) : null;

    /// <returns>The job (null if unknown) and whether this call is what stopped it.</returns>
    public (JobSnapshot? Snapshot, bool Cancelled) Cancel(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return (null, false);

        // Publish first so every viewer sees "cancelled" even before the worker loop notices.
        var cancelled = Apply(job, "cancelled", "Cancelled by request");
        if (cancelled)
        {
            try { job.Cts.Cancel(); }
            catch (ObjectDisposedException) { /* the worker already finished */ }
        }
        return (Snapshot(job), cancelled);
    }

    /// <summary>
    /// Events after <paramref name="afterEventId"/> (the SSE Last-Event-ID), then live ones.
    /// Replay and registration happen under one lock, so nothing is missed or repeated.
    /// </summary>
    public JobSubscription? Subscribe(string jobId, int afterEventId = 0)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return null;

        lock (job.Gate)
        {
            var replay = job.Log.Where(e => e.Id > afterEventId).ToArray();
            if (job.Status != "running") return new JobSubscription(replay, null, null);

            // A job lasts at most a minute (~125 events), so 256 never overflows; DropOldest
            // would only ever discard stale progress, never the final event.
            var channel = Channel.CreateBounded<JobEvent>(new BoundedChannelOptions(256)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
            });
            job.Subscribers.Add(channel);

            return new JobSubscription(replay, channel.Reader, () =>
            {
                lock (job.Gate) job.Subscribers.Remove(channel);
            });
        }
    }

    private async Task RunAsync(Job job)
    {
        try
        {
            var started = Stopwatch.GetTimestamp();
            var total = TimeSpan.FromSeconds(job.DurationSeconds);
            using var timer = new PeriodicTimer(Tick);

            while (await timer.WaitForNextTickAsync(job.Cts.Token))
            {
                var fraction = Math.Min(1.0, Stopwatch.GetElapsedTime(started) / total);
                var processed = (int)Math.Round(fraction * job.TotalRows);

                if (fraction >= 1.0)
                {
                    Apply(job, "completed", $"Exported {Rows(job.TotalRows)} rows from {job.Dataset}", 100, job.TotalRows);
                    return;
                }

                Apply(job, "progress", $"{Rows(processed)} of {Rows(job.TotalRows)} rows exported",
                    Math.Round(fraction * 100, 1), processed);
            }
        }
        catch (OperationCanceledException)
        {
            // A cancel_job call already published "cancelled", which makes this a no-op.
            // What is left is the server shutting down.
            Apply(job, "cancelled", "Server is shutting down");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Job {JobId} failed", job.Id);
            Apply(job, "failed", "The export failed unexpectedly");
        }
        finally
        {
            job.Cts.Dispose();
        }
    }

    /// <summary>
    /// The single place a job changes. Updates state, appends to the log, pushes to live
    /// subscribers and fans out to SignalR/telemetry. Returns false if the job had already
    /// reached a final state, which makes every terminal transition idempotent.
    /// </summary>
    private bool Apply(Job job, string type, string message, double? percent = null, int? processedRows = null)
    {
        var terminal = type is not ("started" or "progress");
        JobEvent ev;
        bool broadcast;

        lock (job.Gate)
        {
            if (job.Status != "running") return false;

            job.Message = message;
            if (percent is { } p) job.Percent = p;
            if (processedRows is { } n) job.ProcessedRows = n;
            if (terminal)
            {
                job.Status = type;
                job.FinishedAt = DateTime.UtcNow;
            }

            ev = new JobEvent(++job.LastEventId, type, Snapshot(job, locked: true));
            job.Log.Add(ev);

            // TryWrite never blocks on these channels, so ordering stays consistent under the lock.
            foreach (var channel in job.Subscribers)
            {
                channel.Writer.TryWrite(ev);
                if (terminal) channel.Writer.TryComplete();
            }
            if (terminal) job.Subscribers.Clear();

            // SignalR/telemetry get every milestone but only each 10% of progress, so a feed
            // stays readable instead of scrolling twice a second.
            var bucket = (int)(job.Percent / 10);
            broadcast = type != "progress" || bucket != job.LastBroadcastBucket;
            if (type == "progress") job.LastBroadcastBucket = bucket;
        }

        if (broadcast)
            _activity.Publish("job", type, $"{job.Id}: {message}", ev.Snapshot, track: type != "progress");

        return true;
    }

    private static bool IsRunning(Job job)
    {
        lock (job.Gate) return job.Status == "running";
    }

    private static JobSnapshot Snapshot(Job job, bool locked = false)
    {
        if (locked) return Build(job);
        lock (job.Gate) return Build(job);

        static JobSnapshot Build(Job j) => new(
            j.Id, j.Dataset, j.Status, j.Percent, j.ProcessedRows, j.TotalRows,
            j.DurationSeconds, j.Message, j.StartedAt, j.FinishedAt);
    }

    private static string Rows(int n) => n.ToString("N0", CultureInfo.InvariantCulture);

    private void Sweep()
    {
        var cutoff = DateTime.UtcNow - Retention;
        var finished = new List<(string Id, DateTime At)>();

        foreach (var (id, job) in _jobs)
        {
            DateTime? at;
            lock (job.Gate) at = job.FinishedAt;
            if (at is { } t) finished.Add((id, t));
        }

        foreach (var (id, at) in finished.Where(f => f.At < cutoff))
            _jobs.TryRemove(id, out _);

        // Hard cap as a backstop: drop the oldest finished jobs first.
        var excess = _jobs.Count - MaxRetained;
        if (excess > 0)
            foreach (var (id, _) in finished.OrderBy(f => f.At).Take(excess))
                _jobs.TryRemove(id, out _);
    }

    private sealed class Job
    {
        public Job(string id, string dataset, int totalRows, int durationSeconds, CancellationTokenSource cts)
        {
            Id = id; Dataset = dataset; TotalRows = totalRows;
            DurationSeconds = durationSeconds; Cts = cts;
        }

        public string Id { get; }
        public string Dataset { get; }
        public int TotalRows { get; }
        public int DurationSeconds { get; }
        public CancellationTokenSource Cts { get; }

        // Everything below is guarded by Gate.
        public readonly object Gate = new();
        public readonly List<JobEvent> Log = [];
        public readonly List<Channel<JobEvent>> Subscribers = [];
        public string Status = "running";
        public double Percent;
        public int ProcessedRows;
        public string Message = "";
        public DateTime StartedAt = DateTime.UtcNow;
        public DateTime? FinishedAt;
        public int LastEventId;
        public int LastBroadcastBucket = -1;
    }
}
