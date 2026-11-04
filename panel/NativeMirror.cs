using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace DshPhonePanel;

/// <summary>
/// Proof-of-concept read-only mirror: launches scrcpy-server directly, reads its
/// H.264 packet stream and forwards it to the WebView2 canvas where WebCodecs
/// decodes it. The existing SDL window remains as a fallback until native
/// frames are ready.
/// </summary>
public sealed class NativeMirror : IDisposable
{
    private const int Port = 27191;
    private readonly string _scid = RandomNumberGenerator.GetInt32(1, int.MaxValue).ToString("x8");
    private string SocketName => "scrcpy_" + _scid;
    private const int MaxPacketSize = 10 * 1024 * 1024;
    private const uint CodecH264 = 0x68323634;

    private readonly CoreWebView2 _webView;
    private readonly Control _host;
    private readonly string _adb;
    private readonly string _jar;
    private readonly string _tempDir;
    private readonly CancellationTokenSource _cts = new();
    private Process? _server;
    private TcpClient? _client;
    private bool _started;
    private bool _ready;
    private bool _disposed;

    public event Action? Ready;
    public event Action<string>? Failed;

    public NativeMirror(CoreWebView2 webView, Control host, string adb, string jar, string tempDir)
    {
        _webView = webView;
        _host = host;
        _adb = adb;
        _jar = jar;
        _tempDir = tempDir;
        _webView.WebMessageReceived += OnWebMessage;
    }

