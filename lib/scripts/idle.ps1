# dsh-brain · 探测：空闲多久 + 前台窗口
# 输出一行 JSON：{ idleMs, pid, process, title }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WhaleProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static int IdleMs() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref l);
    return (int)(Environment.TickCount - l.dwTime);
  }
  public static uint FgPid() {
    uint pid = 0;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }
  public static string FgTitle() {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(GetForegroundWindow(), sb, 512);
    return sb.ToString();
  }
}
'@

$idle = [WhaleProbe]::IdleMs()
$fgpid = [WhaleProbe]::FgPid()
$title = [WhaleProbe]::FgTitle()
$proc = ''
try { $proc = (Get-Process -Id $fgpid -ErrorAction Stop).ProcessName } catch { }

@{ idleMs = $idle; pid = $fgpid; process = $proc; title = $title } | ConvertTo-Json -Compress
