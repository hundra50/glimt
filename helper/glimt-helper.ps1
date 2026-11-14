# Glimt helper: reads Windows media sessions (Spotify, browsers, etc.), system volume,
# network throughput and top processes. Writes one JSON object per line to stdout and
# accepts JSON commands on stdin. Exits when stdin closes (the Electron app quit).
param([switch]$Once)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# ---------- WinRT plumbing ----------
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $t.Wait(4000)
  if ($t.IsCompleted) { return $t.Result } else { return $null }
}

$mediaOk = $true
try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
  $contentTypeProp = [Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType')
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  $mediaOk = $false
  Emit @{ type = 'error'; scope = 'media'; message = $_.Exception.Message }
}

# ---------- Core Audio (master volume) ----------
$volumeOk = $true
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class GlimtAudio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
    return epv;
  }
  public static float GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void SetVolume(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
'@
} catch {
  $volumeOk = $false
  Emit @{ type = 'error'; scope = 'volume'; message = $_.Exception.Message }
}

# ---------- Bluetooth radio ----------
$btRadio = $null
try {
  $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  $null = [Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime]
  $null = [Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType = WindowsRuntime]
  $null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  $btRadio = $radios | Where-Object { "$($_.Kind)" -eq 'Bluetooth' } | Select-Object -First 1
} catch { Emit @{ type = 'error'; scope = 'bluetooth'; message = $_.Exception.Message } }

$wifiRadio = $null
try { if ($radios) { $wifiRadio = $radios | Where-Object { "$($_.Kind)" -eq 'WiFi' } | Select-Object -First 1 } } catch {}

