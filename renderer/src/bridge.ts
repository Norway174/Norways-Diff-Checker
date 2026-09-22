import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeText, writeImage } from '@tauri-apps/plugin-clipboard-manager';
import { Image } from '@tauri-apps/api/image';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppApi, Input, Mode } from './types';

const current = getCurrentWebviewWindow();
const call = <T>(action: string, payload: unknown = null): Promise<T> => invoke<T>('native_call', { action, payload });
const pendingDrags = new Map<string, Promise<unknown>>();
const afterDragStarted = async <T>(token: string, action: string, payload: unknown = token): Promise<T> => {
  const pending = pendingDrags.get(token);
  if (pending) await pending;
  pendingDrags.delete(token);
  return call<T>(action, payload);
};
const subscribe = <T>(name: string, callback: (payload: T) => void): (() => void) => {
  let disposed = false;
  let stop: (() => void) | undefined;
  void listen<T>(name, event => callback(event.payload)).then(unlisten => {
    if (disposed) unlisten(); else stop = unlisten;
  });
  return () => { disposed = true; stop?.(); };
};
const inputPaths = async (type: Mode): Promise<Input[]> => {
  const selection = await open({ multiple: true, directory: type === 'folders' });
  const paths = !selection ? [] : Array.isArray(selection) ? selection : [selection];
  return call<Input[]>('describe', paths);
};
const saveExport = async (kind: string, request: Record<string, unknown>, extension: string): Promise<string | null> => {
  const destination = await save({ defaultPath: String(request.title || 'comparison') + '.' + extension });
  if (!destination) return null;
  return invoke<string>('export_async', { payload: { kind, request, destination } });
};

const api: AppApi = {
  minimizeWindow: () => current.minimize(),
  toggleMaximizeWindow: async () => { await current.toggleMaximize(); return current.isMaximized(); },
  isWindowMaximized: () => current.isMaximized(),
  closeWindow: () => current.close(),
  takeWindowBootstrap: () => call('bootstrap'),
  reportActiveTab: activeTab => { void call('active_tab', activeTab); },
  beginTabDrag: (token, tab, tabCount) => { pendingDrags.set(token, call('begin_drag', { token, tab, tabCount })); return token; },
  endTabDrag: token => afterDragStarted(token, 'end_drag'),
  acceptTabDrag: token => afterDragStarted(token, 'accept_drag'),
  detachTab: (token, position) => afterDragStarted(token, 'detach_tab', { token, position }),
  onRemoveTransferredTab: callback => subscribe<{id: string; closeWindow: boolean}>('remove-transferred-tab', value => callback(value.id, value.closeWindow)),
  onTabDragState: callback => subscribe('tab-drag-state', callback),
  onWindowMaximizedChange: callback => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void current.onResized(async () => { if (!disposed) callback(await current.isMaximized()); })
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  },
  onPrimaryWindowChange: callback => subscribe('primary-window', callback),
  takeDroppedPaths: () => { const result = droppedPaths; droppedPaths = []; return result; },
  describeInputs: paths => call('describe', paths),
  takeStartupOpenRequests: () => call('startup_requests'),
  onOpenPaths: callback => subscribe<{paths: string[]; mode: 'reuse' | 'new'}>('open-paths', value => callback(value.paths, value.mode)),
  browseInputs: inputPaths,
  readText: input => call('read_text', input),
  preview: input => call('preview', input),
  startCompare: request => invoke<string>('start_compare', { request }),
  cancelCompare: id => call('cancel_compare', id),
  releaseCompareAssets: id => call('release_assets', id),
  onCompareEvent: callback => subscribe('compare-event', callback),
  getSettings: () => call('settings_get'),
  setSettings: patch => call('settings_set', patch),
  getShellContextMenuInstalled: () => call('shell_menu_status'),
  setShellContextMenuInstalled: enabled => call('shell_menu_set', enabled),
  getLibreOfficeStatus: () => call('libreoffice_status'),
  installLibreOffice: () => invoke('install_libreoffice_async'),
  deleteLibreOffice: () => invoke('delete_libreoffice_async'),
  onLibreOfficeProgress: callback => subscribe('libreoffice-progress', callback),
  getOptionalDependencyStatus: kind => call('optional_dependency_status', kind),
  installOptionalDependency: kind => invoke('install_optional_async', { kind }),
  deleteOptionalDependency: kind => invoke('delete_optional_async', { kind }),
  onOptionalDependencyProgress: callback => subscribe('optional-dependency-progress', callback),
  getAppDataPath: () => call('app_data_path'),
  openAppDataFolder: () => call('open_app_data'),
  openExternalUrl: async url => { if (!url.startsWith('https://')) throw new Error('Only secure web links can be opened.'); await openUrl(url); },
  openMaintenanceTool: () => call('open_maintenance'),
  checkForUpdates: () => invoke('check_update_async'),
  startUpdate: expectedVersion => invoke('start_update_async', { expectedVersion }),
  cancelUpdateDownload: () => invoke('cancel_update_download'),
  onUpdateDownloadProgress: callback => subscribe('update-download-progress', callback),
  scheduleUpdateOnClose: expectedVersion => invoke('schedule_update_on_close_async', { expectedVersion }),
  cancelScheduledUpdate: () => invoke('cancel_scheduled_update'),
  writeClipboardText: writeText,
  exportImageView: async request => {
    if (request.toClipboard) {
      const encoded = await invoke<string>('export_async', { payload: { kind: 'image', request } });
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      await writeImage(await Image.fromBytes(bytes));
      return 'clipboard';
    }
    return saveExport('image', request, 'png');
  },
  exportText: async request => {
    if (request.toClipboard) { await writeText(await invoke<string>('export_async', { payload: { kind: 'text', request } })); return 'clipboard'; }
    return saveExport('text', request, request.kind === 'unified' ? 'diff' : 'txt');
  },
  exportPdf: request => saveExport('pdf', request, 'pdf'),
  exportDocx: request => saveExport('docx', request, 'docx'),
  exportXlsx: request => saveExport('xlsx', request, 'xlsx'),
};

let droppedPaths: string[] = [];
void current.onDragDropEvent(event => {
  if (event.payload.type === 'drop') {
    droppedPaths = event.payload.paths;
    window.dispatchEvent(new CustomEvent('tauri-file-drop', { detail: droppedPaths }));
  }
});

window.api = api;
