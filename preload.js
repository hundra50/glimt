const { contextBridge, ipcRenderer } = require('electron');

const on = channel => cb => {
  const fn = (e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('glimt', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: patch => ipcRenderer.invoke('set-settings', patch),
  resetLook: () => ipcRenderer.invoke('reset-look'),
  getState: () => ipcRenderer.invoke('get-state'),
  pickApp: () => ipcRenderer.invoke('pick-app'),
  appIcon: p => ipcRenderer.invoke('app-icon', p),

  setIgnore: ignore => ipcRenderer.send('set-ignore', ignore),
  focusDock: () => ipcRenderer.send('dock-focus'),
  setRegion: rects => ipcRenderer.send('dock-region', rects),
  media: cmd => ipcRenderer.send('media-cmd', cmd),
  openSettings: tab => ipcRenderer.send('open-settings', tab),
  dockMenu: () => ipcRenderer.send('dock-menu'),
  launch: p => ipcRenderer.send('launch', p),
  openSourceApp: id => ipcRenderer.send('open-source-app', id),
  quit: () => ipcRenderer.send('quit'),

  winClick: hwnd => ipcRenderer.send('win-click', hwnd),
  winFocus: hwnd => ipcRenderer.send('win-focus', hwnd),
  shellKeys: name => ipcRenderer.send('shell-keys', name),
  appTarget: p => ipcRenderer.invoke('app-target', p),
  appMenu: info => ipcRenderer.send('app-menu', info),
  openTaskbarSettings: () => ipcRenderer.send('open-taskbar-settings'),
  getApps: () => ipcRenderer.invoke('get-apps'),
  searchFiles: (q, id) => ipcRenderer.send('search-files', { q, id }),
  openItem: it => ipcRenderer.send('open-item', it),
  setBluetooth: on => ipcRenderer.send('bluetooth', on),
  mixer: cmd => ipcRenderer.send('mixer-cmd', cmd),
  ccAction: name => ipcRenderer.send('cc-action', name),
  epic: cmd => ipcRenderer.invoke('epic', cmd),
  onEpicChanged: on('epic-changed'),
  onMixer: on('mixer'),
  getWeather: () => ipcRenderer.invoke('get-weather'),
  setWeatherCity: city => ipcRenderer.invoke('set-weather-city', city),
  onAppsIndex: on('apps-index'),
  onSearchResults: on('search-results'),
  onOpenSearch: on('open-search'),
  openSpot: () => ipcRenderer.send('spot-open'),
  hideSpot: restore => ipcRenderer.send('spot-hide', restore),
  spotSize: h => ipcRenderer.send('spot-size', h),
  onSpotHidden: on('spot-hidden'),
  onBluetooth: on('bluetooth'),
  onWeather: on('weather'),
  onWindows: on('windows'),
  onTaskbar: on('taskbar'),

  onSettings: on('settings'),
  onMedia: on('media'),
  onStats: on('stats'),
  onSys: on('sys'),
  onGoto: on('goto')
});