function Set-Wifi([bool]$on) {
  if (-not $wifiRadio) { return }
  $state = if ($on) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
  $null = Await ($wifiRadio.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
}

# ---------- Volume mixer, microphone, output devices (control center) ----------
$mixerOk = $true
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace GlimtMix {
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public short vt; short r1, r2, r3; public IntPtr p; IntPtr p2; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetAt(int i, out PROPERTYKEY k); [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore ps); [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetState(out int st);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { [PreserveSig] int GetCount(out int c); [PreserveSig] int Item(int i, out IMMDevice d); }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection c); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume { [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i(); [PreserveSig] int j(); [PreserveSig] int k(); [PreserveSig] int l(); [PreserveSig] int m(); [PreserveSig] int n(); [PreserveSig] int o(); [PreserveSig] int p(); [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 { [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int c); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 { [PreserveSig] int GetState(out int st); [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n); [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int e(); [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetProcessId(out int pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  // ComImport so the session object can be QueryInterface'd to it (each method keeps its HRESULT)
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float v, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float v);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
  }
  [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig { [PreserveSig] int a(); [PreserveSig] int b(); [PreserveSig] int c(); [PreserveSig] int d(); [PreserveSig] int e(); [PreserveSig] int f(); [PreserveSig] int g(); [PreserveSig] int h(); [PreserveSig] int i(); [PreserveSig] int j(); [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  }
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyConfigClient { }

  public class Output { public string id; public string name; public bool isDefault; }
  public class App { public string key; public string name; public string path; public float volume; public bool mute; public bool active; }

  public static class Mixer {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);

    // Created by CLSID: the volume class above already maps this CLSID to its own managed type
    static IMMDeviceEnumerator En() { return (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"))); }
    static Guid Empty = Guid.Empty;

    static string Name(IMMDevice d) {
      IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0) return "?";
      var k = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PROPVARIANT v; if (ps.GetValue(ref k, out v) != 0) return "?";
      string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "?";
      PropVariantClear(ref v);
      return s;
    }

    // Core Audio session objects only answer QueryInterface on an MTA thread (PowerShell runs STA)
    static T Mta<T>(Func<T> fn) { T r = default(T); Exception err = null; var t = new System.Threading.Thread(() => { try { r = fn(); } catch (Exception e) { err = e; } }); t.SetApartmentState(System.Threading.ApartmentState.MTA); t.Start(); t.Join(); if (err != null) throw err; return r; }
    public static List<Output> Outputs() { return Mta(() => OutputsImpl()); }
    static List<Output> OutputsImpl() {
      var list = new List<Output>();
      var en = En();
      string def = null;
      IMMDevice dd; if (en.GetDefaultAudioEndpoint(0, 0, out dd) == 0) dd.GetId(out def);
      IMMDeviceCollection col; if (en.EnumAudioEndpoints(0, 1, out col) != 0) return list;
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice d; if (col.Item(i, out d) != 0) continue;
        string id; d.GetId(out id);
        list.Add(new Output { id = id, name = Name(d), isDefault = id == def });
      }
      return list;
    }

    public static void SetOutput(string id) { Mta(() => { SetOutputImpl(id); return 0; }); }
    static void SetOutputImpl(string id) {
      var pc = (IPolicyConfig)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")));
      for (int role = 0; role < 3; role++) pc.SetDefaultEndpoint(id, role);
    }

    static IAudioEndpointVolume Endpoint(int flow) {
      IMMDevice d; if (En().GetDefaultAudioEndpoint(flow, 0, out d) != 0) return null;
      var iid = typeof(IAudioEndpointVolume).GUID; object o;
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
      return (IAudioEndpointVolume)o;
    }
    // null = no microphone
    public static object MicMuted() { return Mta(() => { var v = Endpoint(1); if (v == null) return (object)null; bool m; v.GetMute(out m); return (object)m; }); }
    public static void SetMicMute(bool m) { Mta(() => { var v = Endpoint(1); if (v != null) v.SetMute(m, ref Empty); return 0; }); }

    static string ProcPath(int pid) {
      IntPtr h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return null;
      try { var sb = new StringBuilder(1024); int sz = sb.Capacity; return QueryFullProcessImageName(h, 0, sb, ref sz) ? sb.ToString() : null; }
      finally { CloseHandle(h); }
    }

    // All live sessions of the default output, grouped per program (exe path); key "system" = Windows sounds
    static List<KeyValuePair<string, ISimpleAudioVolume>> Sessions(Dictionary<string, App> apps) {
      var res = new List<KeyValuePair<string, ISimpleAudioVolume>>();
      // Every active output device: apps like Discord may play on a different device than the default
      IMMDeviceCollection col; if (En().EnumAudioEndpoints(0, 1, out col) != 0) return res;
      int nd; col.GetCount(out nd);
      for (int di = 0; di < nd; di++) {
      IMMDevice d; if (col.Item(di, out d) != 0) continue;
      var iid = typeof(IAudioSessionManager2).GUID; object o;
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      IAudioSessionEnumerator se; if (((IAudioSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
      int n; se.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 c; if (se.GetSession(i, out c) != 0) continue;
        int st; c.GetState(out st); if (st == 2) continue;
        var vol = c as ISimpleAudioVolume; if (vol == null) continue;
        string key, name, path = null;
        if (c.IsSystemSoundsSession() == 0) { key = "system"; name = "Systemljud"; }
        else {
          int pid; c.GetProcessId(out pid);
          if (pid == 0) continue;
          path = ProcPath(pid);
          if (path == null) continue;
          key = path.ToLowerInvariant();
          name = null;
          if (apps != null && !apps.ContainsKey(key)) {
            try { name = FileVersionInfo.GetVersionInfo(path).FileDescription; } catch { }
            if (string.IsNullOrWhiteSpace(name)) name = System.IO.Path.GetFileNameWithoutExtension(path);
          }
        }
        res.Add(new KeyValuePair<string, ISimpleAudioVolume>(key, vol));
        if (apps != null) {
          float v; vol.GetMasterVolume(out v); bool m; vol.GetMute(out m);
          App a;
          if (!apps.TryGetValue(key, out a)) { a = new App { key = key, name = name, path = path, volume = v, mute = m }; apps[key] = a; }
          if (st == 1) { a.active = true; a.volume = v; a.mute = m; }
        }
      }
      }
      return res;
    }

    public static List<App> Apps() { return Mta(() => AppsImpl()); }
    static List<App> AppsImpl() {
      var apps = new Dictionary<string, App>();
      Sessions(apps);
      var list = new List<App>(apps.Values);
      list.Sort((x, y) => x.key == "system" ? 1 : y.key == "system" ? -1 : string.Compare(x.name, y.name, StringComparison.CurrentCultureIgnoreCase));
      return list;
    }
    public static void SetAppVolume(string key, float v) { Mta(() => { foreach (var s in Sessions(null)) if (s.Key == key) s.Value.SetMasterVolume(v, ref Empty); return 0; }); }
    public static void SetAppMute(string key, bool m) { Mta(() => { foreach (var s in Sessions(null)) if (s.Key == key) s.Value.SetMute(m, ref Empty); return 0; }); }
  }
}
'@
} catch {
  $mixerOk = $false
  Emit @{ type = 'error'; scope = 'mixer'; message = $_.Exception.Message }
}

function Read-Mixer {
  $o = @{ type = 'mixer'; ok = $mixerOk }
  if ($mixerOk) {
    try { $o.outputs = @([GlimtMix.Mixer]::Outputs() | ForEach-Object { @{ id = $_.id; name = $_.name; isDefault = $_.isDefault } }) } catch { $o.outputs = @(); Emit @{ type = 'error'; scope = 'mixer-outputs'; message = "$($_.Exception.InnerException) $($_.Exception.Message)" } }
    try { $o.apps = @([GlimtMix.Mixer]::Apps() | ForEach-Object { @{ key = $_.key; name = $_.name; path = $_.path; volume = $_.volume; mute = $_.mute; active = $_.active } }) } catch { $o.apps = @() }
    try { $o.mic = [GlimtMix.Mixer]::MicMuted() } catch { $o.mic = $null }
  }
  $o.wifi = $(if ($wifiRadio) { "$($wifiRadio.State)" } else { $null })
  $o.bluetooth = $(if ($btRadio) { "$($btRadio.State)" } else { $null })
  # Connection type for the network tile (Ethernet on a desktop)
  $net = $null
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up') { continue }
    $t = "$($n.NetworkInterfaceType)"
    if ($t -eq 'Wireless80211') { $net = 'wifi'; break }
    if ($t -eq 'Ethernet' -and $n.Description -notmatch 'Virtual|Hyper-V|VMware|VirtualBox|TAP|Loopback|Bluetooth' -and $n.GetIPProperties().GatewayAddresses.Count -gt 0) { $net = 'ethernet' }
  }
  $o.net = $net
  return $o
}

function Set-Bluetooth([bool]$on) {
  if (-not $btRadio) { return }
  $state = if ($on) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
  $null = Await ($btRadio.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
}

# ---------- File search through the Windows Search index ----------
$searchConn = $null
function Search-Files([string]$q) {
  if (-not $script:searchConn) {
    $script:searchConn = New-Object -ComObject ADODB.Connection
    $script:searchConn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  }
  $safe = $q.Replace("'", "''").Replace('%', '').Replace('[', '')
  $sql = "SELECT TOP 8 System.ItemUrl, System.ItemNameDisplay, System.ItemType FROM SYSTEMINDEX " +
         "WHERE System.ItemNameDisplay LIKE '%$safe%' AND SCOPE='file:' " +
         "AND System.ItemUrl NOT LIKE '%/node_modules/%' AND System.ItemUrl NOT LIKE '%/AppData/%' " +
         "AND System.ItemUrl NOT LIKE '%/.git/%' AND System.ItemUrl NOT LIKE '%/$Recycle.Bin/%' " +
         "ORDER BY System.DateModified DESC"
  $rs = $script:searchConn.Execute($sql)
  $out = @()
  while (-not $rs.EOF) {
    $url = "$($rs.Fields.Item('System.ItemUrl').Value)"
    if ($url -like 'file:*') {
      $path = [Uri]::UnescapeDataString($url.Substring(5)).Replace('/', '\')
      $out += @{ name = "$($rs.Fields.Item('System.ItemNameDisplay').Value)"; path = $path; folder = ("$($rs.Fields.Item('System.ItemType').Value)" -eq 'Directory') }
    }
    $rs.MoveNext()
  }
  $rs.Close()
  return $out
}

# ---------- Fullscreen detection (games, video) ----------
$fsOk = $true
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GlimtWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static bool IsFullscreen() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return false;
    var sb = new StringBuilder(256); GetClassName(h, sb, 256);
    string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
  }
}
'@
} catch { $fsOk = $false }
$lastFs = $null

# ---------- Shell: open windows, taskbar hide/show, app bar, shortcut keys ----------
$shellOk = $true
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GlimtShell {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);

  public class Win { public long hwnd; public string title; public string exe; public bool min; }

  public static long Exclude;      // the dock window itself
  public static long LastActive;   // last real app window that had focus
  static Dictionary<uint, string> exeCache = new Dictionary<uint, string>();

  static string ExeOf(uint pid) {
    string e;
    if (exeCache.TryGetValue(pid, out e)) return e;
    e = "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) {
      var sb = new StringBuilder(1024); int n = sb.Capacity;
      if (QueryFullProcessImageName(h, 0, sb, ref n)) e = sb.ToString();
      CloseHandle(h);
    }
    if (exeCache.Count > 500) exeCache.Clear();
    exeCache[pid] = e;
    return e;
  }

  static bool IsCandidate(IntPtr h) {
    if (h == IntPtr.Zero || h.ToInt64() == Exclude || !IsWindowVisible(h)) return false;
    if (GetWindow(h, 4) != IntPtr.Zero) return false; // has owner
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return false; // tool window
    int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    string c = cls.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return false;
    var t = new StringBuilder(2); if (GetWindowText(h, t, 2) == 0) return false;
    return true;
  }

  public static List<Win> List() {
    var list = new List<Win>();
    EnumWindows((h, l) => {
      if (!IsCandidate(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new Win { hwnd = h.ToInt64(), title = t.ToString(), exe = ExeOf(pid), min = IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static void Track() {
    IntPtr f = GetForegroundWindow();
    if (f == IntPtr.Zero || f.ToInt64() == Exclude) return;  // clicking the dock keeps the previous app
    LastActive = IsCandidate(f) ? f.ToInt64() : 0;
  }

  static void AltTap() { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); }

  // Taskbar-style click: focus the window, or minimise it if it already has focus.
  public static void Click(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return;
    if (LastActive == hwnd && !IsIconic(h)) { ShowWindow(h, 6); LastActive = 0; return; }
    if (IsIconic(h)) ShowWindow(h, 9);
    AltTap();
    SetForegroundWindow(h);
    LastActive = hwnd;
  }
  public static void Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    AltTap(); SetForegroundWindow(h); LastActive = hwnd;
  }
  public static void Close(long hwnd) { PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
  // Windows 11 rounded corners for a frameless window (DWMWA_WINDOW_CORNER_PREFERENCE = ROUND)
  public static void Round(long hwnd) { int v = 2; DwmSetWindowAttribute(new IntPtr(hwnd), 33, ref v, 4); }
  [StructLayout(LayoutKind.Sequential)] struct ACCENT { public int State, Flags, Color, Anim; }
  [StructLayout(LayoutKind.Sequential)] struct WCAD { public int Attr; public IntPtr Data; public int Size; }
  [DllImport("user32.dll")] static extern int SetWindowCompositionAttribute(IntPtr h, ref WCAD d);
  // Blur whatever is behind the window, focused or not (same technique as translucent-taskbar tools).
  // color is 0xAABBGGRR tint; state 4 = acrylic blur behind.
  public static void Glass(long hwnd, int color) { Round(hwnd); Accent(hwnd, 4, color); }
  // state: 0 = none, 3 = blur behind (light), 4 = acrylic (strong)
  public static void Accent(long hwnd, int state, int color) {
    ACCENT a = new ACCENT(); a.State = state; a.Flags = 2; a.Color = color;
    int sz = Marshal.SizeOf(a); IntPtr p = Marshal.AllocHGlobal(sz);
    try { Marshal.StructureToPtr(a, p, false); WCAD d = new WCAD(); d.Attr = 19; d.Data = p; d.Size = sz; SetWindowCompositionAttribute(new IntPtr(hwnd), ref d); }
    finally { Marshal.FreeHGlobal(p); }
  }

  public static void Keys(int[] vks) {
    foreach (var k in vks) keybd_event((byte)k, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event((byte)vks[i], 0, 2, UIntPtr.Zero);
  }

  static List<IntPtr> Taskbars() {
    var l = new List<IntPtr>();
    IntPtr p = FindWindow("Shell_TrayWnd", null); if (p != IntPtr.Zero) l.Add(p);
    IntPtr s = IntPtr.Zero;
    while ((s = FindWindowEx(IntPtr.Zero, s, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) l.Add(s);
    return l;
  }
  public static void SetTaskbar(bool show) { foreach (var h in Taskbars()) ShowWindow(h, show ? 5 : 0); }
  public static bool TaskbarVisible() { foreach (var h in Taskbars()) if (IsWindowVisible(h)) return true; return false; }
  public static bool TaskbarAutoHide() {
    var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d);
    return ((ulong)SHAppBarMessage(4, ref d) & 1) != 0;
  }

  // Reserve a strip of the screen so maximised windows stop above (or below) the dock.
  static bool registered;
  static long barHwnd;
  public static void Reserve(long hwnd, uint edge, int l, int t, int r, int b) {
    var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = new IntPtr(hwnd); d.uEdge = edge;
    if (!registered || barHwnd != hwnd) { Release(); SHAppBarMessage(0, ref d); registered = true; barHwnd = hwnd; }
    int h = b - t;
    d.rc.L = l; d.rc.R = r; d.rc.T = t; d.rc.B = b;
    SHAppBarMessage(2, ref d);
    if (edge == 3) d.rc.T = d.rc.B - h; else d.rc.B = d.rc.T + h;
    SHAppBarMessage(3, ref d);
  }
  public static void Release() {
    if (!registered) return;
    var d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(d); d.hWnd = new IntPtr(barHwnd);
    SHAppBarMessage(1, ref d);
    registered = false;
  }
}
'@
  [void][GlimtShell]::SetProcessDPIAware()
} catch {
  $shellOk = $false
  Emit @{ type = 'error'; scope = 'shell'; message = $_.Exception.Message }
}
$hideTaskbar = $false
$parentPid = $null
$watchdogStarted = $false
$lastWinJson = ''
$lastShell = [DateTime]::MinValue
$lastTaskbarCheck = [DateTime]::MinValue

function Restore-Taskbar {
  if (-not $shellOk) { return }
  try { [GlimtShell]::Release() } catch {}
  try { [GlimtShell]::SetTaskbar($true) } catch {}
}

# ---------- Media ----------
$preferredSource = $null
$lastTrackKey = $null
$lastArt = $null

function Get-Session {
  if (-not $mediaOk) { return $null }
  $sessions = @($manager.GetSessions())
  if ($preferredSource) {
    $s = $sessions | Where-Object { $_.SourceAppUserModelId -eq $preferredSource } | Select-Object -First 1
    if ($s) { return $s }
  }
  $cur = $manager.GetCurrentSession()
  if ($cur) { return $cur }
  return $sessions | Select-Object -First 1
}

function Read-Media {
  if (-not $mediaOk) { return @{ type = 'media'; available = $false } }
  $sessions = @($manager.GetSessions())
  $s = Get-Session
  $sources = @($sessions | ForEach-Object { $_.SourceAppUserModelId })
  if (-not $s) { return @{ type = 'media'; available = $true; active = $false; sources = $sources } }

  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $pi = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $title = ''; $artist = ''; $album = ''
  if ($props) { $title = $props.Title; $artist = $props.Artist; $album = $props.AlbumTitle }

  $key = "$($s.SourceAppUserModelId)|$title|$artist|$album"
  $art = $null
  if ($key -ne $script:lastTrackKey) {
    $script:lastTrackKey = $key
    $script:lastArt = $null
    if ($props -and $props.Thumbnail) {
      try {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($stream) {
          # PowerShell can't see the projected interfaces on this COM object, so go through reflection
          $net = $asStreamForRead.Invoke($null, @($stream))
          $ms = New-Object System.IO.MemoryStream
          $net.CopyTo($ms)
          $ct = $null; try { $ct = $contentTypeProp.GetValue($stream) } catch {}
          if (-not $ct) { $ct = 'image/png' }
          $script:lastArt = "data:$ct;base64," + [Convert]::ToBase64String($ms.ToArray())
          $net.Dispose(); $ms.Dispose()
        }
      } catch { $script:lastArt = $null }
    }
    $art = $script:lastArt
  }

  $c = $pi.Controls
  $repeat = $null; if ($pi.AutoRepeatMode -ne $null) { $repeat = $pi.AutoRepeatMode.ToString() }
  $shuffle = $null; if ($pi.IsShuffleActive -ne $null) { $shuffle = [bool]$pi.IsShuffleActive }
  return @{
    type = 'media'; available = $true; active = $true
    source = $s.SourceAppUserModelId; sources = $sources
    title = $title; artist = $artist; album = $album
    trackKey = $key; art = $art
    status = $pi.PlaybackStatus.ToString()
    shuffle = $shuffle; repeat = $repeat
    canNext = $c.IsNextEnabled; canPrev = $c.IsPreviousEnabled; canSeek = $c.IsPlaybackPositionEnabled
    canShuffle = $c.IsShuffleEnabled; canRepeat = $c.IsRepeatEnabled
    position = $tl.Position.TotalSeconds; duration = ($tl.EndTime - $tl.StartTime).TotalSeconds
    updatedAt = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
  }
}

function Invoke-ShellCommand($cmd) {
  if (-not $shellOk) { return }
  switch ($cmd.cmd) {
    'init'     { [GlimtShell]::Exclude = [long]$cmd.dock; if ($cmd.pid) { $script:parentPid = [int]$cmd.pid } }
    'taskbar'  {
      $script:hideTaskbar = [bool]$cmd.hide
      if ($cmd.hide -and -not $script:watchdogStarted -and $script:parentPid) {
        # Processes started from here fall outside Electron's job object, so this one survives a crash
        $wd = Join-Path $PSScriptRoot 'glimt-watchdog.ps1'
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$wd`"", '-ParentPid', $script:parentPid)
        $script:watchdogStarted = $true
      }
      if ($cmd.hide) {
        [GlimtShell]::SetTaskbar($false)
        [GlimtShell]::Reserve([long]$cmd.hwnd, [uint32]$cmd.edge, [int]$cmd.l, [int]$cmd.t, [int]$cmd.r, [int]$cmd.b)
      } else { Restore-Taskbar }
    }
    'click'    { [GlimtShell]::Click([long]$cmd.hwnd) }
    'focus'    { [GlimtShell]::Focus([long]$cmd.hwnd) }
    'close'    { [GlimtShell]::Close([long]$cmd.hwnd) }
    'round'    { [GlimtShell]::Round([long]$cmd.hwnd) }
    'glass'    { [GlimtShell]::Glass([long]$cmd.hwnd, [int]$cmd.color) }
    'glassb'   { [GlimtShell]::Round([long]$cmd.hwnd); [GlimtShell]::Accent([long]$cmd.hwnd, [int]$cmd.state, [int]$cmd.color) }
    'keys'     { [GlimtShell]::Keys([int[]]@($cmd.keys)) }
  }
  $script:lastShell = [DateTime]::MinValue  # refresh the window list right away
}

# 0..1 as float. ConvertFrom-Json gives a Decimal, and [Math]::Min(1, <decimal>) picks the Int32
# overload, rounding every level to 0 or 1, so convert to double first.
function Get-Level($v) { $d = [double]$v; if ($d -lt 0) { $d = 0 } elseif ($d -gt 1) { $d = 1 }; return [float]$d }

function Invoke-MediaCommand($cmd) {
  if (@('init', 'taskbar', 'click', 'focus', 'close', 'round', 'glass', 'glassb', 'keys') -contains $cmd.cmd) { Invoke-ShellCommand $cmd; return $false }
  switch ($cmd.cmd) {
    'bluetooth' {
      Set-Bluetooth ([bool]$cmd.on)
      $st = $null; if ($btRadio) { $st = "$($btRadio.State)" }
      Emit @{ type = 'bluetooth'; state = $st }
      Emit (Read-Mixer)
      return $false
    }
    'mixer'    { Emit (Read-Mixer); return $false }
    'appvol'   { if ($mixerOk) { [GlimtMix.Mixer]::SetAppVolume([string]$cmd.key, (Get-Level $cmd.value)) }; return $false }
    'appmute'  { if ($mixerOk) { [GlimtMix.Mixer]::SetAppMute([string]$cmd.key, [bool]$cmd.on) }; Emit (Read-Mixer); return $false }
    'output'   { if ($mixerOk) { [GlimtMix.Mixer]::SetOutput([string]$cmd.id) }; Emit (Read-Mixer); return $false }
    'micmute'  { if ($mixerOk) { [GlimtMix.Mixer]::SetMicMute([bool]$cmd.on) }; Emit (Read-Mixer); return $false }
    'wifi'     { Set-Wifi ([bool]$cmd.on); Emit (Read-Mixer); return $false }
    'search' {
      $res = @(); try { $res = @(Search-Files ([string]$cmd.q)) } catch { $script:searchConn = $null }
      Emit @{ type = 'search'; id = $cmd.id; results = $res }
      return $false
    }
    'startapps' {
      $apps = @(Get-StartApps | ForEach-Object { @{ name = $_.Name; id = $_.AppID } })
      Emit @{ type = 'startapps'; list = $apps }
      return $false
    }
  }
  $s = Get-Session
  $boolT = [bool]
  switch ($cmd.cmd) {
    'source'  { $script:preferredSource = $cmd.id; $script:lastTrackKey = $null; return }
    'volume'  { if ($volumeOk) { [GlimtAudio]::SetVolume((Get-Level $cmd.value)) }; return }
    'mute'    { if ($volumeOk) { [GlimtAudio]::SetMute(-not [GlimtAudio]::GetMute()) }; return }
    'refreshArt' { $script:lastTrackKey = $null; return }
  }
  if (-not $s) { return }
  switch ($cmd.cmd) {
    'toggle'  { $null = Await ($s.TryTogglePlayPauseAsync()) $boolT }
    'play'    { $null = Await ($s.TryPlayAsync()) $boolT }
    'pause'   { $null = Await ($s.TryPauseAsync()) $boolT }
    'next'    { $null = Await ($s.TrySkipNextAsync()) $boolT }
    'prev'    { $null = Await ($s.TrySkipPreviousAsync()) $boolT }
    'seek'    { $null = Await ($s.TryChangePlaybackPositionAsync([long]([double]$cmd.value * 10000000))) $boolT }
    'shuffle' {
      $cur = $s.GetPlaybackInfo().IsShuffleActive
      $null = Await ($s.TryChangeShuffleActiveAsync(-not [bool]$cur)) $boolT
    }
    'repeat'  {
      $cur = $s.GetPlaybackInfo().AutoRepeatMode
      $next = switch ("$cur") { 'None' { 'List' } 'List' { 'Track' } default { 'None' } }
      $mode = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]::$next
      $null = Await ($s.TryChangeAutoRepeatModeAsync($mode)) $boolT
    }
  }
}

# ---------- System stats ----------
$lastNet = $null; $lastNetTime = $null
$lastProc = @{}; $lastProcTime = $null
$cores = [Environment]::ProcessorCount

function Read-Stats {
  $now = Get-Date
  $rx = 0L; $tx = 0L
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up' -or $n.NetworkInterfaceType -eq 'Loopback' -or $n.NetworkInterfaceType -eq 'Tunnel') { continue }
    try { $st = $n.GetIPStatistics(); $rx += $st.BytesReceived; $tx += $st.BytesSent } catch {}
  }
  $down = 0; $up = 0
  if ($script:lastNet) {
    $dt = ($now - $script:lastNetTime).TotalSeconds
    if ($dt -gt 0) { $down = [Math]::Max(0, ($rx - $script:lastNet[0]) / $dt); $up = [Math]::Max(0, ($tx - $script:lastNet[1]) / $dt) }
  }
  $script:lastNet = @($rx, $tx); $script:lastNetTime = $now

  # Top processes, grouped by name (Chrome, Spotify etc. run many processes)
  $groups = @{}
  foreach ($p in Get-Process) {
    $name = $p.ProcessName
    if ($name -eq 'Idle' -or $name -eq 'System') { continue }
    if (-not $groups.ContainsKey($name)) { $groups[$name] = @{ cpu = 0.0; mem = 0L } }
    try { $groups[$name].cpu += $p.TotalProcessorTime.TotalSeconds } catch {}
    $groups[$name].mem += $p.WorkingSet64
  }
  $procs = @()
  if ($script:lastProcTime) {
    $dt = ($now - $script:lastProcTime).TotalSeconds
    foreach ($k in $groups.Keys) {
      $prev = $script:lastProc[$k]
      $pct = 0
      if ($prev -ne $null -and $dt -gt 0) { $pct = [Math]::Max(0, ($groups[$k].cpu - $prev) / $dt / $cores * 100) }
      $procs += [pscustomobject]@{ name = $k; cpu = [Math]::Round($pct, 1); mem = $groups[$k].mem }
    }
  }
  $script:lastProc = @{}; foreach ($k in $groups.Keys) { $script:lastProc[$k] = $groups[$k].cpu }
  $script:lastProcTime = $now

  $vol = $null; $mute = $null
  if ($volumeOk) { try { $vol = [GlimtAudio]::GetVolume(); $mute = [GlimtAudio]::GetMute() } catch {} }

  return @{
    type = 'stats'; netDown = $down; netUp = $up; volume = $vol; mute = $mute
    bluetooth = $(if ($btRadio) { "$($btRadio.State)" } else { $null })
    topCpu = @($procs | Sort-Object cpu -Descending | Select-Object -First 5)
    topMem = @($procs | Sort-Object mem -Descending | Select-Object -First 5)
  }
}

# ---------- Main loop ----------
if ($Once) {
  $null = Read-Stats; Start-Sleep -Milliseconds 500
  Emit (Read-Media); Emit (Read-Stats)
  exit 0
}

Emit @{ type = 'ready'; media = $mediaOk; volume = $volumeOk }
# Console.In.ReadLineAsync blocks on .NET Framework; a StreamReader over the raw stream doesn't.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pending = $reader.ReadLineAsync()
$lastMedia = [DateTime]::MinValue
$lastStats = [DateTime]::MinValue
$lastMediaJson = ''

while ($true) {
  $forceMedia = $false
  while ($pending.IsCompleted) {
    $line = $null
    if (-not $pending.IsFaulted) { try { $line = $pending.Result } catch {} }
    if ($line -eq $null) { Restore-Taskbar; exit 0 }  # Glimt quit or crashed: always give the taskbar back
    try { $r = Invoke-MediaCommand ($line | ConvertFrom-Json); if ($r -ne $false) { $forceMedia = $true } }
    catch { Emit @{ type = 'error'; scope = 'command'; message = $_.Exception.Message } }
    $pending = $reader.ReadLineAsync()
  }

  $now = Get-Date
  if ($forceMedia -or ($now - $lastMedia).TotalMilliseconds -ge 1000) {
    if ($forceMedia) { Start-Sleep -Milliseconds 150 }
    try {
      $m = Read-Media
      $json = $m | ConvertTo-Json -Compress -Depth 4
      # Only send when something changed (position drift is extrapolated in the UI)
      if ($json -ne $lastMediaJson -or $forceMedia) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $lastMediaJson = $json }
    } catch { Emit @{ type = 'error'; scope = 'media'; message = $_.Exception.Message } }
    $lastMedia = $now
  }
  if ($fsOk) {
    $fs = $false; try { $fs = [GlimtWin]::IsFullscreen() } catch {}
    if ($fs -ne $lastFs) { Emit @{ type = 'fullscreen'; value = $fs }; $lastFs = $fs }
  }
  if ($shellOk) {
    try {
      [GlimtShell]::Track()
      if (($now - $lastShell).TotalMilliseconds -ge 500) {
        $wins = @([GlimtShell]::List())
        $json = @{ type = 'windows'; active = [GlimtShell]::LastActive; list = $wins } | ConvertTo-Json -Compress -Depth 4
        if ($json -ne $lastWinJson) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $lastWinJson = $json }
        $lastShell = $now
      }
      if (($now - $lastTaskbarCheck).TotalMilliseconds -ge 2000) {
        # Watchdog: if Glimt is gone, restore the taskbar and leave
        if ($parentPid) {
          $alive = $true
          try { $pp = [System.Diagnostics.Process]::GetProcessById($parentPid); if ($pp.HasExited) { $alive = $false } } catch { $alive = $false }
          if (-not $alive) { Restore-Taskbar; exit 0 }
        }
        # Explorer sometimes brings the taskbar back (e.g. after it restarts)
        if ($hideTaskbar -and [GlimtShell]::TaskbarVisible()) { [GlimtShell]::SetTaskbar($false) }
        Emit @{ type = 'taskbar'; autoHide = [GlimtShell]::TaskbarAutoHide(); hidden = $hideTaskbar }
        $lastTaskbarCheck = $now
      }
    } catch { Emit @{ type = 'error'; scope = 'shell'; message = $_.Exception.Message } }
  }
  if (($now - $lastStats).TotalMilliseconds -ge 2000) {
    try { Emit (Read-Stats) } catch { Emit @{ type = 'error'; scope = 'stats'; message = $_.Exception.Message } }
    $lastStats = $now
  }
  Start-Sleep -Milliseconds 120
}
