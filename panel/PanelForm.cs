using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshPhonePanel;

public sealed class PanelForm : Form
{
    private readonly WebView2 _webView;
    private SimpleProxyServer? _proxy;
    private readonly string _backend;
    private Process? _scrcpy;
    private IntPtr _scrcpyHwnd = IntPtr.Zero;
    private NativeMirror? _nativeMirror;
    private bool _nativeActive;
    private bool _consoleVisible = true;
    private bool _scrcpyPointerDown;
    private int _scrcpyPointerButton;
    private double _lastPointerX;
    private double _lastPointerY;
    private readonly System.Windows.Forms.Timer _pointerWatchTimer = new() { Interval = 80 };
    private readonly System.Windows.Forms.Timer _placeTimer = new() { Interval = 400 };
    private bool _placing;
    private int _placeLogs;

    public PanelForm()
    {
        _backend = Environment.GetEnvironmentVariable("DSH_PANEL_BACKEND")?.TrimEnd('/') ?? "http://127.0.0.1:18642";
        Text = "DSH 手机助手面板";
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(9, 14, 20);
        MinimumSize = new Size(900, 700);
        var screen = Screen.AllScreens.FirstOrDefault(s => !s.Primary) ?? Screen.PrimaryScreen!;
        var area = screen.WorkingArea;
        Location = new Point(area.Left + 24, area.Top + 24);
        Size = new Size(Math.Max(900, Math.Min(1400, area.Width - 48)), Math.Max(700, Math.Min(1000, area.Height - 48)));

        _webView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_webView);
        Load += OnLoadAsync;
        FormClosed += (_, _) =>
        {
            _placeTimer.Stop();
            _pointerWatchTimer.Stop();
            try { _nativeMirror?.Dispose(); } catch {}
            if (_scrcpy is not null)
            {
                try { if (!_scrcpy.HasExited) _scrcpy.Kill(true); } catch {}
            }
            _proxy?.Dispose();
        };
        _placeTimer.Tick += async (_, _) => await PlaceScrcpyAsync();
        _pointerWatchTimer.Tick += (_, _) => WatchPointerRelease();
        _pointerWatchTimer.Start();
    }

    private void WatchPointerRelease()
    {
        if (!_scrcpyPointerDown) return;
        var virtualKey = _scrcpyPointerButton switch
        {
            2 => 0x02, // VK_RBUTTON
            1 => 0x04, // VK_MBUTTON
            _ => 0x01, // VK_LBUTTON
        };
        if ((Native.GetAsyncKeyState(virtualKey) & 0x8000) != 0) return;
        Program.Log("pointer release watchdog");
        ForwardScrcpyPointer("up", _lastPointerX, _lastPointerY, _scrcpyPointerButton);
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        Program.Log("PanelForm Load");
        try
        {
            _proxy = new SimpleProxyServer(_backend);
            Program.Log("Proxy created, starting");
            await _proxy.StartAsync();
            Program.Log("Proxy started on " + _proxy.Port);
            var url = $"http://127.0.0.1:{_proxy.Port}/";
            var userData = Path.Combine(Program.DataDir, "WebView2");
            Directory.CreateDirectory(userData);
            Program.Log("Creating WebView2 environment at " + userData + "; loader=" + Program.LoaderPath);
            CoreWebView2Environment.SetLoaderDllFolderPath(Program.DataDir);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            Program.Log("Ensuring WebView2");
            await _webView.EnsureCoreWebView2Async(environment);
            Program.Log("WebView2 ready");
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.WebMessageReceived += OnPanelWebMessage;
            SetupNativeMirror();
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("""
                (() => {
                  const show = () => {
                    if (document.getElementById('dsh-panel-offline')) return;
                    const el = document.createElement('div');
                    el.id = 'dsh-panel-offline';
                    el.textContent = 'DSH 手机助手插件未运行：请先启动 DSH 桌面端，并确认 127.0.0.1:18642 可访问。';
                    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:10px 16px;background:#8a3b12;color:#fff;font:13px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 2px 12px #0008';
                    document.documentElement.appendChild(el);
                  };
                  const check = async () => {
                    try {
                      const r = await fetch('/api/health', { cache: 'no-store' });
                      if (r.ok) return;
                    } catch {}
                    show();
                  };
                  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
                  else check();
                })();
                """);
            _webView.CoreWebView2.Navigate(url);
            _webView.CoreWebView2.NavigationCompleted += async (_, _) =>
            {
                if (_scrcpy is not null) return;
                try
                {
                    await Task.Delay(1200);
                    var rect = await GetPhoneRectAsync();
                    StartScrcpy(rect?.w ?? 320, rect?.h ?? 700);
                    _placeTimer.Start();
                    _nativeMirror?.Start();
                }
                catch (Exception ex)
                {
                    Program.Log("navigation start scrcpy failed: " + ex.Message);
                }
            };
        }
        catch (Exception ex)
        {
            Program.Log("Panel start failed: " + ex);
            MessageBox.Show(this,
                $"面板启动失败：{ex.Message}\n\n请确认已安装 Microsoft Edge WebView2 Runtime，并确认 DSH 手机助手插件正在运行。\n\n日志：{Program.LogPath}",
                "DSH 手机助手面板", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task<(int x, int y, int w, int h)?> GetPhoneRectAsync()
    {
        const string script = "(()=>{const e=document.querySelector('#phoneImg');if(!e)return null;const r=e.getBoundingClientRect();if(r.width<20||r.height<20)return null;return {x:r.left,y:r.top,w:r.width,h:r.height,innerWidth:window.innerWidth,innerHeight:window.innerHeight};})()";
        var json = await _webView.ExecuteScriptAsync(script);
        if (string.IsNullOrWhiteSpace(json) || json == "null") return null;
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var innerW = root.GetProperty("innerWidth").GetDouble();
        var innerH = root.GetProperty("innerHeight").GetDouble();
        var sx = innerW > 0 ? _webView.ClientSize.Width / innerW : 1;
        var sy = innerH > 0 ? _webView.ClientSize.Height / innerH : 1;
        return ((int)Math.Round(root.GetProperty("x").GetDouble() * sx),
            (int)Math.Round(root.GetProperty("y").GetDouble() * sy),
            Math.Max(2, (int)Math.Round(root.GetProperty("w").GetDouble() * sx)),
            Math.Max(2, (int)Math.Round(root.GetProperty("h").GetDouble() * sy)));
    }

    private void OnPanelWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString();
            if (type == "native-pointer")
            {
                var phase = root.TryGetProperty("phase", out var phaseElement) ? phaseElement.GetString() : "move";
                var nx = root.TryGetProperty("x", out var xElement) ? xElement.GetDouble() : 0;
                var ny = root.TryGetProperty("y", out var yElement) ? yElement.GetDouble() : 0;
                var button = root.TryGetProperty("button", out var buttonElement) ? buttonElement.GetInt32() : 0;
                ForwardScrcpyPointer(phase ?? "move", nx, ny, button);
                return;
            }
            if (type != "tab") return;
            var tab = root.TryGetProperty("tab", out var tabElement) ? tabElement.GetString() : "";
            _consoleVisible = tab == "console";
            if (!_consoleVisible)
            {
                if (_scrcpyPointerDown) ForwardScrcpyPointer("up", _lastPointerX, _lastPointerY, _scrcpyPointerButton);
                if (_scrcpyHwnd != IntPtr.Zero) Native.ShowWindow(_scrcpyHwnd, 0);
            }
            else if (!_nativeActive && _scrcpyHwnd != IntPtr.Zero)
            {
                Native.ShowWindow(_scrcpyHwnd, 8);
            }
            Program.Log("panel tab: " + tab);
        }
        catch (Exception ex)
        {
            Program.Log("panel tab message failed: " + ex.Message);
        }
    }

    private void ForwardScrcpyPointer(string phase, double nx, double ny, int button = 0)
    {
        if (_scrcpyHwnd == IntPtr.Zero) return;
        _lastPointerX = nx;
        _lastPointerY = ny;
        if (phase == "down") _scrcpyPointerButton = button;
        var rect = new Native.RECT();
        if (!Native.GetClientRect(_scrcpyHwnd, out rect)) return;
        var width = Math.Max(2, rect.Right - rect.Left);
        var height = Math.Max(2, rect.Bottom - rect.Top);
        var x = Math.Clamp((int)Math.Round(nx * width), 0, width - 1);
        var y = Math.Clamp((int)Math.Round(ny * height), 0, height - 1);
        var point = (IntPtr)((y << 16) | (x & 0xffff));
        const uint WM_MOUSEMOVE = 0x0200;
        const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
        const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
        const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
        const int MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002, MK_MBUTTON = 0x0010;
        var (down, up, mask) = button switch
        {
            2 => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
            1 => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
            _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
        };
        if (phase == "down")
        {
            Native.PostMessage(_scrcpyHwnd, WM_MOUSEMOVE, IntPtr.Zero, point);
            Native.PostMessage(_scrcpyHwnd, down, (IntPtr)mask, point);
            _scrcpyPointerDown = true;
        }
        else if (phase == "up")
        {
            Native.PostMessage(_scrcpyHwnd, WM_MOUSEMOVE, (IntPtr)(_scrcpyPointerDown ? mask : 0), point);
            Native.PostMessage(_scrcpyHwnd, up, IntPtr.Zero, point);
            _scrcpyPointerDown = false;
        }
        else
        {
            Native.PostMessage(_scrcpyHwnd, WM_MOUSEMOVE, (IntPtr)(_scrcpyPointerDown ? mask : 0), point);
        }
    }

    private void SetupNativeMirror()
    {
        try
        {
            if (Environment.GetEnvironmentVariable("DSH_NATIVE_MIRROR") == "0") return;
            var adb = ResolveAdb();
            var jarCandidates = new[]
            {
                Path.Combine(AppContext.BaseDirectory, "runtime", "scrcpy-server-2.7.jar"),
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "runtime", "scrcpy-server-2.7.jar")),
            };
            var jar = jarCandidates.FirstOrDefault(File.Exists) ?? @"D:\投屏\scrcpy\scrcpy-server";
            if (!File.Exists(jar))
            {
                Program.Log("native mirror jar not found: " + jar);
                return;
            }
            _nativeMirror = new NativeMirror(_webView.CoreWebView2, _webView, adb, jar, Path.Combine(Program.DataDir, "native-tmp"));
            _nativeMirror.Ready += () => BeginInvoke(() =>
            {
                _nativeActive = true;
                if (_scrcpyHwnd != IntPtr.Zero) Native.ShowWindow(_scrcpyHwnd, 0);
                Program.Log("native mirror active; SDL window hidden");
            });
            _nativeMirror.Failed += (message) => BeginInvoke(() =>
            {
                _nativeActive = false;
                if (_scrcpyHwnd != IntPtr.Zero) Native.ShowWindow(_scrcpyHwnd, 8);
                Program.Log("native mirror fallback to SDL: " + message);
            });
        }
        catch (Exception ex)
        {
            Program.Log("native mirror setup failed: " + ex.Message);
        }
    }

    private static string ResolveAdb()
    {
        var adb = Environment.GetEnvironmentVariable("SCRCPY_ADB");
        if (!string.IsNullOrWhiteSpace(adb)) return adb;
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "runtime", "adb33", "adb.exe"),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "runtime", "adb33", "adb.exe")),
        };
        var bundled = candidates.FirstOrDefault(File.Exists);
        return bundled ?? @"D:\投屏\QtScrcpy-win-x64-v3.3.3\adb.exe";
    }

    private void StartScrcpy(int width, int height)
    {
        if (_scrcpy is not null) return;
        try
        {
            const double videoAspect = 1080.0 / 2340.0;
            if (width / (double)height > videoAspect) width = Math.Max(2, (int)Math.Round(height * videoAspect));
            else height = Math.Max(2, (int)Math.Round(width / videoAspect));
            var path = Environment.GetEnvironmentVariable("SCRCPY_PATH");
            if (string.IsNullOrWhiteSpace(path))
            {
                var candidates = new[]
                {
                    Path.Combine(AppContext.BaseDirectory, "runtime", "scrcpy-2.7", "scrcpy.exe"),
                    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "runtime", "scrcpy-2.7", "scrcpy.exe")),
                    @"D:\投屏\scrcpy\scrcpy.exe",
                    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "runtime", "scrcpy-v5.0", "scrcpy-win64-v5.0", "scrcpy.exe")),
                };
                path = candidates.FirstOrDefault(File.Exists) ?? candidates[0];
            }
            if (!File.Exists(path))
            {
                Program.Log("scrcpy not found: " + path);
                return;
            }
            var adb = ResolveAdb();
            var tmp = Path.Combine(Program.DataDir, "adb-tmp");
            Directory.CreateDirectory(tmp);
            Program.Log($"scrcpy target size: {width}x{height}; exe={path}; adb={adb}");
            var psi = new ProcessStartInfo(path)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
            };
            psi.Environment["ADB"] = adb;
            psi.Environment["TEMP"] = tmp;
            psi.Environment["TMP"] = tmp;
            foreach (var arg in new[]
            {
                "--no-audio",
                "--turn-screen-off",
                "--mouse=sdk",
                "--window-borderless",
                "--window-title=DSH 手机镜像",
                "--window-x=-10000",
                "--window-y=-10000",
                $"--window-width={Math.Max(200, width)}",
                $"--window-height={Math.Max(300, height)}",
            }) psi.ArgumentList.Add(arg);
            _scrcpy = Process.Start(psi);
            Program.Log("scrcpy started: " + _scrcpy?.Id);
            _ = Task.Run(async () =>
            {
                for (var i = 0; i < 50 && _scrcpyHwnd == IntPtr.Zero; i++)
                {
                    await Task.Delay(150);
                    var hwnd = FindScrcpyWindow(_scrcpy?.Id ?? 0);
                    if (hwnd != IntPtr.Zero)
                    {
                        _scrcpyHwnd = hwnd;
                        BeginInvoke(() => EmbedScrcpy(hwnd));
                    }
                }
            });
        }
        catch (Exception ex)
        {
            Program.Log("scrcpy start failed: " + ex);
        }
    }

    private static IntPtr FindScrcpyWindow(int processId)
    {
        var found = IntPtr.Zero;
        Native.EnumWindows((hwnd, _) =>
        {
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == processId && Native.GetWindowTextLength(hwnd) > 0)
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private void EmbedScrcpy(IntPtr hwnd)
    {
        try
        {
            var style = Native.GetWindowLong(hwnd, -16);
            Native.SetParent(hwnd, Handle);
            Native.SetWindowLong(hwnd, -16, (style & ~unchecked((int)0x80000000)) | 0x40000000 | 0x10000000);
            Native.SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 10, 10, 0x0060);
            Program.Log($"scrcpy embedded: {hwnd}");
            _ = _webView.ExecuteScriptAsync("window.__dshScrcpyEmbedded=true");
        }
        catch (Exception ex)
        {
            Program.Log("scrcpy embed failed: " + ex);
        }
    }

    private async Task PlaceScrcpyAsync()
    {
        if (_placing || _webView.CoreWebView2 is null) return;
        if (_scrcpy is not null && _scrcpy.HasExited)
        {
            Program.Log("scrcpy exited; fallback to screenshot refresh");
            _scrcpy = null;
            _scrcpyHwnd = IntPtr.Zero;
            try { await _webView.ExecuteScriptAsync("window.__dshScrcpyEmbedded=false"); } catch {}
            return;
        }
        if (_scrcpyHwnd == IntPtr.Zero) return;
        if (_nativeActive) return;
        if (!_consoleVisible) return;
        _placing = true;
        try
        {
            const string script = "(()=>{const e=document.querySelector('#phoneImg');if(!e)return null;const r=e.getBoundingClientRect();if(r.width<20||r.height<20)return null;return {x:r.left,y:r.top,w:r.width,h:r.height,innerWidth:window.innerWidth,innerHeight:window.innerHeight,dpr:window.devicePixelRatio||1};})()";
            var json = await _webView.ExecuteScriptAsync(script);
            if (string.IsNullOrWhiteSpace(json) || json == "null")
            {
                Native.ShowWindow(_scrcpyHwnd, 0);
                return;
            }
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var cssX = root.GetProperty("x").GetDouble();
            var cssY = root.GetProperty("y").GetDouble();
            var cssW = root.GetProperty("w").GetDouble();
            var cssH = root.GetProperty("h").GetDouble();
            var innerW = root.GetProperty("innerWidth").GetDouble();
            var innerH = root.GetProperty("innerHeight").GetDouble();
            var dpr = root.GetProperty("dpr").GetDouble();
            var sx = innerW > 0 ? _webView.ClientSize.Width / innerW : 1;
            var sy = innerH > 0 ? _webView.ClientSize.Height / innerH : 1;
            var x = (int)Math.Round(cssX * sx);
            var y = (int)Math.Round(cssY * sy);
            var w = Math.Max(2, (int)Math.Round(cssW * sx));
            var h = Math.Max(2, (int)Math.Round(cssH * sy));
            const double videoAspect = 1080.0 / 2340.0;
            var vx = x;
            var vy = y;
            var vw = w;
            var vh = h;
            if (w / (double)h > videoAspect)
            {
                vw = Math.Max(2, (int)Math.Round(h * videoAspect));
                vx = x + (w - vw) / 2;
            }
            else
            {
                vh = Math.Max(2, (int)Math.Round(w / videoAspect));
                vy = y + (h - vh) / 2;
            }
            if (_placeLogs < 3)
            {
                _placeLogs += 1;
                Program.Log($"place css=({cssX:0},{cssY:0},{cssW:0}x{cssH:0}) dpr={dpr:0.##} inner={innerW:0}x{innerH:0} scale={sx:0.###},{sy:0.###} target=({vx},{vy},{vw}x{vh}) client={_webView.ClientSize.Width}x{_webView.ClientSize.Height}");
            }
            Native.ShowWindow(_scrcpyHwnd, 8);
            Native.SetWindowPos(_scrcpyHwnd, IntPtr.Zero, vx, vy, vw, vh, 0x0014);
        }
        catch (Exception ex)
        {
            Program.Log("scrcpy place failed: " + ex.Message);
        }
        finally
        {
            _placing = false;
        }
    }
}

