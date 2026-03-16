import { contextBridge, ipcRenderer } from 'electron';

interface AppConfig {
  template: string;
  imageDir: string;
  refreshInterval?: number;
  isRefreshEnabled?: boolean;
}

contextBridge.exposeInMainWorld('electronAPI', {
  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  updateConfig: (config: AppConfig) => ipcRenderer.send('update-config', config),
  getTemplates: () => ipcRenderer.invoke('get-templates'),
  saveTemplates: (templates: any) => ipcRenderer.invoke('save-templates', templates),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getPreview: (data: any) => ipcRenderer.invoke('get-preview', data),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  saveCredentials: (creds: any) => ipcRenderer.send('save-credentials', creds),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getImageFiles: () => ipcRenderer.invoke('get-image-files'),
  onError: (callback: (message: string) => void) => ipcRenderer.on('bot-error', (event, message) => callback(message)),
});
