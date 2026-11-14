# Glimt keyboard hook: lets the Win key alone and/or Win+S open Glimt's search instead of Windows Start.
# Low-level keyboard hook (WH_KEYBOARD_LL). When we take over a Win press, the Win key-up is swallowed and
# re-sent after a "mask" key (vk 0xE8, unassigned), so Explorer sees a Win combo and does not open Start.
# Glimt is then signalled with the hotkey Ctrl+Alt+Shift+F20 (registered by Electron as a global shortcut),
# which also gives Glimt the right to take keyboard focus.
param([int]$WinAlone = 1, [int]$WinS = 1)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class GlimtKeys {
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr hMod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  const int WH_KEYBOARD_LL = 13;
  const uint WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104, WM_APP_FIRE = 0x8001, WM_QUIT = 0x12;
  const uint LLKHF_INJECTED = 0x10, KEYUP = 2, EXTENDED = 1;
  const byte VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_S = 0x53, VK_MASK = 0xE8;

  static readonly UIntPtr TAG = new UIntPtr(0x474C4D54u); // marks Glimt's own injected keys
  static HookProc proc;
  static IntPtr hook;
  static uint tid;
  public static bool WinAlone = true, WinS = true;
  static bool winDown, combo, ours, sSwallowed;

  static void Out(string s) { try { Console.Out.WriteLine(s); Console.Out.Flush(); } catch { } }

  public static void Run() {
    tid = GetCurrentThreadId();
    proc = Hook;
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) { Out("{\"type\":\"error\",\"message\":\"hook failed " + Marshal.GetLastWin32Error() + "\"}"); return; }
    // Exit when Glimt goes away (stdin closes)
    var t = new Thread(() => {
      try { var r = new StreamReader(Console.OpenStandardInput()); while (r.ReadLine() != null) { } } catch { }
      PostThreadMessage(tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    });
    t.IsBackground = true; t.Start();
    Out("{\"type\":\"ready\"}");
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == WM_APP_FIRE) Fire();
    }
    UnhookWindowsHookEx(hook);
  }

  // Ctrl+Alt+Shift+F20 -> Glimt's global shortcut
  static void Fire() {
    keybd_event(0x11, 0, 0, TAG);
    keybd_event(0x12, 0, 0, TAG);
    keybd_event(0x10, 0, 0, TAG);
    keybd_event(0x83, 0, 0, TAG);
    keybd_event(0x83, 0, KEYUP, TAG);
    keybd_event(0x10, 0, KEYUP, TAG);
    keybd_event(0x12, 0, KEYUP, TAG);
    keybd_event(0x11, 0, KEYUP, TAG);
  }

  static IntPtr Hook(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      KBD k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
      if (k.extra != (IntPtr)0x474C4D54) {
        uint msg = (uint)w.ToInt64();
        bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        bool isWin = k.vk == VK_LWIN || k.vk == VK_RWIN;
        if (isWin) {
          if (down) {
            if (!winDown) { winDown = true; combo = false; ours = false; sSwallowed = false; }
          } else if (winDown) {
            winDown = false;
            if (ours || (!combo && WinAlone)) {
              // Swallow this Win-up and replay it after the mask key, so Start does not open
              keybd_event(VK_MASK, 0, 0, TAG);
              keybd_event(VK_MASK, 0, KEYUP, TAG);
              keybd_event((byte)k.vk, 0, KEYUP | EXTENDED, TAG);
              PostThreadMessage(tid, WM_APP_FIRE, IntPtr.Zero, IntPtr.Zero);
              return (IntPtr)1;
            }
          }
        } else if (winDown) {
          if (k.vk == VK_S && WinS && (sSwallowed || (down && !combo))) {
            if (down) { ours = true; sSwallowed = true; } else sSwallowed = false;
            return (IntPtr)1;
          }
          if (down) combo = true;
        }
      }
    }
    return CallNextHookEx(hook, n, w, l);
  }
}
'@

[GlimtKeys]::WinAlone = [bool]$WinAlone
[GlimtKeys]::WinS = [bool]$WinS
[GlimtKeys]::Run()