internal static class Native
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
}

/// <summary>
/// Tiny loopback server: serves the embedded panel UI and proxies /api/** to the DSH plugin.
/// This keeps the HTML/CSS/JS inside the EXE while still using the live plugin backend.
/// </summary>
public sealed class SimpleProxyServer : IDisposable
{
    private readonly string _backend;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _cts = new();
    private TcpListener? _listener;
    private Task? _acceptLoop;

    public int Port { get; private set; }

    public SimpleProxyServer(string backend)
    {
        _backend = backend.TrimEnd('/');
        _http = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(4),
        })
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Encoding", "identity");
    }

    public Task StartAsync()
    {
        for (var port = 18643; port < 18720; port++)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                _listener = listener;
                Port = port;
                _acceptLoop = AcceptLoopAsync(_cts.Token);
                return Task.CompletedTask;
            }
            catch (SocketException)
            {
            }
        }
        throw new InvalidOperationException("找不到可用的本地面板端口（18643-18719）");
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested && _listener is not null)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(token); }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (SocketException) { continue; }
            _ = HandleClientAsync(client, token);
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken token)
    {
        using (client)
        {
            client.ReceiveTimeout = 15000;
            var stream = client.GetStream();
            try
            {
                var head = await ReadHeaderBlockAsync(stream, token);
                if (head is null) return;
                var lines = head.Split("\r\n", StringSplitOptions.None);
                if (lines.Length == 0) return;
                var requestLine = lines[0].Split(' ', 3);
                if (requestLine.Length < 2) return;
                var method = requestLine[0].ToUpperInvariant();
                var rawUrl = requestLine[1];
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (var i = 1; i < lines.Length; i++)
                {
                    var idx = lines[i].IndexOf(':');
                    if (idx > 0) headers[lines[i][..idx].Trim()] = lines[i][(idx + 1)..].Trim();
                }
                var contentLength = headers.TryGetValue("Content-Length", out var cls) && int.TryParse(cls, out var n) ? n : 0;
                byte[] body = Array.Empty<byte>();
                if (contentLength > 0)
                {
                    body = new byte[contentLength];
                    var offset = 0;
                    while (offset < body.Length)
                    {
                        var read = await stream.ReadAsync(body.AsMemory(offset), token);
                        if (read <= 0) break;
                        offset += read;
                    }
                }

                var path = rawUrl.Split('?', 2)[0];
                if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
                {
                    await ProxyAsync(stream, method, rawUrl, headers, body, token);
                    return;
                }

                var resource = path switch
                {
                    "/" or "/index.html" => "DshPhonePanel.ui.index.html",
                    "/app.js" => "DshPhonePanel.ui.app.js",
                    "/style.css" => "DshPhonePanel.ui.style.css",
                    "/icon.svg" => "DshPhonePanel.ui.icon.svg",
                    _ => null,
                };
                if (resource is null)
                {
                    await WriteResponseAsync(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"), token);
                    return;
                }
                var bytes = LoadResource(resource);
                var contentType = resource.EndsWith(".html", StringComparison.Ordinal) ? "text/html; charset=utf-8"
                    : resource.EndsWith(".js", StringComparison.Ordinal) ? "application/javascript; charset=utf-8"
                    : resource.EndsWith(".css", StringComparison.Ordinal) ? "text/css; charset=utf-8"
                    : "image/svg+xml";
                await WriteResponseAsync(stream, 200, "OK", contentType, bytes, token);
            }
            catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException)
            {
            }
            catch
            {
                try
                {
                    await WriteResponseAsync(stream, 500, "Internal Server Error", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("panel error"), token);
                }
                catch {}
            }
        }
    }

    private async Task ProxyAsync(NetworkStream stream, string method, string rawUrl, Dictionary<string, string> headers, byte[] body, CancellationToken token)
    {
        try
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), _backend + rawUrl);
            if (body.Length > 0)
            {
                request.Content = new ByteArrayContent(body);
                if (headers.TryGetValue("Content-Type", out var contentType)) request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            }
            if (headers.TryGetValue("Accept", out var accept)) request.Headers.TryAddWithoutValidation("Accept", accept);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if (rawUrl.Contains("/api/events", StringComparison.OrdinalIgnoreCase))
            {
                var header = $"HTTP/1.1 {(int)response.StatusCode} {response.ReasonPhrase}\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nX-Accel-Buffering: no\r\n\r\n";
                var headBytes = Encoding.ASCII.GetBytes(header);
                await stream.WriteAsync(headBytes, token);
                await stream.FlushAsync(token);
                await using var source = await response.Content.ReadAsStreamAsync(token);
                var buffer = new byte[8192];
                while (!token.IsCancellationRequested)
                {
                    var read = await source.ReadAsync(buffer, token);
                    if (read <= 0) break;
                    await stream.WriteAsync(buffer.AsMemory(0, read), token);
                    await stream.FlushAsync(token);
                }
                return;
            }

            var data = await response.Content.ReadAsByteArrayAsync(token);
            var content = response.Content.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";
            await WriteResponseAsync(stream, (int)response.StatusCode, response.ReasonPhrase ?? "OK", content, data, token);
        }
        catch (Exception ex)
        {
            var json = Encoding.UTF8.GetBytes($$"""{"ok":false,"error":"{{EscapeJson(ex.Message)}}"}""");
            await WriteResponseAsync(stream, 503, "Service Unavailable", "application/json; charset=utf-8", json, token);
        }
    }

    private static string EscapeJson(string value) => value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");

    private static async Task<string?> ReadHeaderBlockAsync(NetworkStream stream, CancellationToken token)
    {
        var bytes = new List<byte>(4096);
        var one = new byte[1];
        while (bytes.Count < 64 * 1024)
        {
            var read = await stream.ReadAsync(one, token);
            if (read <= 0) return null;
            bytes.Add(one[0]);
            var c = bytes.Count;
            if (c >= 4 && bytes[c - 4] == 13 && bytes[c - 3] == 10 && bytes[c - 2] == 13 && bytes[c - 1] == 10)
                return Encoding.ASCII.GetString(bytes.ToArray());
        }
        return null;
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int status, string reason, string contentType, byte[] body, CancellationToken token)
    {
        var header = $"HTTP/1.1 {status} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header), token);
        await stream.WriteAsync(body, token);
        await stream.FlushAsync(token);
    }

    private static readonly Dictionary<string, byte[]> Cache = new(StringComparer.Ordinal);

    private static byte[] LoadResource(string name)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(name, out var cached)) return cached;
            var assembly = Assembly.GetExecutingAssembly();
            using var resource = assembly.GetManifestResourceStream(name)
                ?? throw new InvalidOperationException($"缺少嵌入资源 {name}");
            using var memory = new MemoryStream();
            resource.CopyTo(memory);
            var bytes = memory.ToArray();
            Cache[name] = bytes;
            return bytes;
        }
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch {}
        try { _listener?.Stop(); } catch {}
        try { _http.Dispose(); } catch {}
        try { _acceptLoop?.Wait(500); } catch {}
        _cts.Dispose();
    }
}