    public void Start()
    {
        if (_started) return;
        _started = true;
        _ = Task.Run(() => RunAsync(_cts.Token));
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var type)) return;
            var value = type.GetString();
            if (value == "native-ready")
            {
                _ready = true;
                Program.Log("native mirror ready");
                Ready?.Invoke();
            }
            else if (value == "native-failed")
            {
                var message = root.TryGetProperty("error", out var error) ? error.GetString() : "unknown";
                Program.Log("native mirror client failed: " + message);
                Failed?.Invoke(message ?? "unknown");
            }
        }
        catch (Exception ex)
        {
            Program.Log("native mirror message failed: " + ex.Message);
        }
    }

    private async Task RunAsync(CancellationToken token)
    {
        try
        {
            if (!File.Exists(_jar)) throw new FileNotFoundException("scrcpy server jar missing", _jar);
            Directory.CreateDirectory(_tempDir);
            Program.Log("native mirror: pushing server");
            await AdbAsync(token, true, "forward", "--remove", $"tcp:{Port}");
            await AdbAsync(token, false, "push", _jar, "/data/local/tmp/scrcpy-server-native.jar");
            await AdbAsync(token, false, "forward", $"tcp:{Port}", $"localabstract:{SocketName}");
            StartServer();
            Program.Log("native mirror: waiting for server");
            await Task.Delay(1500, token);
            Program.Log("native mirror: connecting");
            _client = await ConnectAsync(token);
            var stream = _client.GetStream();
            var header = await ReadExactAsync(stream, 12, token);
            var codec = BinaryPrimitives.ReadUInt32BigEndian(header);
            var width = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(4));
            var height = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(8));
            if (codec != CodecH264) throw new InvalidOperationException($"unsupported codec 0x{codec:X8}");
            Program.Log($"native mirror: video {width}x{height}");
            Post(new { type = "native-stream", width, height, codec = "h264" });

            while (!token.IsCancellationRequested)
            {
                var packetHeader = await ReadExactAsync(stream, 12, token);
                var ptsFlags = BinaryPrimitives.ReadUInt64BigEndian(packetHeader);
                var size = BinaryPrimitives.ReadInt32BigEndian(packetHeader.AsSpan(8));
                if (size <= 0 || size > MaxPacketSize) throw new InvalidDataException($"invalid packet size {size}");
                var payload = await ReadExactAsync(stream, size, token);
                var config = (ptsFlags & (1UL << 63)) != 0;
                var key = (ptsFlags & (1UL << 62)) != 0;
                var pts = (long)(ptsFlags & ((1UL << 62) - 1));
                var data = Convert.ToBase64String(payload);
                if (config)
                {
                    Post(new { type = "native-codec", data });
                }
                else
                {
                    Post(new { type = "native-frame", key, pts, data });
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex)
        {
            Program.Log("native mirror failed: " + ex);
            try { if (_server is { HasExited: false }) _server.Kill(true); } catch { }
            Failed?.Invoke(ex.Message);
        }
    }

    private async Task<TcpClient> ConnectAsync(CancellationToken token)
    {
        Exception? last = null;
        for (var i = 0; i < 80; i++)
        {
            token.ThrowIfCancellationRequested();
            var client = new TcpClient { NoDelay = true };
            try
            {
                await client.ConnectAsync(IPAddress.Loopback, Port, token);
                return client;
            }
            catch (Exception ex)
            {
                last = ex;
                client.Dispose();
                await Task.Delay(120, token);
            }
        }
        throw new InvalidOperationException("native mirror connect timeout", last);
    }

    private void StartServer()
    {
        var shell = "CLASSPATH=/data/local/tmp/scrcpy-server-native.jar " +
            "app_process / com.genymobile.scrcpy.Server 2.7 " +
            $"scid={_scid} tunnel_forward=true audio=false control=false cleanup=false " +
            "send_device_meta=false send_dummy_byte=false send_codec_meta=true send_frame_meta=true " +
            "max_size=1080 video_bit_rate=8000000 stay_awake=true power_on=true log_level=info";
        var psi = new ProcessStartInfo(_adb)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add("shell");
        psi.ArgumentList.Add(shell);
        psi.Environment["TEMP"] = _tempDir;
        psi.Environment["TMP"] = _tempDir;
        var process = Process.Start(psi) ?? throw new InvalidOperationException("failed to start scrcpy-server");
        _server = process;
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => Program.Log($"native server exited: {process.ExitCode}");
        _ = Task.Run(async () =>
        {
            try
            {
                while (!process.StandardError.EndOfStream)
                {
                    var line = await process.StandardError.ReadLineAsync();
                    if (!string.IsNullOrWhiteSpace(line)) Program.Log("native server: " + line);
                }
            }
            catch { }
        });
        _ = Task.Run(async () =>
        {
            try
            {
                while (!process.StandardOutput.EndOfStream)
                {
                    var line = await process.StandardOutput.ReadLineAsync();
                    if (!string.IsNullOrWhiteSpace(line)) Program.Log("native server out: " + line);
                }
            }
            catch { }
        });
    }

    private async Task AdbAsync(CancellationToken token, bool allowFail, params string[] args)
    {
        var psi = new ProcessStartInfo(_adb)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        psi.Environment["TEMP"] = _tempDir;
        psi.Environment["TMP"] = _tempDir;
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("failed to start adb");
        var stdout = await process.StandardOutput.ReadToEndAsync(token);
        var stderr = await process.StandardError.ReadToEndAsync(token);
        await process.WaitForExitAsync(token);
        if (process.ExitCode != 0 && !allowFail)
        {
            throw new InvalidOperationException($"adb {string.Join(' ', args)} failed: {stderr.Trim()}");
        }
        if (!string.IsNullOrWhiteSpace(stdout)) Program.Log("native adb: " + stdout.Trim());
    }

    private static async Task<byte[]> ReadExactAsync(NetworkStream stream, int count, CancellationToken token)
    {
        var buffer = new byte[count];
        var offset = 0;
        while (offset < count)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, count - offset), token);
            if (read <= 0) throw new EndOfStreamException("native mirror stream closed");
            offset += read;
        }
        return buffer;
    }

    private void Post(object message)
    {
        if (_disposed) return;
        var json = JsonSerializer.Serialize(message);
        try
        {
            _host.BeginInvoke(() =>
            {
                try { _webView.PostWebMessageAsJson(json); } catch { }
            });
        }
        catch { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _cts.Cancel(); } catch { }
        try { _client?.Dispose(); } catch { }
        try { if (_server is { HasExited: false }) _server.Kill(true); } catch { }
        try { _webView.WebMessageReceived -= OnWebMessage; } catch { }
        try
        {
            var psi = new ProcessStartInfo(_adb)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("forward");
            psi.ArgumentList.Add("--remove");
            psi.ArgumentList.Add($"tcp:{Port}");
            psi.Environment["TEMP"] = _tempDir;
            psi.Environment["TMP"] = _tempDir;
            using var p = Process.Start(psi);
            p?.WaitForExit(3000);
        }
        catch { }
        _cts.Dispose();
    }
}
