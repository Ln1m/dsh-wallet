# 桌面端内化补丁（dsh-desktop）

`dsh-wallet` 的「充值 / API Key / 明细」按钮通过 `window.open(url, '_blank')` 打开官方平台页。官方页面带 `CSP: frame-ancestors 'none'`（禁止 iframe 内嵌），所以要在 **dsh-desktop（WebView2 外壳）** 里拦截 `NewWindowRequested`，用无边框 16:9 子窗口 `ChildForm` 打开，实现「在 DSH 窗口内打开官方页」而不跳系统浏览器。

npm 包里不包含这段 C# 代码（它在 `apps/dsh-desktop`，属于桌面端外壳而非插件）。下面给出完整补丁，供桌面端用户自行合入。

## 一、改动点（`apps/dsh-desktop/src/App.cs`）

在 `Program` 类内新增：

1. 静态单例字段 + 打开子窗口方法
2. `ChildForm` 内部类（无边框 16:9、失焦延迟关闭、单例复用、注入 CSS 隐藏第三方导航）
3. 主窗口 `NewWindowRequested` 处理器
4. （可选）`PermissionRequested` 处理器，放行通知权限，配合插件的系统通知功能

## 二、补丁代码

### 1. 单例 + 打开子窗口（加到 `Program` 类内，`StartServer` 之后）

```csharp
/// <summary>Open a URL in a new in-app WebView2 window (keeps DeepSeek platform pages inside DSH).</summary>
private static ChildForm openChild;

private static void OpenChildWindow(string uri)
{
    if (string.IsNullOrEmpty(uri)) return;
    // 单例：已有打开的内嵌窗口则复用并聚焦，不重复开窗
    if (openChild != null && !openChild.IsDisposed)
    {
        openChild.NavigateTo(uri);
        openChild.Activate();
        return;
    }
    var form = new ChildForm(uri);
    form.FormClosed += (s, e) => { openChild = null; };
    openChild = form;
    form.Show();
}
```

### 2. ChildForm（无边框 16:9 内嵌窗口）

```csharp
private sealed class ChildForm : Form
{
    private readonly WebView2 web;
    private string targetUri;
    private bool ready;
    private bool reused;

    public ChildForm(string uri)
    {
        this.targetUri = uri;
        AutoScaleMode = AutoScaleMode.None;
        Size = new Size(1620, 911);   // 16:9
        MinimumSize = new Size(960, 540);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;   // 无边框，纯净页面
        ShowInTaskbar = false;

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);

        Shown += async (s, e) =>
        {
            ready = true;
            try
            {
                await web.EnsureCoreWebView2Async(null);
                // 在 document 创建时（React 渲染前）注入 CSS，隐藏导航与侧边栏，避免两栏→一栏闪烁
                await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
(function(){
  function inject(){
    try{
      var s = document.getElementById('dsh-hide-chrome');
      if(!s){
        s = document.createElement('style');
        s.id = 'dsh-hide-chrome';
        s.textContent = 'header,nav,aside,footer{display:none!important}[class*=Sidebar],[class*=sidebar],[class*=Sider],[class*=sider],[class*=Navbar],[class*=navbar],[class*=TopNav],[class*=topnav]{display:none!important}';
        (document.head || document.documentElement).appendChild(s);
      }
    }catch(e){}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
");
                web.CoreWebView2.NewWindowRequested += (sender2, args2) =>
                {
                    args2.Handled = true;
                    OpenChildWindow(args2.Uri);
                };
                // 放行浏览器通知权限（配合 dsh-wallet 的低余额 / 超上限系统通知）
                web.CoreWebView2.PermissionRequested += (sender2, args2) =>
                {
                    if (args2.PermissionKind == CoreWebView2PermissionKind.Notifications)
                        args2.State = CoreWebView2PermissionState.Allow;
                };
                web.CoreWebView2.Navigate(targetUri);
            }
            catch { }
        };
        // 点击外部（窗口失焦）延迟自动关闭，给复用切换留出时间
        Deactivate += (s, e) =>
        {
            if (!ready) return;
            reused = false;
            var closeTimer = new System.Windows.Forms.Timer { Interval = 250 };
            closeTimer.Tick += (s2, e2) =>
            {
                closeTimer.Stop();
                closeTimer.Dispose();
                if (!reused && !IsDisposed) Close();
            };
            closeTimer.Start();
        };
    }

    public void NavigateTo(string url)
    {
        reused = true;
        targetUri = url;
        try
        {
            if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(url);
        }
        catch { }
    }
}
```

### 3. 主窗口拦截 window.open / target=_blank

在 `MainForm.OnShown` 里、`EnsureCoreWebView2Async` 成功之后加：

```csharp
// 拦截 window.open / target=_blank：在 DSH 窗口内新开 WebView2 窗口打开，
// 而不是唤起系统浏览器，实现官方平台页面（充值/用量/API Key）的"内化"。
web.CoreWebView2.NewWindowRequested += (wvSender, wvArgs) =>
{
    wvArgs.Handled = true;
    OpenChildWindow(wvArgs.Uri);
};

// 放行浏览器通知权限（配合 dsh-wallet 的系统通知）
web.CoreWebView2.PermissionRequested += (wvSender, wvArgs) =>
{
    if (wvArgs.PermissionKind == CoreWebView2PermissionKind.Notifications)
        wvArgs.State = CoreWebView2PermissionState.Allow;
};
```

## 三、编译

用 .NET Framework 的 `csc.exe` 手动编译（`build.ps1` 在 pwsh7 下有 `$pk` 相对路径 bug，需用 `$pk.FullName`），流程：

1. 改完 `App.cs` → 用 `csc.exe` 重新编译 `dsh-desktop.exe`
2. 关掉正在运行的 `dsh-desktop` 进程
3. 用新 exe 替换旧 exe
4. 重启

完整编译参数见仓库 `apps/dsh-desktop/build.ps1`（注意 `$pk.FullName`）。

## 四、踩坑记录（已沉淀）

| 坑 | 解法 |
| --- | --- |
| 两栏→一栏闪烁（CSS 注入晚于 React 渲染） | `AddScriptToExecuteOnDocumentCreatedAsync` + `DOMContentLoaded`，在 React 渲染前注入 |
| 弹窗失焦关闭 vs 复用切换冲突 | `Deactivate` 延迟 250ms 关闭 + `reused` 标志（`NavigateTo` 复用则取消关闭） |
| 弹窗多开 | 静态单例 `openChild` + 复用 `NavigateTo` + `Activate` |
| `build.ps1` 编译 bug | pwsh7 下 `$pk` 展开成相对路径，手动 csc 用 `$pk.FullName` |
| C# `Timer` 歧义 | 写全 `System.Windows.Forms.Timer` |
| lambda 参数遮蔽 | `OnShown(object sender, ...)` 内 lambda 参数改名 `wvSender/wvArgs` |

> 注意：不内化也不影响插件核心功能——浏览器环境（非桌面端）下 `window.open` 会正常新开系统浏览器标签页。
