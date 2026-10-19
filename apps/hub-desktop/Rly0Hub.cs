// RLY/0 Hub standalone window: tray, single instance, close-to-tray, and a WebView2 page that talks
// to the bundled hub service (app/hub-service.mjs) over stdio. All product logic lives in the
// service; this shell only owns windows, the tray and the service process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
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

    // The service's stdin uses the system code page (GBK on Chinese Windows) while the service
    // reads UTF-8, so Chinese text would arrive garbled. Escaping every non-ASCII character as
    // a JSON \uXXXX escape keeps the line identical whatever the code page.
    internal static string AsciiJson(string json) {
        var builder = new StringBuilder(json.Length + 16);
        foreach (char c in json) {
            if (c < 128) builder.Append(c);
            else builder.Append("\\u").Append(((int)c).ToString("x4"));
        }
        return builder.ToString();
    }

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
        // Design check of the tray menu without starting the Hub (shown for a few seconds).
        if (args.Length >= 1 && args[0] == "--preview-menu") {
            var menu = HubMenu.Create();
            HubMenu.Add(menu, "", "打开 RLY/0 Hub", delegate { });
            HubMenu.Add(menu, "", "打开 Codex", delegate { });
            HubMenu.Add(menu, "", "充值零号中转", delegate { });
            menu.Items.Add(new ToolStripSeparator());
            var toggle = new ToolStripMenuItem("开机自启") { CheckOnClick = false, Tag = "toggle", Checked = true };
            HubMenu.SetGlyph(toggle, "");
            menu.Items.Add(toggle);
            toggle.Padding = new Padding(48, 11, 64, 11);
            HubMenu.Add(menu, "", "Star 支持", delegate { });
            menu.Items.Add(new ToolStripSeparator());
            HubMenu.Add(menu, "", "退出", delegate { });
            var host = new Form { ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1), StartPosition = FormStartPosition.Manual, Location = new Point(300, 200) };
            host.Shown += delegate { menu.Show(new Point(320, 220)); };
            var timer = new System.Windows.Forms.Timer { Interval = 4000 };
            timer.Tick += delegate { timer.Stop(); menu.Close(); host.Close(); };
            timer.Start();
            Application.Run(host);
            return 0;
        }
        // The launcher's "Codex is already running" question, in RLY/0's own style.
        // Exit codes: 10 restart Codex, 11 retry, 12 cancel.
        if (args.Length >= 1 && args[0] == "--ask-codex-restart") {
            bool english = args.Length >= 2 && args[1] == "en";
            string bin = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            return BrandDialog.AskCodexRestart(Path.Combine(bin, "rly0-hub.ico"), english);
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
    private string balloonAction, balloonAccount;
    private readonly string webviewData;
    private ChildJob job;
    private Process worker;
    private PanelWindow panel;
    private bool exiting, ready, toldAboutTray;
    private int restarts, internalSequence;
    private readonly Dictionary<string, Action<Dictionary<string, object>>> internalReplies = new Dictionary<string, Action<Dictionary<string, object>>>();

    internal HubContext(string root, bool background) {
        this.root = root;
        // Same per-user folder the Launcher and service use; never a path relative to the install.
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrEmpty(local) || !Path.IsPathRooted(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local) || !Path.IsPathRooted(local)) local = Path.GetTempPath();
        webviewData = Path.Combine(local, "rly0-hub", "hub-webview");
        Directory.CreateDirectory(webviewData);
        dispatch.CreateControl();
        icon = new Icon(Path.Combine(root, "bin", "rly0-hub.ico"));
        control = new ControlWindow(ShowPanel, Quit);
        tray = new NotifyIcon { Icon = icon, Text = "RLY/0 Hub", Visible = true };
        var menu = HubMenu.Create();
        HubMenu.Add(menu, "\uE80F", "打开 RLY/0 Hub", delegate { ShowPanel(); });
        HubMenu.Add(menu, "\uE756", "打开 Codex", delegate { SendInternal("codex.open", null, null); });
        HubMenu.Add(menu, "\uE8C7", "充值零号中转", delegate { SendInternal("links.open", new Dictionary<string, object> { { "target", "recharge" } }, null); });
        menu.Items.Add(new ToolStripSeparator());
        autostartItem = new ToolStripMenuItem("开机自启") { CheckOnClick = false, Tag = "toggle" };
        HubMenu.SetGlyph(autostartItem, "\uE7E8");
        autostartItem.Click += delegate {
            bool next = !autostartItem.Checked;
            SendInternal("autostart.set", new Dictionary<string, object> { { "enabled", next } }, ApplyAutostart);
        };
        menu.Items.Add(autostartItem);
        autostartItem.Padding = new Padding(48, 11, 64, 11);
        HubMenu.Add(menu, "\uE734", "Star 支持", delegate { SendInternal("links.open", new Dictionary<string, object> { { "target", "github" } }, null); });
        menu.Items.Add(new ToolStripSeparator());
        HubMenu.Add(menu, "\uE711", "退出", delegate { Quit(); });
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
            else if (balloonAction == "switch" && balloonAccount != null)
                SendInternal("accounts.switchAndRestart", new Dictionary<string, object> { { "id", balloonAccount } }, delegate (Dictionary<string, object> r) {
                    object switched, reloaded;
                    bool ok = r != null && r.TryGetValue("switched", out switched) && switched is bool && (bool)switched;
                    bool hot = ok && r.TryGetValue("reloaded", out reloaded) && reloaded is string;
                    tray.ShowBalloonTip(4000, "RLY/0 Hub", !ok ? "切换没有成功，请在 Hub 的账号页重试。" : hot ? "已切换账号，Codex 不用重启。" : "已切换账号，Codex 正在重启。", ToolTipIcon.None);
                });
            balloonAction = null;
            balloonAccount = null;
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
            var titles = new List<string>(); var bodies = new List<string>(); string first = null, account = null;
            foreach (object item in (System.Collections.ArrayList)list) {
                var alert = item as Dictionary<string, object>;
                if (alert == null) continue;
                object title, body, action, accountId;
                alert.TryGetValue("title", out title); alert.TryGetValue("body", out body); alert.TryGetValue("action", out action);
                alert.TryGetValue("accountId", out accountId);
                if (first == null) { first = Convert.ToString(action); account = accountId as string; }
                titles.Add(Convert.ToString(title)); bodies.Add(Convert.ToString(title) + "：" + Convert.ToString(body));
            }
            if (titles.Count == 0) return;
            // Every notice is shown now: the service already remembered them as said.
            balloonAction = first;
            balloonAccount = account != null && System.Text.RegularExpressions.Regex.IsMatch(account, "^[0-9a-f]{12}$") ? account : null;
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
            worker.StandardInput.WriteLine(Program.AsciiJson(Program.Json.Serialize(request)));
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

/// <summary>
/// A small borderless dialog in RLY/0's style (dark surface, rounded corners, 阿零, one light
/// primary button) for the launcher's questions, instead of the system's TaskDialog.
/// </summary>
internal static class BrandDialog {
    private static readonly Color Back = Color.FromArgb(30, 30, 26);
    private static readonly Color Edge = Color.FromArgb(62, 62, 54);
    private static readonly Color Ink = Color.FromArgb(245, 245, 240);
    private static readonly Color Muted = Color.FromArgb(160, 160, 152);
    private static readonly Color Paper = Color.FromArgb(233, 233, 227);
    private static readonly Color Well = Color.FromArgb(46, 46, 40);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);

    internal static int AskCodexRestart(string iconPath, bool english) {
        int result = 12;
        string title = english ? "Codex is already running" : "Codex 已在运行";
        string body = english
            ? "This Codex was not started by RLY/0 Hub. To use RLY/0 Hub, Codex needs a restart. Your conversations are kept."
            : "当前 Codex 不是由 RLY/0 Hub 启动的。要使用 RLY/0 Hub，需要重新启动一次 Codex，对话记录不会丢。";
        using (var form = new Form()) {
            float k;
            using (var probe = form.CreateGraphics()) k = probe.DpiX / 96f;
            Func<int, int> px = v => (int)Math.Round(v * k);
            form.FormBorderStyle = FormBorderStyle.None;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.BackColor = Back;
            form.ClientSize = new Size(px(600), px(234));
            form.ShowInTaskbar = true;
            form.TopMost = true;
            form.Text = "RLY/0 Hub";
            form.KeyPreview = true;
            form.Font = new Font("Microsoft YaHei UI", 10f);
            try { form.Icon = new Icon(iconPath); } catch { }
            form.Paint += delegate (object sender, PaintEventArgs e) {
                using (var pen = new Pen(Edge)) e.Graphics.DrawRectangle(pen, 0, 0, form.ClientSize.Width - 1, form.ClientSize.Height - 1);
            };
            form.HandleCreated += delegate {
                try { int round = 2; DwmSetWindowAttribute(form.Handle, 33, ref round, sizeof(int)); } catch { }
            };
            MouseEventHandler drag = delegate (object sender, MouseEventArgs e) {
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(form.Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // move the window
            };
            form.MouseDown += drag;

            var picture = new PictureBox { Location = new Point(px(28), px(30)), Size = new Size(px(60), px(60)), SizeMode = PictureBoxSizeMode.Zoom, BackColor = Back };
            picture.Image = LargestIconFrame(iconPath);
            picture.MouseDown += drag;
            var heading = new Label { Text = title, ForeColor = Ink, BackColor = Back, Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold), AutoSize = true, Location = new Point(px(108), px(28)) };
            heading.MouseDown += drag;
            var text = new Label { Text = body, ForeColor = Muted, BackColor = Back, Font = new Font("Microsoft YaHei UI", 10f), Location = new Point(px(110), px(70)), Size = new Size(px(460), px(72)) };
            text.MouseDown += drag;
            var close = Button(english ? "×" : "×", false, new Rectangle(px(556), px(12), px(32), px(32)));
            close.Click += delegate { result = 12; form.Close(); };
            var retry = Button(english ? "I've quit Codex, try again" : "我已退出，重试", false, new Rectangle(px(110), px(156), px(180), px(46)));
            retry.Click += delegate { result = 11; form.Close(); };
            var restart = Button(english ? "Restart Codex for me (recommended)" : "自动退出并重新启动（推荐）", true, new Rectangle(px(302), px(156), px(270), px(46)));
            restart.Click += delegate { result = 10; form.Close(); };
            form.Controls.AddRange(new Control[] { picture, heading, text, close, retry, restart });
            form.KeyDown += delegate (object sender, KeyEventArgs e) {
                if (e.KeyCode == Keys.Escape) { result = 12; form.Close(); }
                else if (e.KeyCode == Keys.Enter) { result = 10; form.Close(); }
            };
            form.Shown += delegate { form.Activate(); restart.Focus(); };
            Application.Run(form);
        }
        return result;
    }

    /// <summary>The icon's largest frame; PNG frames are decoded directly (Icon cannot).</summary>
    private static Image LargestIconFrame(string iconPath) {
        try {
            byte[] bytes = File.ReadAllBytes(iconPath);
            int count = BitConverter.ToUInt16(bytes, 4), best = -1, bestSize = 0;
            for (int i = 0; i < count; i++) {
                int entry = 6 + i * 16;
                int size = bytes[entry] == 0 ? 256 : bytes[entry];
                if (size > bestSize) { bestSize = size; best = entry; }
            }
            if (best < 0) return null;
            int length = BitConverter.ToInt32(bytes, best + 8), offset = BitConverter.ToInt32(bytes, best + 12);
            var stream = new MemoryStream(bytes, offset, length);
            return Image.FromStream(stream);
        } catch {
            return null;
        }
    }

    private static Control Button(string label, bool primary, Rectangle bounds) {
        var button = new Label {
            Text = label,
            Bounds = bounds,
            TextAlign = ContentAlignment.MiddleCenter,
            Cursor = Cursors.Hand,
            Font = new Font("Microsoft YaHei UI", label == "×" ? 13f : 10f, FontStyle.Bold),
            ForeColor = primary ? Color.FromArgb(13, 13, 11) : Ink,
            BackColor = Back,
        };
        bool hover = false;
        button.MouseEnter += delegate { hover = true; button.Invalidate(); };
        button.MouseLeave += delegate { hover = false; button.Invalidate(); };
        button.Paint += delegate (object sender, PaintEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Back);
            Color fill = primary ? (hover ? Color.White : Paper) : (hover ? Color.FromArgb(58, 58, 51) : (label == "×" ? Back : Well));
            var r = new Rectangle(0, 0, button.Width - 1, button.Height - 1);
            using (var path = Rounded(r, 10)) using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
            TextRenderer.DrawText(g, button.Text, button.Font, r, button.ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        };
        return button;
    }

    private static System.Drawing.Drawing2D.GraphicsPath Rounded(Rectangle r, int radius) {
        int d = radius * 2;
        var path = new System.Drawing.Drawing2D.GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

/// <summary>
/// The tray menu drawn in the Hub's own dark style: rounded corners (Windows 11), roomy items, a
/// soft highlight and a quiet separator, instead of the system's light menu.
/// </summary>
internal static class HubMenu {
    private static readonly Color Back = Color.FromArgb(30, 30, 26);
    private static readonly Color Edge = Color.FromArgb(58, 58, 51);
    private static readonly Color Hover = Color.FromArgb(46, 46, 40);
    private static readonly Color Ink = Color.FromArgb(245, 245, 240);
    private static readonly Color Muted = Color.FromArgb(152, 152, 145);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    internal static ContextMenuStrip Create() {
        var menu = new ContextMenuStrip {
            Renderer = new Painter(),
            ShowImageMargin = false,
            ShowCheckMargin = false,
            BackColor = Back,
            ForeColor = Ink,
            Padding = new Padding(6, 6, 6, 6),
            Font = new Font("Microsoft YaHei UI", 10f),
        };
        // Room for the icon tile, the text and the autostart switch (scaled for the screen's DPI).
        float k;
        using (var probe = Graphics.FromHwnd(IntPtr.Zero)) k = probe.DpiX / 96f;
        menu.MinimumSize = new Size((int)(236 * k), 0);
        menu.ItemAdded += delegate (object s, ToolStripItemEventArgs e) {
            e.Item.ForeColor = Ink;
            if (!(e.Item is ToolStripSeparator)) {
                e.Item.Padding = new Padding(10, 7, 22, 7);
                e.Item.AutoSize = true;
            }
        };
        menu.Opened += delegate {
            try {
                int round = 2; // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND
                DwmSetWindowAttribute(menu.Handle, 33, ref round, sizeof(int));
            } catch { }
        };
        return menu;
    }

    private static readonly Dictionary<ToolStripItem, string> Glyphs = new Dictionary<ToolStripItem, string>();
    private static readonly string IconFont = PickIconFont();

    private static string PickIconFont() {
        using (var fonts = new System.Drawing.Text.InstalledFontCollection())
            foreach (var family in fonts.Families)
                if (family.Name == "Segoe Fluent Icons") return family.Name;
        return "Segoe MDL2 Assets";
    }

    /// <summary>A menu entry with an icon tile (a Segoe Fluent/MDL2 glyph) left of its text.</summary>
    internal static ToolStripMenuItem Add(ContextMenuStrip menu, string glyph, string text, EventHandler click) {
        var item = new ToolStripMenuItem(text);
        item.Click += click;
        SetGlyph(item, glyph);
        menu.Items.Add(item);
        item.Padding = new Padding(48, 11, 26, 11);
        return item;
    }

    internal static void SetGlyph(ToolStripItem item, string glyph) { Glyphs[item] = glyph; }

    private sealed class Painter : ToolStripRenderer {
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
            e.Graphics.Clear(Back);
        }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
            using (var pen = new Pen(Edge)) {
                var r = e.AffectedBounds; r.Width -= 1; r.Height -= 1;
                e.Graphics.DrawRectangle(pen, r);
            }
        }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            if (e.Item.Selected && e.Item.Enabled) {
                var r = new Rectangle(2, 1, e.Item.Width - 4, e.Item.Height - 2);
                using (var path = Rounded(r, 7)) using (var brush = new SolidBrush(Hover)) g.FillPath(brush, path);
            }
            var item = e.Item as ToolStripMenuItem;
            if (item != null && "toggle".Equals(item.Tag)) {
                // A small switch at the right edge shows on/off (drawn here: text drawing is clipped).
                // Against the menu's visible width: an item may report more than is shown.
                int right = Math.Min(e.Item.Width, e.ToolStrip.ClientSize.Width - e.Item.Bounds.Left) - 12;
                var track = new Rectangle(right - 34, (e.Item.Height - 18) / 2, 34, 18);
                using (var path = Rounded(track, 9))
                using (var brush = new SolidBrush(item.Checked ? Color.FromArgb(91, 208, 138) : Color.FromArgb(70, 70, 62)))
                    g.FillPath(brush, path);
                int knob = item.Checked ? track.Right - 16 : track.Left + 2;
                using (var brush = new SolidBrush(Ink)) g.FillEllipse(brush, knob, track.Top + 2, 14, 14);
            }
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
            string glyph;
            if (Glyphs.TryGetValue(e.Item, out glyph)) {
                var g = e.Graphics;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                const int size = 28;
                var tile = new Rectangle(10, (e.Item.Height - size) / 2, size, size);
                using (var path = Rounded(tile, 7))
                using (var brush = new SolidBrush(e.Item.Selected ? Color.FromArgb(70, 70, 62) : Color.FromArgb(48, 48, 42)))
                    g.FillPath(brush, path);
                using (var font = new Font(IconFont, 11f))
                    TextRenderer.DrawText(g, glyph, font, tile, Ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
            }
            bool header = "header".Equals(e.Item.Tag);
            var item = e.Item as ToolStripMenuItem;
            bool check = item != null && item.Checked;
            bool toggle = item != null && "toggle".Equals(item.Tag);
            // The text sits right of the icon tile (the system's text box ignores our padding).
            int left = Glyphs.ContainsKey(e.Item) ? 50 : 14;
            var r = new Rectangle(left, 0, Math.Max(10, e.Item.Width - left - (toggle ? 56 : 14)), e.Item.Height);
            if (header) {
                using (var bold = new Font(e.TextFont, FontStyle.Bold))
                    TextRenderer.DrawText(e.Graphics, e.Text, bold, r, Muted, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
                return;
            }
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, r, e.Item.Enabled ? Ink : Muted, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
        }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
            using (var pen = new Pen(Edge)) {
                int y = e.Item.Height / 2;
                e.Graphics.DrawLine(pen, 8, y, e.Item.Width - 8, y);
            }
        }
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) { }
        protected override void OnRenderLabelBackground(ToolStripItemRenderEventArgs e) { }

        private static System.Drawing.Drawing2D.GraphicsPath Rounded(Rectangle r, int radius) {
            int d = radius * 2;
            var path = new System.Drawing.Drawing2D.GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
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
        // Open on the screen under the pointer, unless that one is too narrow (a portrait side
        // monitor): then the primary screen, so the window never starts squeezed.
        var screen = Screen.FromPoint(Cursor.Position);
        if (screen.WorkingArea.Width < (int)(1100 * scale)) screen = Screen.PrimaryScreen;
        var work = screen.WorkingArea;
        MinimumSize = new Size(Math.Min((int)(760 * scale), work.Width * 9 / 10), Math.Min((int)(560 * scale), work.Height * 9 / 10));
        StartPosition = FormStartPosition.Manual;
        // Every start: the default size at the design proportions (1240 x 820), as large as fits in
        // 80% x 86% of the screen, centred, at the default interface size. Nothing is restored
        // from the last run, so a window dragged half off-screen or squeezed never comes back.
        const double ratio = 1240.0 / 820.0;
        int width = (int)Math.Min(work.Width * 0.80, work.Height * 0.86 * ratio);
        width = Math.Max(width, Math.Min((int)(1240 * scale), work.Width * 92 / 100));
        int height = (int)(width / ratio);
        if (height > work.Height * 92 / 100) { height = work.Height * 92 / 100; width = (int)(height * ratio); }
        var size = new Size(width, height);
        zoom = DefaultZoom;
        Bounds = new Rectangle(work.Left + (work.Width - size.Width) / 2, work.Top + (work.Height - size.Height) / 2, size.Width, size.Height);
        BackColor = Color.FromArgb(13, 13, 11);
        browser.DefaultBackgroundColor = Color.FromArgb(13, 13, 11);
        browser.Dock = DockStyle.Fill;
        Controls.Add(browser);
        Load += Initialize;
        FormClosed += delegate { browser.Dispose(); };
    }

    /// <summary>The interface size every start opens at: 110% ("大").</summary>
    internal const double DefaultZoom = 1.1;
    private double zoom = DefaultZoom;
    internal static readonly double[] ZoomSteps = { 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6 };

    private static double ClampZoom(double value) {
        return Math.Max(0.8, Math.Min(1.6, Math.Round(value, 2)));
    }

    private bool HandleWindowMessage(string json) {
        Dictionary<string, object> message;
        try { message = Program.Json.Deserialize<Dictionary<string, object>>(json); } catch { return false; }
        if (message == null || !message.ContainsKey("method") || !message.ContainsKey("id")) return false;
        string method = message["method"] as string, id = message["id"] as string;
        if (id == null || (method != "window.zoomGet" && method != "window.zoomSet" && method != "window.capture")) return false;
        if (method == "window.capture") {
            CaptureScreen(id);
            return true;
        }
        if (method == "window.zoomSet") {
            var parameters = message.ContainsKey("params") ? message["params"] as Dictionary<string, object> : null;
            double next;
            try { next = parameters != null && parameters.ContainsKey("zoom") ? Convert.ToDouble(parameters["zoom"]) : zoom; } catch { next = zoom; }
            // For this run only; the next start opens at the default size again.
            zoom = ClampZoom(next);
            browser.ZoomFactor = zoom;
        }
        Post(Program.Json.Serialize(new { id = id, result = new { zoom = zoom, steps = ZoomSteps } }));
        return true;
    }

    // "反馈问题": the page as shown right now, saved as diagnostics\feedback-yyyyMMdd-HHmmss\screen.png
    // under the same data folder the service uses (CODEXHOST_DATA_DIR, else %USERPROFILE%\.rly0-hub).
    // Only the folder name goes back; the service writes the rest of the report next to it.
    private async void CaptureScreen(string id) {
        try {
            string data = Environment.GetEnvironmentVariable("CODEXHOST_DATA_DIR");
            if (string.IsNullOrEmpty(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".rly0-hub");
            string folder = "feedback-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            string directory = Path.Combine(Path.GetFullPath(data), "diagnostics", folder);
            Directory.CreateDirectory(directory);
            using (var file = new FileStream(Path.Combine(directory, "screen.png"), FileMode.Create, FileAccess.Write)) {
                await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
            }
            Post(Program.Json.Serialize(new { id = id, result = new { folder = folder } }));
        } catch {
            Post(Program.Json.Serialize(new { id = id, error = new { code = -32000, message = "CAPTURE_FAILED" } }));
        }
    }

    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
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
            // A fixed interface scale: no Ctrl + wheel / Ctrl +/- / pinch zoom drifting it.
            // "界面大小" in Settings is the only way to change it.
            core.Settings.IsZoomControlEnabled = false;
            try { core.Settings.IsPinchZoomEnabled = false; } catch { }
            browser.ZoomFactor = zoom;
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
                if (HandleWindowMessage(e.WebMessageAsJson)) return;
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
