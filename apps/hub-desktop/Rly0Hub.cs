// RLY/0 Hub standalone window: tray, single instance, close-to-tray, and a WebView2 page that talks
// to the bundled hub service (app/hub-service.mjs) over stdio. All product logic lives in the
// service; this shell only owns windows, the tray and the service process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    internal const int ShowMessage = 0x8031, ExitMessage = 0x8032;
    internal const string ControlTitle = "RLY0_HUB_CONTROL_V1";
    internal const string PageHost = "hub.rly0.local";
    internal const string PageUrl = "https://hub.rly0.local/index.html";
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1 << 20 };
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr FindWindow(string klass, string title);
    [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr hwnd, int message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    internal static string Quote(string s) {
        if (s.IndexOf('"') >= 0 || s.IndexOf('\n') >= 0 || s.IndexOf('\r') >= 0) throw new InvalidOperationException("UNSAFE_PATH");
        return "\"" + s.TrimEnd('\\') + "\"";
    }

    [STAThread]
    public static int Main(string[] args) {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool background = false, exit = false;
        foreach (string arg in args) {
            if (arg == "--background") background = true;
            else if (arg == "--exit") exit = true;
        }
        if (exit) {
            IntPtr target = FindWindow(null, ControlTitle);
            if (target != IntPtr.Zero) PostMessage(target, ExitMessage, IntPtr.Zero, IntPtr.Zero);
            return 0;
        }
        bool created;
        using (var mutex = new Mutex(true, "Local\\RLY0_HUB_DESKTOP_V1", out created)) {
            if (!created) {
                // Already running (often in the tray): bring its window up instead of a second copy.
                IntPtr target = FindWindow(null, ControlTitle);
                if (target != IntPtr.Zero) PostMessage(target, ShowMessage, IntPtr.Zero, IntPtr.Zero);
                return 0;
            }
            try {
                string bin = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                using (var context = new HubContext(Path.GetDirectoryName(bin), background)) Application.Run(context);
            } catch (Exception) {
                MessageBox.Show("RLY/0 Hub 未能启动。请确认安装目录完整，或重新解压后再试。", "RLY/0 Hub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            } finally { mutex.ReleaseMutex(); }
        }
        return 0;
    }
}

internal sealed class ControlWindow : NativeWindow, IDisposable {
    private readonly Action show, quit;
    internal ControlWindow(Action show, Action quit) {
        this.show = show; this.quit = quit;
        CreateHandle(new CreateParams { Caption = Program.ControlTitle });
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == Program.ShowMessage) show();
        else if (m.Msg == Program.ExitMessage) quit();
        base.WndProc(ref m);
    }
    public void Dispose() { DestroyHandle(); }
}

internal sealed class HubContext : ApplicationContext {
    private static readonly Regex PageId = new Regex("^w[0-9]{1,12}$");
    private static readonly Regex Method = new Regex("^[a-z]+(\\.[a-zA-Z]+){1,2}$");
    private readonly string root;
    private readonly Icon icon;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem autostartItem;
    private readonly ControlWindow control;
    private readonly Control dispatch = new Control();
    private readonly System.Windows.Forms.Timer balanceTimer = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer alertTimer = new System.Windows.Forms.Timer();
    private string balloonAction;
    private readonly string webviewData;
    private ChildJob job;
    private Process worker;
    private PanelWindow panel;
    private bool exiting, ready, toldAboutTray;
    private int restarts, internalSequence;
    private readonly Dictionary<string, Action<Dictionary<string, object>>> internalReplies = new Dictionary<string, Action<Dictionary<string, object>>>();

    internal HubContext(string root, bool background) {
        this.root = root;
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        webviewData = Path.Combine(local, "rly0-hub", "hub-webview");
        Directory.CreateDirectory(webviewData);
        dispatch.CreateControl();
        icon = new Icon(Path.Combine(root, "bin", "rly0-hub.ico"));
        control = new ControlWindow(ShowPanel, Quit);
        tray = new NotifyIcon { Icon = icon, Text = "RLY/0 Hub", Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 RLY/0 Hub", null, delegate { ShowPanel(); });
        menu.Items.Add("打开 Codex", null, delegate { SendInternal("codex.open", null, null); });
        menu.Items.Add("充值", null, delegate { SendInternal("links.open", new Dictionary<string, object> { { "target", "recharge" } }, null); });
        menu.Items.Add(new ToolStripSeparator());
        autostartItem = new ToolStripMenuItem("开机自启") { CheckOnClick = false };
        autostartItem.Click += delegate {
            bool next = !autostartItem.Checked;
            SendInternal("autostart.set", new Dictionary<string, object> { { "enabled", next } }, ApplyAutostart);
        };
        menu.Items.Add(autostartItem);
        menu.Items.Add("Star 支持", null, delegate { SendInternal("links.open", new Dictionary<string, object> { { "target", "github" } }, null); });
        menu.Items.Add("退出", null, delegate { Quit(); });
        menu.Opening += delegate { SendInternal("autostart.get", null, ApplyAutostart); };
        tray.ContextMenuStrip = menu;
        tray.MouseClick += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowPanel(); };
        StartWorker();
        balanceTimer.Interval = 10 * 60 * 1000;
        balanceTimer.Tick += delegate { RefreshBalance(); };
        balanceTimer.Start();
        // Low balance / low Codex quota notices; the service remembers what it already said.
        alertTimer.Interval = 60 * 1000;
        alertTimer.Tick += delegate { alertTimer.Interval = 5 * 60 * 1000; CheckAlerts(); };
        alertTimer.Start();
        tray.BalloonTipClicked += delegate {
            if (balloonAction == "recharge") SendInternal("links.open", new Dictionary<string, object> { { "target", "recharge" } }, null);
            else if (balloonAction == "open") ShowPanel();
            balloonAction = null;
        };
        if (!background) ShowPanel();
    }

    private void ApplyAutostart(Dictionary<string, object> result) {
        if (result == null) return;
        object supported, enabled;
        autostartItem.Enabled = result.TryGetValue("supported", out supported) && supported is bool && (bool)supported;
        autostartItem.Checked = result.TryGetValue("enabled", out enabled) && enabled is bool && (bool)enabled;
    }

    private void RefreshBalance() {
        SendInternal("balance.get", null, delegate (Dictionary<string, object> result) {
            string text = "RLY/0 Hub";
            object balance, unit;
            if (result != null && result.TryGetValue("balance", out balance) && balance != null && !(balance is string)) {
                double value = Convert.ToDouble(balance);
                string symbol = result.TryGetValue("unit", out unit) && Convert.ToString(unit) == "CNY" ? "¥" : "$";
                text = "RLY/0 Hub · 零号余额 " + symbol + value.ToString("0.00");
            }
            tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        });
    }

    private void CheckAlerts() {
        SendInternal("alerts.check", null, delegate (Dictionary<string, object> result) {
            object list;
            if (result == null || !result.TryGetValue("alerts", out list) || !(list is System.Collections.ArrayList)) return;
            var titles = new List<string>(); var bodies = new List<string>(); string first = null;
            foreach (object item in (System.Collections.ArrayList)list) {
                var alert = item as Dictionary<string, object>;
                if (alert == null) continue;
                object title, body, action;
                alert.TryGetValue("title", out title); alert.TryGetValue("body", out body); alert.TryGetValue("action", out action);
                if (first == null) first = Convert.ToString(action);
                titles.Add(Convert.ToString(title)); bodies.Add(Convert.ToString(title) + "：" + Convert.ToString(body));
            }
            if (titles.Count == 0) return;
            // Every notice is shown now: the service already remembered them as said.
            balloonAction = first;
            if (titles.Count == 1) tray.ShowBalloonTip(8000, titles[0], bodies[0].Substring(titles[0].Length + 1), ToolTipIcon.None);
            else tray.ShowBalloonTip(8000, "RLY/0 Hub 提醒", string.Join(Environment.NewLine, bodies), ToolTipIcon.None);
        });
    }

    private void StartWorker() {
        string node = Path.Combine(root, "runtime", "node.exe");
        string service = Path.Combine(root, "app", "hub-service.mjs");
        var start = new ProcessStartInfo(node) {
            Arguments = Program.Quote(service),
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        // The service must not inherit provider keys, Node hooks or another app's IPC bindings.
        var names = new List<string>();
        foreach (string key in start.EnvironmentVariables.Keys) names.Add(key);
        foreach (string name in names) {
            string upper = name.ToUpperInvariant();
            if (upper.StartsWith("OPENAI") || upper.StartsWith("ANTHROPIC") || upper.StartsWith("CODEXHOST_") ||
                upper.StartsWith("ELECTRON_") || upper.StartsWith("RLY0_") || upper.EndsWith("_API_KEY") ||
                upper == "NODE_OPTIONS" || upper == "NODE_PATH") start.EnvironmentVariables.Remove(name);
        }
        job = new ChildJob();
        worker = new Process { StartInfo = start, EnableRaisingEvents = true };
        worker.OutputDataReceived += OnData;
        worker.ErrorDataReceived += delegate { };
        worker.Exited += delegate { SafeDispatch(OnWorkerExited); };
        if (!worker.Start()) throw new InvalidOperationException("SERVICE_START_FAILED");
        try { job.Assign(worker.Handle); } catch { worker.Kill(); throw; }
        worker.BeginOutputReadLine();
        worker.BeginErrorReadLine();
    }

    private void OnWorkerExited() {
        ready = false;
        if (exiting) return;
        job.Dispose();
        if (restarts++ < 3) { StartWorker(); return; }
        tray.Text = "RLY/0 Hub · 后台服务已停止";
    }

    private void SafeDispatch(Action action) {
        if (!dispatch.IsDisposed) try { dispatch.BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    private void OnData(object sender, DataReceivedEventArgs e) {
        if (e.Data == null || e.Data.Length > (1 << 20)) return;
        string line = e.Data;
        SafeDispatch(delegate {
            if (exiting) return;
            Dictionary<string, object> value;
            try { value = Program.Json.Deserialize<Dictionary<string, object>>(line); } catch { return; }
            if (value == null) return;
            object eventName, id;
            if (value.TryGetValue("event", out eventName) && Convert.ToString(eventName) == "ready") {
                ready = true;
                RefreshBalance();
                if (panel != null) panel.Post("{\"event\":\"ready\"}");
                return;
            }
            if (!value.TryGetValue("id", out id)) return;
            string key = Convert.ToString(id);
            Action<Dictionary<string, object>> reply;
            if (internalReplies.TryGetValue(key, out reply)) {
                internalReplies.Remove(key);
                object result;
                if (reply != null) reply(value.TryGetValue("result", out result) ? result as Dictionary<string, object> : null);
                return;
            }
            if (PageId.IsMatch(key) && panel != null) panel.Post(line);
        });
    }

    private void Send(Dictionary<string, object> request) {
        if (!ready || exiting) return;
        try {
            worker.StandardInput.WriteLine(Program.Json.Serialize(request));
            worker.StandardInput.Flush();
        } catch { ready = false; }
    }

    private void SendInternal(string method, Dictionary<string, object> parameters, Action<Dictionary<string, object>> reply) {
        string id = "t" + (++internalSequence);
        internalReplies[id] = reply;
        Send(new Dictionary<string, object> { { "id", id }, { "method", method }, { "params", parameters ?? new Dictionary<string, object>() } });
    }

    // Page requests are re-serialized from a checked shape; nothing else reaches the service.
    internal void FromPage(string json) {
        if (json.Length > 65536) return;
        Dictionary<string, object> value;
        try { value = Program.Json.Deserialize<Dictionary<string, object>>(json); } catch { return; }
        if (value == null) return;
        object id, method, parameters;
        if (!value.TryGetValue("id", out id) || !value.TryGetValue("method", out method)) return;
        string key = Convert.ToString(id), name = Convert.ToString(method);
        if (!PageId.IsMatch(key) || !Method.IsMatch(name)) return;
        if (!value.TryGetValue("params", out parameters) || !(parameters is Dictionary<string, object>)) parameters = new Dictionary<string, object>();
        if (!ready) {
            if (panel != null) panel.Post(Program.Json.Serialize(new { id = key, error = new { code = -32001, message = "SERVICE_STARTING" } }));
            return;
        }
        Send(new Dictionary<string, object> { { "id", key }, { "method", name }, { "params", parameters } });
    }

    internal bool Ready { get { return ready; } }

    internal void ShowPanel() {
        if (exiting) return;
        if (panel != null && !panel.IsDisposed) {
            panel.Show();
            if (panel.WindowState == FormWindowState.Minimized) panel.WindowState = FormWindowState.Normal;
            panel.Activate();
            return;
        }
        panel = new PanelWindow(webviewData, Path.Combine(root, "app", "hub-ui"), icon, this);
        panel.FormClosed += delegate {
            panel = null;
            if (!exiting && !toldAboutTray) {
                toldAboutTray = true;
                tray.ShowBalloonTip(3000, "RLY/0 Hub", "已收进托盘，后台继续运行。", ToolTipIcon.None);
            }
        };
        panel.Show();
    }

    internal void Quit() {
        if (exiting) return;
        exiting = true;
        balanceTimer.Stop();
        alertTimer.Stop();
        if (panel != null) { panel.Close(); panel = null; }
        tray.Visible = false;
        try { worker.StandardInput.Close(); if (!worker.WaitForExit(5000)) job.Dispose(); } catch { }
        job.Dispose();
        control.Dispose(); tray.Dispose(); balanceTimer.Dispose(); alertTimer.Dispose(); dispatch.Dispose();
        ExitThread();
    }
}

internal sealed class PanelWindow : Form {
    private readonly WebView2 browser = new WebView2();
    private readonly string webviewData, www;
    private readonly HubContext owner;
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    internal PanelWindow(string webviewData, string www, Icon icon, HubContext owner) {
        this.webviewData = webviewData; this.www = www; this.owner = owner;
        Text = "RLY/0 Hub";
        Icon = icon;
        float scale;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = Math.Max(1f, g.DpiX / 96f);
        var work = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min((int)(1240 * scale), work.Width * 9 / 10), Math.Min((int)(820 * scale), work.Height * 9 / 10));
        MinimumSize = new Size(Math.Min((int)(760 * scale), work.Width * 9 / 10), Math.Min((int)(560 * scale), work.Height * 9 / 10));
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 13, 11);
        browser.DefaultBackgroundColor = Color.FromArgb(13, 13, 11);
        browser.Dock = DockStyle.Fill;
        Controls.Add(browser);
        Load += Initialize;
        FormClosed += delegate { browser.Dispose(); };
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        // Dark title bar (Windows 10 2004+) and the brand ink caption (Windows 11); ignored elsewhere.
        int on = 1, ink = 0x000B0D0D;
        DwmSetWindowAttribute(Handle, 20, ref on, 4);
        DwmSetWindowAttribute(Handle, 35, ref ink, 4);
    }

    internal void Post(string json) {
        if (IsDisposed || browser.CoreWebView2 == null) return;
        try { browser.CoreWebView2.PostWebMessageAsJson(json); } catch { }
    }

    private async void Initialize(object sender, EventArgs args) {
        try {
            var environment = await CoreWebView2Environment.CreateAsync(null, webviewData);
            if (IsDisposed) return;
            await browser.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            var core = browser.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.SetVirtualHostNameToFolderMapping(Program.PageHost, www, CoreWebView2HostResourceAccessKind.DenyCors);
            core.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            core.PermissionRequested += delegate (object s, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
            core.DownloadStarting += delegate (object s, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; };
            core.NavigationStarting += delegate (object s, CoreWebView2NavigationStartingEventArgs e) {
                if (!e.Uri.StartsWith(Program.PageUrl, StringComparison.Ordinal)) e.Cancel = true;
            };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate (object s, CoreWebView2WebResourceRequestedEventArgs e) {
                Uri uri;
                bool allowed = Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out uri) && uri.Scheme == "https" &&
                    uri.Host == Program.PageHost && e.Request.Method == "GET";
                if (!allowed) e.Response = environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Local resources only", "");
            };
            core.WebMessageReceived += delegate (object s, CoreWebView2WebMessageReceivedEventArgs e) {
                if (!e.Source.StartsWith(Program.PageUrl, StringComparison.Ordinal)) return;
                owner.FromPage(e.WebMessageAsJson);
            };
            core.NavigationCompleted += delegate (object s, CoreWebView2NavigationCompletedEventArgs e) {
                if (e.IsSuccess && owner.Ready) Post("{\"event\":\"ready\"}");
            };
            core.Navigate(Program.PageUrl);
        } catch {
            MessageBox.Show("界面组件 WebView2 不可用。请安装 Microsoft Edge WebView2 运行时后再打开。", "RLY/0 Hub", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
        }
    }
}

// The job owns only the service process we started, so it never outlives the Hub.
internal sealed class ChildJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct Basic { public long p1, p2; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct Counters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] private struct Extended { public Basic basic; public Counters counters; public UIntPtr a, b, c, d; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;
    internal ChildJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        var info = new Extended();
        // KILL_ON_JOB_CLOSE for the service itself; SILENT_BREAKAWAY_OK so what it starts (Codex,
        // installers, sign-in terminals, the browser) is not killed with the Hub. rly0-core still
        // stops with the service: it exits when its stdin closes.
        info.basic.flags = 0x2000 | 0x1000;
        if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(info))) throw new InvalidOperationException("JOB_CREATE_FAILED");
    }
    internal void Assign(IntPtr process) { if (!AssignProcessToJobObject(handle, process)) throw new InvalidOperationException("JOB_ASSIGN_FAILED"); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
