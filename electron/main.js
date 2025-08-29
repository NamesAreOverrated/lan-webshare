const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const http = require('http');

// Lazy require server controller to avoid Node ESM pitfalls
const serverCtl = require('../server.js');

const store = new Store({
    name: 'settings',
    defaults: { servers: [] }
});
// Offline cache store
const offlineStore = new Store({ name: 'offline' });

let mainWindow;
let localServerRunning = false;

function isLocalHostEntry(entry) {
    return entry.pinned && entry.id === 'local' && entry.host === '127.0.0.1';
}

function getUserDataPaths() {
    const userData = app.getPath('userData');
    return {
        DB_PATH: path.join(userData, 'db.json'),
        UPLOADS_DIR: path.join(userData, 'uploads'),
    };
}

async function startLocalServer() {
    if (localServerRunning) return true;
    const { DB_PATH, UPLOADS_DIR } = getUserDataPaths();
    const port = 3000; // fixed for now
    try {
        const actualPort = await serverCtl.startServer(port, { DB_PATH, UPLOADS_DIR });
        localServerRunning = true;
        return !!actualPort;
    } catch (e) {
        console.error('Failed to start local server:', e);
        return false;
    }
}

async function stopLocalServer() {
    if (!localServerRunning) return true;
    try {
        await serverCtl.stopServer();
        localServerRunning = false;
        return true;
    } catch (e) {
        console.error('Failed to stop local server:', e);
        return false;
    }
}

function checkServerReachable(host, port, timeoutMs = 2000) {
    return new Promise(resolve => {
        const req = http.get({ host, port, path: '/', timeout: timeoutMs }, res => {
            res.resume();
            resolve(true);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 980,
        height: 640,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        }
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
}

app.whenReady().then(() => {
    createMainWindow();
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('window-all-closed', async () => {
    await stopLocalServer();
    if (process.platform !== 'darwin') app.quit();
});

// IPC
ipcMain.handle('servers:list', async () => {
    console.log('[IPC] servers:list');
    const servers = (store.get('servers') || []).filter(s => !(s?.host === '127.0.0.1' || s?.id === 'local' || s?.pinned));
    return { servers, localServerRunning };
});

ipcMain.handle('servers:add', async (evt, { name, host, port }) => {
    console.log('[IPC] servers:add', name, host, port);
    const servers = store.get('servers');
    const id = `${host}:${port}`;
    if (!servers.find(s => s.id === id)) {
        servers.push({ id, name: name || id, host, port, pinned: false });
        store.set('servers', servers);
    }
    return { servers: store.get('servers') };
});

ipcMain.handle('servers:remove', async (evt, id) => {
    console.log('[IPC] servers:remove', id);
    const servers = store.get('servers');
    const target = servers.find(s => s.id === id);
    if (target && !isLocalHostEntry(target)) {
        store.set('servers', servers.filter(s => s.id !== id));
    }
    return { servers: store.get('servers') };
});

ipcMain.handle('local:start', async () => {
    console.log('[IPC] local:start');
    const ok = await startLocalServer();
    return { ok };
});

ipcMain.handle('local:stop', async () => {
    console.log('[IPC] local:stop');
    const ok = await stopLocalServer();
    return { ok };
});

ipcMain.handle('servers:check', async (evt, { host, port }) => {
    console.log('[IPC] servers:check', host, port);
    const ok = await checkServerReachable(host, port);
    return { ok };
});

ipcMain.handle('servers:open', async (evt, { host, port }) => {
    console.log('[IPC] servers:open', host, port);
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    }
    // Load local UI with target server coordinates; do not expose server-side UI
    const file = path.join(__dirname, '..', 'public', 'index.html');
    await mainWindow.loadFile(file, { search: `?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}` });
    mainWindow.show();
    mainWindow.focus();
    return { ok: true };
});

ipcMain.handle('servers:open-offline', async (evt, { host, port }) => {
    console.log('[IPC] servers:open-offline', host, port);
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    }
    const file = path.join(__dirname, '..', 'public', 'index.html');
    await mainWindow.loadFile(file, { search: `?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}` });
    mainWindow.show();
    mainWindow.focus();
    return { ok: true };
});

// Back to launcher (reuse main window)
ipcMain.handle('app:back-to-launcher', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    } else {
        await mainWindow.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
        mainWindow.show();
        mainWindow.focus();
    }
    return { ok: true };
});

// Start local server (if not running) and open window in one shot
ipcMain.handle('local:start-open', async () => {
    console.log('[IPC] local:start-open');
    const ok = await startLocalServer();
    if (!ok) return { ok: false };
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
    }
    const url = `http://127.0.0.1:3000`;
    await mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
    return { ok: true };
});

// Offline storage IPC
ipcMain.handle('offline:get', async (evt, key) => {
    try { return offlineStore.get(key) ?? null; } catch (e) { return { __error: String(e) }; }
});
ipcMain.handle('offline:set', async (evt, key, value) => {
    try { offlineStore.set(key, value); return { ok: true }; } catch (e) { return { __error: String(e) }; }
});
ipcMain.handle('offline:delete', async (evt, key) => {
    try { offlineStore.delete(key); return { ok: true }; } catch (e) { return { __error: String(e) }; }
});
