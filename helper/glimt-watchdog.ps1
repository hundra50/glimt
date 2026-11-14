# Glimt watchdog: waits for Glimt to exit (normally or by crash) and then makes sure
# Windows' taskbar is visible again. Started by glimt-helper.ps1 when the taskbar is hidden.
param([int]$ParentPid)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GlimtRestore {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  public static void Show() {
    IntPtr h = FindWindow("Shell_TrayWnd", null); if (h != IntPtr.Zero) ShowWindow(h, 5);
    IntPtr s = IntPtr.Zero;
    while ((s = FindWindowEx(IntPtr.Zero, s, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) ShowWindow(s, 5);
  }
}
'@

try { Wait-Process -Id $ParentPid -ErrorAction Stop } catch {}
Start-Sleep -Milliseconds 500
[GlimtRestore]::Show()
