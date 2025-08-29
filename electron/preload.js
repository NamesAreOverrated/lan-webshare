const { contextBridge, ipcRenderer } = require('electron');
let storeInitError = null;
// Use IPC to main-process electron-store (avoid requiring in preload)
const offlineStore = {
    get: async (k) => await ipcRenderer.invoke('offline:get', k),
    set: async (k, v) => await ipcRenderer.invoke('offline:set', k, v),
    delete: async (k) => await ipcRenderer.invoke('offline:delete', k),
};

contextBridge.exposeInMainWorld('lanApp', {
    listServers: () => ipcRenderer.invoke('servers:list'),
    addServer: (name, host, port) => ipcRenderer.invoke('servers:add', { name, host, port }),
    removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
    startLocal: async () => {
        const r = await ipcRenderer.invoke('local:start');
        return !!r?.ok;
    },
    startLocalAndOpen: async () => {
        const r = await ipcRenderer.invoke('local:start-open');
        return !!r?.ok;
    },
    stopLocal: async () => {
        const r = await ipcRenderer.invoke('local:stop');
        return !!r?.ok;
    },
    checkServer: async (host, port) => {
        const r = await ipcRenderer.invoke('servers:check', { host, port });
        return !!r?.ok;
    },
    openServer: (host, port) => ipcRenderer.invoke('servers:open', { host, port }),
    openServerOffline: (host, port) => ipcRenderer.invoke('servers:open-offline', { host, port }),
    backToLauncher: () => ipcRenderer.invoke('app:back-to-launcher'),
});

contextBridge.exposeInMainWorld('lanOffline', {
    getData: async (host, port) => await offlineStore.get(`data:${host}:${port}`) || null,
    saveData: async (host, port, data) => { await offlineStore.set(`data:${host}:${port}`, data); },
    getQueue: async (host, port) => await offlineStore.get(`queue:${host}:${port}`) || [],
    pushOp: async (host, port, op) => {
        const key = `queue:${host}:${port}`;
        const q = (await offlineStore.get(key)) || [];
        q.push({ ...op, queuedAt: Date.now() });
        await offlineStore.set(key, q);
        return q.length;
    },
    clearQueue: async (host, port) => { await offlineStore.delete(`queue:${host}:${port}`); },
});

contextBridge.exposeInMainWorld('lanDiag', { preload: 'ok', storeError: storeInitError || null });
