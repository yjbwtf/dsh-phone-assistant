namespace DshPhonePanel;

using System.Reflection;

static class Program
{
    public static readonly string DataDir = ResolveDataDir();
    public static readonly string LogPath = Path.Combine(DataDir, "panel.log");
    private const long MaxLogBytes = 2 * 1024 * 1024;
    private static readonly object LogLock = new();
    public static readonly string LoaderPath = EnsureLoader();

    private static string ResolveDataDir()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "panel-data"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DshPhonePanel"),
            Path.Combine(Path.GetTempPath(), "DshPhonePanel"),
        };
        foreach (var candidate in candidates)
        {
            try
            {
                Directory.CreateDirectory(candidate);
                var probe = Path.Combine(candidate, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return candidate;
            }
            catch
            {
            }
        }
        return Path.GetTempPath();
    }

    public static void Log(string message)
    {
        try
        {
            lock (LogLock)
            {
                Directory.CreateDirectory(DataDir);
                var info = new FileInfo(LogPath);
                if (info.Exists && info.Length > MaxLogBytes)
                {
                    var backup = LogPath + ".1";
                    try { File.Delete(backup); } catch {}
                    try { File.Move(LogPath, backup); } catch {}
                }
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}\r\n");
            }
        }
        catch {}
    }

    private static string EnsureLoader()
    {
        try
        {
            var target = Path.Combine(DataDir, "WebView2Loader.dll");
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DshPhonePanel.WebView2Loader.dll");
            if (stream is null) return target;
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            File.WriteAllBytes(target, memory.ToArray());
            return target;
        }
        catch
        {
            return Path.Combine(DataDir, "WebView2Loader.dll");
        }
    }

    [STAThread]
    static void Main()
    {
        Log("Main start; dataDir=" + DataDir);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log("Unhandled: " + e.ExceptionObject);
        Application.ThreadException += (_, e) => Log("ThreadException: " + e.Exception);
        try
        {
            ApplicationConfiguration.Initialize();
            Log("ApplicationConfiguration initialized");
            Application.Run(new PanelForm());
            Log("Application.Run returned");
        }
        catch (Exception ex)
        {
            Log("Fatal: " + ex);
            throw;
        }
    }
}
