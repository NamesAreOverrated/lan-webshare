import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'lanws:';

export const serverKey = (host, port) => `${PREFIX}server:${host}:${port}`;
export const dataKey = (host, port) => `${PREFIX}data:${host}:${port}`;
export const queueKey = (host, port) => `${PREFIX}queue:${host}:${port}`;
export const uiKey = (host, port) => `${PREFIX}ui:${host}:${port}`;

export async function saveServerList(list) {
    await AsyncStorage.setItem(`${PREFIX}servers`, JSON.stringify(list));
}
export async function loadServerList() {
    const raw = await AsyncStorage.getItem(`${PREFIX}servers`);
    return raw ? JSON.parse(raw) : [];
}

export async function saveSelectedServer(s) {
    await AsyncStorage.setItem(`${PREFIX}selectedServer`, JSON.stringify(s));
}
export async function loadSelectedServer() {
    const raw = await AsyncStorage.getItem(`${PREFIX}selectedServer`);
    return raw ? JSON.parse(raw) : null;
}

export async function saveData(host, port, data) {
    await AsyncStorage.setItem(dataKey(host, port), JSON.stringify(data));
}
export async function loadData(host, port) {
    const raw = await AsyncStorage.getItem(dataKey(host, port));
    return raw ? JSON.parse(raw) : null;
}

export async function pushOp(host, port, op) {
    const q = await loadQueue(host, port);
    q.push(op);
    await AsyncStorage.setItem(queueKey(host, port), JSON.stringify(q));
}
export async function loadQueue(host, port) {
    const raw = await AsyncStorage.getItem(queueKey(host, port));
    return raw ? JSON.parse(raw) : [];
}
export async function clearQueue(host, port) {
    await AsyncStorage.removeItem(queueKey(host, port));
}

export async function loadUI(host, port) {
    const raw = await AsyncStorage.getItem(uiKey(host, port));
    return raw ? JSON.parse(raw) : { collapsedVolumes: {} };
}
export async function saveUI(host, port, ui) {
    await AsyncStorage.setItem(uiKey(host, port), JSON.stringify(ui));
}
