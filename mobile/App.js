import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Alert, Linking, ScrollView } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createWS } from './app/lib/wsClient';
import { loadData, saveData, loadQueue, pushOp, clearQueue, loadServerList, saveServerList, loadSelectedServer, saveSelectedServer, loadUI, saveUI } from './app/lib/storage';

function Button({ title, onPress, style, disabled }) {
    return (
        <TouchableOpacity onPress={onPress} disabled={disabled}
            style={[{ paddingVertical: 12, paddingHorizontal: 16, backgroundColor: disabled ? '#475569' : '#4f46e5', borderRadius: 8 }, style]}>
            <Text style={{ color: 'white', fontWeight: '600', textAlign: 'center', opacity: disabled ? 0.8 : 1 }}>{title}</Text>
        </TouchableOpacity>
    );
}

function ServerPicker({ onSelected }) {
    const [host, setHost] = useState('');
    const [port, setPort] = useState('3000');
    const [list, setList] = useState([]);

    useEffect(() => { (async () => { setList(await loadServerList()); /* no auto-select to allow switching */ })(); }, []);

    const addServer = async () => {
        const h = host.trim(); const p = Number(port) || 3000;
        if (!h) return;
        const next = [...list.filter(s => !(s.host === h && s.port === p)), { host: h, port: p }];
        setList(next);
        await saveServerList(next);
    };
    const pick = async (s) => { await saveSelectedServer(s); onSelected(s); };
    const remove = async (s) => {
        const next = list.filter(x => !(x.host === s.host && x.port === s.port));
        setList(next); await saveServerList(next);
    };

    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
            <StatusBar style="light" />
            <View style={{ padding: 16 }}>
                <Text style={{ color: '#cbd5e1', fontSize: 22, fontWeight: '700', marginBottom: 12 }}>选择服务器</Text>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <TextInput placeholder="IP 或域名" placeholderTextColor="#64748b" value={host} onChangeText={setHost} autoCapitalize='none'
                        style={{ flex: 1, color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                    <TextInput placeholder="端口" placeholderTextColor="#64748b" keyboardType='number-pad' value={port} onChangeText={setPort}
                        style={{ width: 90, color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                </View>
                <View style={{ height: 12 }} />
                <Button title="添加到列表" onPress={addServer} />
                <View style={{ height: 24 }} />
                <Text style={{ color: '#94a3b8', marginBottom: 8 }}>已保存服务器</Text>
                <FlatList data={list} keyExtractor={(item) => `${item.host}:${item.port}`}
                    renderItem={({ item }) => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 }}>
                            <TouchableOpacity onPress={() => pick(item)} style={{ flex: 1 }}>
                                <Text style={{ color: 'white', fontSize: 16 }}>{item.host}:{item.port}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => remove(item)}>
                                <Text style={{ color: '#ef4444' }}>删除</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                />
            </View>
        </SafeAreaView>
    );
}

function NotesScreen({ server, onBack }) {
    const [data, setData] = useState({ groups: [], tags: [] });
    const dataRef = useRef(data);
    useEffect(() => { dataRef.current = data; }, [data]);
    const [online, setOnline] = useState(false);
    const [selectedGroup, setSelectedGroup] = useState(null);
    const [selectedEntry, setSelectedEntry] = useState(null);
    // Track current selection in refs so we can safely remap during onSync without losing focus
    const selRef = useRef({ groupId: null, entryId: null });
    useEffect(() => { selRef.current.groupId = selectedGroup?.id || null; }, [selectedGroup?.id]);
    useEffect(() => { selRef.current.entryId = selectedEntry?.id || null; }, [selectedEntry?.id]);
    // Tabs at top-level: 'notes' | 'files' (only visible when not inside a group/entry)
    const [activeTab, setActiveTab] = useState('notes');
    const [files, setFiles] = useState([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [prompt, setPrompt] = useState({ visible: false, title: '', placeholder: '', value: '', onConfirm: null });
    const [groupModal, setGroupModal] = useState({ visible: false, title: '', tags: '', mode: 'create', groupId: null });
    const [moveDialog, setMoveDialog] = useState({ visible: false, entryId: null, fromVolumeId: null });
    const [actionSheet, setActionSheet] = useState({ visible: false, groupId: null, volumeId: null, entryId: null });
    const [pickVolume, setPickVolume] = useState({ visible: false, groupId: null });
    const [selectedTags, setSelectedTags] = useState(new Set());
    const wsRef = useRef(null);
    const lastReorderAt = useRef(0);
    const uiRef = useRef({ collapsedVolumes: {}, orders: { volume: {}, entries: {} }, pendingGroups: {}, pendingEntries: {}, pendingVolumes: {}, pendingVolumeDeletes: {} });
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    // Compute group/entry early and keep editor hooks before any conditional return to preserve hook order
    const group = useMemo(() => data.groups.find(g => g.id === selectedGroup?.id), [data.groups, selectedGroup?.id]);
    const entry = useMemo(() => group?.entries.find(e => e.id === selectedEntry?.id), [group, selectedEntry?.id]);
    const [title, setTitle] = useState(entry?.title || '');
    const [content, setContent] = useState(entry?.content || '');
    const caretRef = useRef({ start: 0, end: 0 });
    const [forcedSel, setForcedSel] = useState(null);
    const valueRef = useRef({ title: '', content: '' });
    useEffect(() => { valueRef.current.title = title; }, [title]);
    useEffect(() => { valueRef.current.content = content; }, [content]);
    // Map previous selection to new text by accounting for a single contiguous diff between old and new text.
    const adjustSelectionForDiff = (oldText, newText, sel) => {
        try {
            const oldStr = String(oldText || '');
            const newStr = String(newText || '');
            if (oldStr === newStr) return { start: sel.start || 0, end: sel.end || 0 };
            const oldLen = oldStr.length;
            const newLen = newStr.length;
            let prefix = 0;
            const minLen = Math.min(oldLen, newLen);
            while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
            let suffix = 0;
            while (
                suffix < (minLen - prefix) &&
                oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
            ) suffix++;
            const delta = newLen - oldLen;
            const oldChangedEnd = oldLen - suffix;
            const newChangedEnd = newLen - suffix;
            const mapPos = (p) => {
                const pos = Math.max(0, Math.min(oldLen, p || 0));
                if (pos <= prefix) return pos;
                if (pos >= oldChangedEnd) return pos + delta;
                // inside changed region → snap to end of inserted segment
                return newChangedEnd;
            };
            const ns = { start: mapPos(sel.start), end: mapPos(sel.end) };
            // clamp to new text length
            const clamp = (n) => Math.max(0, Math.min(newLen, n || 0));
            ns.start = clamp(ns.start); ns.end = clamp(ns.end);
            return ns;
        } catch {
            const len = (newText || '').length; const clamp = (n) => Math.max(0, Math.min(len, n || 0));
            return { start: clamp(sel.start), end: clamp(sel.end) };
        }
    };
    const editRef = useRef({ isApplyingRemoteUpdate: false, lastLocalEditAt: 0, lastTitleEditAt: 0, editorFocused: false, titleFocused: false, saveTimer: null, lastFlushAt: 0 });
    useEffect(() => {
        // when entry switches, update inputs and clear pending timers
        if (editRef.current.saveTimer) { clearTimeout(editRef.current.saveTimer); editRef.current.saveTimer = null; }
        setTitle(entry?.title || '');
        const nextContent = entry?.content || '';
        setContent(nextContent);
        // reset caret to end for new entry; force once then release control
        try {
            const end = (nextContent || '').length;
            caretRef.current = { start: end, end };
            setForcedSel({ start: end, end });
            setTimeout(() => setForcedSel(null), 60);
        } catch { }
        editRef.current.lastLocalEditAt = 0; editRef.current.lastTitleEditAt = 0;
    }, [entry?.id]);

    // 比较器：仅比较组/卷/条目顺序是否相同（用于抑制拖拽后的冗余刷新）
    const ordersEqual = (a, b) => {
        try {
            const ag = a?.groups || []; const bg = b?.groups || [];
            if (ag.length !== bg.length) return false;
            const bMap = new Map(bg.map(g => [g.id, g]));
            for (const g of ag) {
                const gg = bMap.get(g.id); if (!gg) return false;
                const av = g?.volumes || []; const bv = gg?.volumes || [];
                if (av.length !== bv.length) return false;
                const bvMap = new Map(bv.map(v => [v.id, v]));
                for (const v of av) {
                    const vv = bvMap.get(v.id); if (!vv) return false;
                    const ai = v?.entryIds || []; const bi = vv?.entryIds || [];
                    if (ai.length !== bi.length) return false;
                    for (let i = 0; i < ai.length; i++) if (ai[i] !== bi[i]) return false;
                }
            }
            return true;
        } catch { return false; }
    };

    useEffect(() => {
        let closed = false;
        (async () => {
            const cached = await loadData(server.host, server.port);
            if (cached && !closed) {
                setData(cached);
            }
            // load UI prefs
            const ui = await loadUI(server.host, server.port);
            const base = { collapsedVolumes: {}, orders: { volume: {}, entries: {} }, pendingGroups: {}, pendingEntries: {}, pendingVolumes: {}, pendingVolumeDeletes: {} };
            if (ui) {
                uiRef.current = {
                    collapsedVolumes: ui.collapsedVolumes || {},
                    orders: { volume: (ui.orders?.volume) || {}, entries: (ui.orders?.entries) || {} },
                    pendingGroups: ui.pendingGroups || {},
                    pendingEntries: ui.pendingEntries || {},
                    pendingVolumes: ui.pendingVolumes || {},
                    pendingVolumeDeletes: ui.pendingVolumeDeletes || {},
                };
            } else {
                uiRef.current = base;
            }
            const ws = createWS({
                host: server.host,
                port: server.port,
                onSync: async (payload) => {
                    const justReordered = Date.now() - lastReorderAt.current < 400;
                    // 1) Reconcile offline-created temp groups -> real groups upon reconnect
                    try {
                        const local = dataRef.current || { groups: [], tags: [] };
                        const tempGroups = (local.groups || []).filter(g => String(g.id).startsWith('temp-group-'));
                        const pgRaw = uiRef.current.pendingGroups || {};
                        // Normalize structure: value could be string (realId) or object { realId }
                        const ensurePgObj = (val) => (val && typeof val === 'object' ? val : (val ? { realId: val } : { realId: null }));
                        for (const tg of tempGroups) {
                            const pg = ensurePgObj(pgRaw[tg.id]);
                            // find or confirm the real group by title mapping
                            let realId = pg.realId;
                            let serverGroup = realId ? (payload.groups || []).find(sg => sg.id === realId) : null;
                            if (!serverGroup) {
                                const match = (payload.groups || []).find(sg => sg.title === tg.title && !local.groups.some(x => x.id === sg.id));
                                if (match) {
                                    realId = match.id;
                                    serverGroup = match;
                                    pgRaw[tg.id] = { realId, createSentTs: pg.createSentTs || 0 };
                                    uiRef.current.pendingGroups = pgRaw;
                                    await saveUI(server.host, server.port, uiRef.current).catch(() => { });
                                } else {
                                    // No server group yet: trigger create_group once
                                    const now = Date.now();
                                    const sentTs = pg.createSentTs || 0;
                                    if (now - sentTs > 1500) {
                                        send('create_group', { title: tg.title, tags: tg.tags || [] });
                                        pgRaw[tg.id] = { realId: null, createSentTs: now };
                                        uiRef.current.pendingGroups = pgRaw;
                                        await saveUI(server.host, server.port, uiRef.current).catch(() => { });
                                    }
                                }
                            }
                            if (!serverGroup) continue; // wait for real group to exist

                            // Create any missing volumes by title and compute desired order by titles from temp group
                            const desiredTitles = (tg.volumes || []).map(v => v.title);
                            const srvVols = serverGroup.volumes || [];
                            const srvVolByTitle = new Map(srvVols.map(v => [v.title, v]));
                            const pv = uiRef.current.pendingVolumes || {};
                            pv[serverGroup.id] = pv[serverGroup.id] || {};
                            for (const title of desiredTitles) {
                                if (!srvVolByTitle.has(title)) {
                                    const lastTs = pv[serverGroup.id][title] || 0;
                                    if (Date.now() - lastTs > 1500) {
                                        send('create_volume', { groupId: serverGroup.id, title: title || '新分组' });
                                        pv[serverGroup.id][title] = Date.now();
                                    }
                                }
                            }
                            uiRef.current.pendingVolumes = pv; await saveUI(server.host, server.port, uiRef.current).catch(() => { });
                            // After requesting creations, reorder by the titles that already exist now
                            const refreshedSrvGroup = (payload.groups || []).find(sg => sg.id === serverGroup.id) || serverGroup;
                            const rsVolByTitle = new Map((refreshedSrvGroup.volumes || []).map(v => [v.title, v]));
                            const realVolIds = desiredTitles.map(t => rsVolByTitle.get(t)?.id).filter(Boolean);
                            if (realVolIds.length) {
                                const serverVolIds = (refreshedSrvGroup.volumes || []).map(v => v.id);
                                const changed = realVolIds.length !== serverVolIds.length || realVolIds.some((id, i) => id !== serverVolIds[i]);
                                if (changed) {
                                    send('reorder_volumes', { groupId: refreshedSrvGroup.id, newOrder: realVolIds });
                                }
                                // seed UI overlay under real group id
                                try { const ui = uiRef.current; ui.orders.volume[refreshedSrvGroup.id] = [...realVolIds]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
                            }

                            // Delete extra server volumes not in desiredTitles (e.g., default volume) when user has at least one desired volume
                            try {
                                const pvd = uiRef.current.pendingVolumeDeletes || {};
                                pvd[serverGroup.id] = pvd[serverGroup.id] || {};
                                const extras = (refreshedSrvGroup.volumes || []).filter(v => !desiredTitles.includes(v.title));
                                if ((desiredTitles || []).length > 0) {
                                    for (const ex of extras) {
                                        const lastTs = pvd[serverGroup.id][ex.id] || 0;
                                        if (Date.now() - lastTs > 1500) {
                                            send('delete_volume', { groupId: refreshedSrvGroup.id, volumeId: ex.id });
                                            pvd[serverGroup.id][ex.id] = Date.now();
                                        }
                                    }
                                }
                                uiRef.current.pendingVolumeDeletes = pvd; await saveUI(server.host, server.port, uiRef.current).catch(() => { });
                            } catch { }

                            // Create missing entries with correct volume mapping (by title). Avoid duplicates using title+createdAt.
                            const srvEntries = new Map((serverGroup.entries || []).map(e => [`${e.title}@@${e.createdAt}`, e]));
                            const pendingEntrySends = uiRef.current.pendingEntries || {};
                            for (const te of (tg.entries || [])) {
                                const key = `${te.title}@@${te.createdAt}`;
                                if (srvEntries.has(key)) continue; // already exists
                                // find temp volume containing this entry, then resolve to server volume by title
                                const tVol = (tg.volumes || []).find(v => (v.entryIds || []).includes(te.id));
                                const targetVol = tVol ? ((payload.groups || []).find(sg => sg.id === serverGroup.id)?.volumes || []).find(v => v.title === tVol.title) : null;
                                if (targetVol) {
                                    const lastTs = pendingEntrySends[`${serverGroup.id}@@${key}`] || 0;
                                    if (Date.now() - lastTs > 1500) {
                                        send('create_entry_with_content', { groupId: serverGroup.id, volumeId: targetVol.id, title: te.title || '新条目', content: te.content || '', createdAt: te.createdAt, updatedAt: te.updatedAt || te.createdAt });
                                        pendingEntrySends[`${serverGroup.id}@@${key}`] = Date.now();
                                    }
                                }
                                // if no targetVol yet, skip now; we'll retry on next sync
                            }
                            uiRef.current.pendingEntries = pendingEntrySends; await saveUI(server.host, server.port, uiRef.current).catch(() => { });

                            // Seed entry order overlay for each volume under real group, based on temp order by title mapping
                            try {
                                const realGroupNow = (payload.groups || []).find(sg => sg.id === serverGroup.id) || serverGroup;
                                const rEntriesByKey = new Map((realGroupNow.entries || []).map(e => [`${e.title}@@${e.createdAt}`, e.id]));
                                const ui = uiRef.current; ui.orders.entries[realGroupNow.id] = ui.orders.entries[realGroupNow.id] || {};
                                for (const tv of (tg.volumes || [])) {
                                    const realVol = (realGroupNow.volumes || []).find(v => v.title === tv.title);
                                    if (!realVol) continue;
                                    const mapped = (tv.entryIds || []).map(id => {
                                        const e = (tg.entries || []).find(x => x.id === id);
                                        if (!e) return null;
                                        return rEntriesByKey.get(`${e.title}@@${e.createdAt}`) || null;
                                    }).filter(Boolean);
                                    const currentServer = Array.isArray(realVol.entryIds) ? realVol.entryIds : [];
                                    const rest = currentServer.filter(id => !mapped.includes(id));
                                    ui.orders.entries[realGroupNow.id][realVol.id] = [...mapped, ...rest];
                                }
                                uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { });
                            } catch { }
                        }
                    } catch { }

                    // 1.5) Reconcile temp entries inside REAL groups (created offline via 新建条目) so they don't disappear
                    try {
                        const local = dataRef.current || { groups: [], tags: [] };
                        const pendingEntrySends = uiRef.current.pendingEntries || {};
                        for (const lg of (local.groups || [])) {
                            if (String(lg.id).startsWith('temp-group-')) continue; // handled in temp-group reconciliation
                            const sg = (payload.groups || []).find(x => x.id === lg.id);
                            if (!sg) continue;
                            const serverKeySet = new Set((sg.entries || []).map(e => `${e.title}@@${e.createdAt}`));
                            for (const te of (lg.entries || [])) {
                                if (!String(te.id).startsWith('temp')) continue;
                                const key = `${te.title}@@${te.createdAt}`;
                                if (serverKeySet.has(key)) continue; // already exists
                                // resolve volume: find local volume containing temp id, use that volumeId (should exist on server)
                                const tVol = (lg.volumes || []).find(v => (v.entryIds || []).includes(te.id));
                                const volId = tVol?.id;
                                // throttle duplicate sends
                                const lastTs = pendingEntrySends[key] || 0;
                                if (Date.now() - lastTs < 1500) continue;
                                send('create_entry_with_content', { groupId: lg.id, volumeId: volId, title: te.title || '新条目', content: te.content || '', createdAt: te.createdAt, updatedAt: te.updatedAt || te.createdAt });
                                pendingEntrySends[key] = Date.now();
                            }
                        }
                        uiRef.current.pendingEntries = pendingEntrySends; await saveUI(server.host, server.port, uiRef.current).catch(() => { });
                    } catch { }
                    // Build merged from payload, then augment with local pending groups/entries to avoid losing focus
                    const overlay = uiRef.current?.orders || { volume: {}, entries: {} };
                    let merged = JSON.parse(JSON.stringify(payload));
                    try {
                        const local = dataRef.current || { groups: [], tags: [] };
                        const pgRaw = uiRef.current.pendingGroups || {};
                        const ensurePgObj = (val) => (val && typeof val === 'object' ? val : (val ? { realId: val } : { realId: null }));
                        // Helper: determine if a temp group has been fully migrated to a real server group
                        const isFullyMigrated = (tempGroup, serverGroup) => {
                            if (!serverGroup) return false;
                            const desiredTitles = (tempGroup?.volumes || []).map(v => v.title);
                            const realTitles = new Set((serverGroup?.volumes || []).map(v => v.title));
                            const volsDone = desiredTitles.every(t => realTitles.has(t));
                            const serverKeySet = new Set((serverGroup?.entries || []).map(e => `${e.title}@@${e.createdAt}`));
                            const entriesDone = (tempGroup?.entries || []).every(te => serverKeySet.has(`${te.title}@@${te.createdAt}`));
                            return volsDone && entriesDone;
                        };
                        // 1) Keep temp groups visible until fully migrated
                        const tempGroups = (local.groups || []).filter(g => String(g.id).startsWith('temp-group-'));
                        for (const tg of tempGroups) {
                            const pg = ensurePgObj(pgRaw[tg.id]);
                            const real = pg.realId ? (merged.groups || []).find(sg => sg.id === pg.realId) : null;
                            if (!real || !isFullyMigrated(tg, real)) {
                                // include temp group as-is so user doesn't lose context
                                merged.groups = Array.isArray(merged.groups) ? merged.groups : [];
                                // Avoid duplicate temp if already present
                                if (!merged.groups.some(g => g.id === tg.id)) {
                                    merged.groups.unshift(JSON.parse(JSON.stringify(tg)));
                                }
                            }
                        }
                        // 2) Keep temp entries inside real groups visible until server creates them
                        for (const lg of (local.groups || [])) {
                            if (String(lg.id).startsWith('temp-group-')) continue; // handled above
                            const sg = (merged.groups || []).find(x => x.id === lg.id);
                            if (!sg) continue;
                            const serverKeySet = new Set((sg.entries || []).map(e => `${e.title}@@${e.createdAt}`));
                            const tempEntries = (lg.entries || []).filter(e => String(e.id).startsWith('temp'));
                            if (tempEntries.length) {
                                sg.entries = Array.isArray(sg.entries) ? sg.entries : [];
                                for (const te of tempEntries) {
                                    const key = `${te.title}@@${te.createdAt}`;
                                    if (!serverKeySet.has(key) && !sg.entries.some(e => e.id === te.id)) {
                                        sg.entries.push(JSON.parse(JSON.stringify(te)));
                                        // Also reflect it in the corresponding volume's entryIds for UI
                                        const fromV = (lg.volumes || []).find(v => (v.entryIds || []).includes(te.id));
                                        const volId = fromV?.id;
                                        const sv = (sg.volumes || []).find(v => v.id === volId);
                                        if (sv) {
                                            sv.entryIds = Array.isArray(sv.entryIds) ? sv.entryIds : [];
                                            if (!sv.entryIds.includes(te.id)) sv.entryIds.unshift(te.id);
                                        } else if (Array.isArray(sg.volumes) && sg.volumes.length) {
                                            // fallback: place into first volume to keep it visible
                                            const f = sg.volumes[0];
                                            f.entryIds = Array.isArray(f.entryIds) ? f.entryIds : [];
                                            if (!f.entryIds.includes(te.id)) f.entryIds.unshift(te.id);
                                        }
                                    }
                                }
                            }
                        }
                    } catch { }
                    try {
                        for (const g of merged.groups || []) {
                            // If this group is mapped from a temp group, also honor the temp group's title-based order
                            try {
                                const pgRaw = uiRef.current.pendingGroups || {};
                                const tempId = Object.keys(pgRaw).find(tid => {
                                    const val = pgRaw[tid];
                                    const realId = (val && typeof val === 'object') ? val.realId : val;
                                    return realId === g.id;
                                });
                                if (tempId) {
                                    const local = dataRef.current || { groups: [], tags: [] };
                                    const tg = (local.groups || []).find(x => x.id === tempId);
                                    if (tg) {
                                        const desiredTitles = (tg.volumes || []).map(v => v.title);
                                        const byTitle = new Map((g.volumes || []).map(v => [v.title, v]));
                                        const ordered = desiredTitles.map(t => byTitle.get(t)).filter(Boolean);
                                        const rest = (g.volumes || []).filter(v => !desiredTitles.includes(v.title));
                                        g.volumes = [...ordered, ...rest];
                                    }
                                }
                            } catch { }
                            let volOverlay = overlay.volume?.[g.id];
                            if (Array.isArray(volOverlay) && Array.isArray(g.volumes)) {
                                const ids = g.volumes.map(v => v.id);
                                // Map any temp ids from overlay to real ids by matching title in previous local state
                                const prevGroup = (dataRef.current?.groups || []).find(x => x.id === g.id);
                                const used = new Set();
                                volOverlay = volOverlay.map(vid => {
                                    if (ids.includes(vid)) return vid;
                                    const prevVolTitle = prevGroup?.volumes?.find(v => v.id === vid)?.title;
                                    if (!prevVolTitle) return vid;
                                    const match = (g.volumes || []).find(v => v.title === prevVolTitle && !used.has(v.id));
                                    if (match) { used.add(match.id); return match.id; }
                                    return vid;
                                });
                                const keep = volOverlay.filter(id => ids.includes(id));
                                const rest = ids.filter(id => !keep.includes(id));
                                const newIds = [...keep, ...rest];
                                if (JSON.stringify(newIds) !== JSON.stringify(ids)) {
                                    g.volumes = newIds.map(id => g.volumes.find(v => v.id === id)).filter(Boolean);
                                }
                            }
                            const entryOverlay = overlay.entries?.[g.id] || {};
                            // Build map from previous local temp entry id -> key, and from server key -> real id
                            const prevGroup = (dataRef.current?.groups || []).find(x => x.id === g.id);
                            const tempIdToKey = new Map();
                            try { (prevGroup?.entries || []).forEach(e => { if (String(e.id).startsWith('temp')) tempIdToKey.set(e.id, `${e.title}@@${e.createdAt}`); }); } catch { }
                            const keyToRealId = new Map();
                            try { (g.entries || []).forEach(e => { keyToRealId.set(`${e.title}@@${e.createdAt}`, e.id); }); } catch { }
                            for (const v of g.volumes || []) {
                                const ov = entryOverlay[v.id];
                                const serverIds = Array.isArray(v.entryIds) ? v.entryIds : [];
                                if (Array.isArray(ov)) {
                                    // Include temp (pending) ids from previous local volume to preserve placeholders, but map to real ids when possible
                                    let prevVol = prevGroup?.volumes?.find(x => x.id === v.id);
                                    if (!prevVol) {
                                        // fallback by title
                                        const byTitle = prevGroup?.volumes?.find(x => x.title === v.title);
                                        if (byTitle) prevVol = byTitle;
                                    }
                                    const prevVolIds = Array.isArray(prevVol?.entryIds) ? prevVol.entryIds : [];
                                    const pendingIds = prevVolIds.filter(id => String(id).startsWith('temp'));
                                    // Build ordered list: overlay order first (map real ids present in serverIds and any temp ids), then remaining server ids
                                    const fromOverlay = [];
                                    for (const id of ov) {
                                        if (serverIds.includes(id)) { fromOverlay.push(id); continue; }
                                        if (String(id).startsWith('temp') && pendingIds.includes(id)) {
                                            const key = tempIdToKey.get(id);
                                            const real = key ? keyToRealId.get(key) : null;
                                            if (real && serverIds.includes(real)) { fromOverlay.push(real); continue; }
                                            fromOverlay.push(id);
                                        }
                                    }
                                    const remainingServer = serverIds.filter(id => !fromOverlay.includes(id));
                                    v.entryIds = [...fromOverlay, ...remainingServer];
                                }
                            }
                        }
                    } catch { }

                    // After merging and overlay, remap selection to avoid losing focus
                    try {
                        const local = dataRef.current || { groups: [], tags: [] };
                        const prevSel = { groupId: selRef.current.groupId, entryId: selRef.current.entryId };
                        let nextGroupId = prevSel.groupId;
                        let nextEntryId = prevSel.entryId;
                        const pgRaw = uiRef.current.pendingGroups || {};
                        const ensurePgObj = (val) => (val && typeof val === 'object' ? val : (val ? { realId: val } : { realId: null }));
                        // If selected temp group has a real mapping and is fully migrated, switch to real
                        if (nextGroupId && String(nextGroupId).startsWith('temp-group-')) {
                            const pg = ensurePgObj(pgRaw[nextGroupId]);
                            const real = pg?.realId ? (merged.groups || []).find(g => g.id === pg.realId) : null;
                            // Check migration state against local temp group
                            const tempGroup = (local.groups || []).find(g => g.id === nextGroupId);
                            const isDone = tempGroup && real ? (() => {
                                const desiredTitles = (tempGroup.volumes || []).map(v => v.title);
                                const realTitles = new Set((real.volumes || []).map(v => v.title));
                                const volsDone = desiredTitles.every(t => realTitles.has(t));
                                const serverKeySet = new Set((real.entries || []).map(e => `${e.title}@@${e.createdAt}`));
                                const entriesDone = (tempGroup.entries || []).every(te => serverKeySet.has(`${te.title}@@${te.createdAt}`));
                                return volsDone && entriesDone;
                            })() : false;
                            if (pg?.realId && real && isDone) {
                                nextGroupId = pg.realId;
                            }
                        }
                        // If selected temp entry now exists on server, switch to real id
                        if (nextEntryId && String(nextEntryId).startsWith('temp')) {
                            // Determine current group context for the editor/list
                            const g = (merged.groups || []).find(x => x.id === nextGroupId);
                            if (g) {
                                // Find temp entry details from local state to compute key
                                const localGroup = (local.groups || []).find(x => x.id === selRef.current.groupId) || (local.groups || []).find(x => x.id === nextGroupId);
                                const localEntry = (localGroup?.entries || []).find(e => e.id === nextEntryId);
                                const key = localEntry ? `${localEntry.title}@@${localEntry.createdAt}` : null;
                                if (key) {
                                    const real = (g.entries || []).find(e => `${e.title}@@${e.createdAt}` === key && !String(e.id).startsWith('temp'));
                                    if (real) nextEntryId = real.id;
                                }
                            }
                        }
                        // Apply remapped selection if changed
                        if (prevSel.groupId !== nextGroupId) setSelectedGroup(nextGroupId ? { id: nextGroupId } : null);
                        if (prevSel.entryId !== nextEntryId) setSelectedEntry(nextEntryId ? { id: nextEntryId } : null);
                    } catch { }

                    if (justReordered && ordersEqual(dataRef.current, merged)) {
                        await saveData(server.host, server.port, merged).catch(() => { });
                        setLoading(false);
                        return;
                    }
                    setData(merged);
                    await saveData(server.host, server.port, merged).catch(() => { });
                    setLoading(false);
                    // If in editor for the selected entry, apply remote updates when safe (no recent local edits/focus)
                    try {
                        if (selRef.current.groupId && selRef.current.entryId) {
                            const gNow = (merged.groups || []).find(x => x.id === selRef.current.groupId);
                            const eNow = gNow?.entries?.find(x => x.id === selRef.current.entryId);
                            if (eNow) {
                                const nowMs = Date.now();
                                const recentlyTyping = nowMs - (editRef.current.lastLocalEditAt || 0) < 1000;
                                const recentlyTitle = nowMs - (editRef.current.lastTitleEditAt || 0) < 800;
                                // Apply remote updates when user hasn't typed recently, regardless of focus
                                if (!recentlyTyping && !recentlyTitle) {
                                    if (eNow.content !== (valueRef.current.content ?? '') || eNow.title !== (valueRef.current.title ?? '')) {
                                        editRef.current.isApplyingRemoteUpdate = true;
                                        const prevSel = caretRef.current || { start: 0, end: 0 };
                                        const oldText = valueRef.current.content ?? '';
                                        const newText = eNow.content || '';
                                        setTitle(eNow.title || '');
                                        setContent(newText);
                                        // preserve caret range with diff-based offset when editor is focused
                                        try {
                                            if (editRef.current.editorFocused) {
                                                const target = adjustSelectionForDiff(oldText, newText, prevSel);
                                                caretRef.current = target;
                                                // force selection briefly after content update then release
                                                setTimeout(() => { setForcedSel(target); setTimeout(() => setForcedSel(null), 80); }, 0);
                                            }
                                        } catch { }
                                        // small timeout to avoid immediate autosave feedback
                                        setTimeout(() => { editRef.current.isApplyingRemoteUpdate = false; }, 50);
                                    }
                                }
                            }
                        }
                    } catch { }
                    // Push reorder only when merged order actually differs from server payload
                    try {
                        const serverGroups = payload.groups || [];
                        for (const g of merged.groups || []) {
                            const sg = serverGroups.find(x => x.id === g.id);
                            if (!sg) continue;
                            const mergedVolIds = (g.volumes || []).map(v => v.id);
                            const serverVolIds = (sg.volumes || []).map(v => v.id);
                            const volsChanged = mergedVolIds.length !== serverVolIds.length || mergedVolIds.some((id, i) => id !== serverVolIds[i]);
                            if (volsChanged && !String(g.id).startsWith('temp-group-')) {
                                send('reorder_volumes', { groupId: g.id, newOrder: mergedVolIds });
                            }
                            for (const v of g.volumes || []) {
                                const sv = (sg.volumes || []).find(x => x.id === v.id || x.title === v.title);
                                const mergedIds = Array.isArray(v.entryIds) ? v.entryIds : [];
                                const serverIds = Array.isArray(sv?.entryIds) ? sv.entryIds : [];
                                const changed = mergedIds.length !== serverIds.length || mergedIds.some((id, i) => id !== serverIds[i]);
                                if (changed && !String(g.id).startsWith('temp-group-')) {
                                    const clean = mergedIds.filter(id => !String(id).startsWith('temp'));
                                    const changedClean = clean.length !== serverIds.length || clean.some((id, i) => id !== serverIds[i]);
                                    if (changedClean) {
                                        send('reorder_entries', { groupId: g.id, volumeId: v.id, newOrder: clean });
                                    }
                                }
                            }
                        }
                    } catch { }
                },
                onStatus: ({ online }) => setOnline(online)
            });
            wsRef.current = ws;
            setLoading(false);
        })();
        return () => { closed = true; wsRef.current?.close(); };
    }, [server.host, server.port]);

    const send = (type, payload) => {
        if (!wsRef.current) return;
        wsRef.current.send(type, payload);
    };

    const createGroup = () => { setGroupModal({ visible: true, title: '', tags: '', mode: 'create', groupId: null }); };
    const confirmGroupModal = () => {
        const t = (groupModal.title || '').trim() || (groupModal.mode === 'edit' ? '未命名组' : '新建组');
        const tags = (groupModal.tags || '').split(',').map(s => s.trim()).filter(Boolean);
        const close = () => setGroupModal({ visible: false, title: '', tags: '', mode: 'create', groupId: null });
        if (groupModal.mode === 'create') {
            close();
            setData(prev => {
                const now = new Date().toISOString();
                const tempVolId = `temp-vol-${Date.now()}`;
                const tempG = { id: `temp-group-${Date.now()}`, title: t, tags, entries: [], volumes: [{ id: tempVolId, title: '默认分组', entryIds: [] }], createdAt: now, updatedAt: now };
                const next = { ...prev, groups: [tempG, ...(prev.groups || [])], tags: Array.from(new Set([...(prev.tags || []), ...tags])) };
                try {
                    const ui = uiRef.current; ui.orders.volume[tempG.id] = [tempVolId]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { });
                    // mark pending group for reconciliation
                    const ui2 = uiRef.current; ui2.pendingGroups = ui2.pendingGroups || {}; ui2.pendingGroups[tempG.id] = { realId: null, createSentTs: 0 }; uiRef.current = ui2; saveUI(server.host, server.port, ui2).catch(() => { });
                } catch { }
                saveData(server.host, server.port, next).catch(() => { });
                return next;
            });
            if (online) send('create_group', { title: t, tags });
        } else {
            // edit existing group
            const gid = groupModal.groupId;
            close();
            setData(prev => {
                const next = JSON.parse(JSON.stringify(prev || { groups: [], tags: [] }));
                const g = (next.groups || []).find(x => x.id === gid);
                const now = new Date().toISOString();
                if (g) { g.title = t; g.tags = tags; g.updatedAt = now; }
                // maintain global tags union
                next.tags = Array.from(new Set([...(next.tags || []), ...tags]));
                saveData(server.host, server.port, next).catch(() => { });
                return next;
            });
            if (!String(gid).startsWith('temp-group-')) {
                send('update_group', { id: gid, title: t, tags, updatedAt: new Date().toISOString() });
            }
        }
    };

    const createEntryInVolume = (groupId, volumeId) => {
        if (!online) {
            // 离线占位，立即保存本地
            const tmpId = `temp-${Date.now()}`;
            setData(prev => {
                const next = JSON.parse(JSON.stringify(prev || { groups: [], tags: [] }));
                const g = next.groups.find(g => g.id === groupId);
                if (g) {
                    const now = new Date().toISOString();
                    const e = { id: tmpId, title: '待创建条目', content: '', createdAt: now, updatedAt: now, __pending: true };
                    g.entries = [e, ...(g.entries || [])];
                    const v = (g.volumes || []).find(v => v.id === volumeId) || (g.volumes || [])[0];
                    if (v) { v.entryIds = [e.id, ...(v.entryIds || [])]; try { const ui = uiRef.current; ui.orders.entries[groupId] = ui.orders.entries[groupId] || {}; ui.orders.entries[groupId][v.id] = [...v.entryIds]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { } }
                }
                saveData(server.host, server.port, next).catch(() => { });
                return next;
            });
            // 允许离线直接进入编辑
            setSelectedEntry({ id: tmpId });
        } else {
            // 仅在线时立即请求创建；离线改为在保存时通过 create_entry_with_content 一次性创建
            if (String(groupId).startsWith('temp-group-')) return; // 临时组等映射后再创建
            send('create_entry', { groupId, volumeId });
        }
    };
    const createEntry = (groupId) => {
        const g = data.groups.find(x => x.id === groupId);
        const vols = g?.volumes || [];
        if (vols.length <= 1) {
            const vId = vols[0]?.id;
            createEntryInVolume(groupId, vId);
        } else {
            setPickVolume({ visible: true, groupId });
        }
    };

    // Desktop parity: clone & insert helpers
    const cloneEntry = (groupId, entryId) => {
        // optimistic: insert a local copy right after original when offline
        if (!online) {
            setData(prev => {
                const next = JSON.parse(JSON.stringify(prev));
                const g = next.groups.find(g => g.id === groupId);
                if (g) {
                    const idx = (g.entries || []).findIndex(e => e.id === entryId);
                    if (idx !== -1) {
                        const original = g.entries[idx];
                        const now = new Date().toISOString();
                        const copy = { id: `temp-clone-${Date.now()}`, title: `${original.title} (副本)`, content: original.content, createdAt: now, updatedAt: now, __pending: true };
                        g.entries.splice(idx + 1, 0, copy);
                        // also insert into the same volume after original
                        const vol = (g.volumes || []).find(v => (v.entryIds || []).includes(entryId));
                        if (vol) { const at = vol.entryIds.indexOf(entryId); vol.entryIds.splice(at + 1, 0, copy.id); try { const ui = uiRef.current; ui.orders.entries[groupId] = ui.orders.entries[groupId] || {}; ui.orders.entries[groupId][vol.id] = [...vol.entryIds]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { } }
                        saveData(server.host, server.port, next).catch(() => { });
                    }
                }
                return next;
            });
        }
        if (!String(groupId).startsWith('temp-group-')) { send('clone_entry', { groupId, entryId }); }
    };
    const insertEntry = (groupId, anchorEntryId, position) => {
        if (!online) {
            // optimistic insert around anchor within its volume
            setData(prev => {
                const next = JSON.parse(JSON.stringify(prev));
                const g = next.groups.find(g => g.id === groupId);
                if (g) {
                    const now = new Date().toISOString();
                    const tempId = `temp-insert-${Date.now()}`;
                    const anchor = (g.entries || []).find(e => e.id === anchorEntryId);
                    // add temp entry to entries list (nearby original position for semantics)
                    const idx = (g.entries || []).findIndex(e => e.id === anchorEntryId);
                    const insertIdx = idx === -1 ? 0 : (position === 'before' ? idx : idx + 1);
                    g.entries.splice(Math.max(0, insertIdx), 0, { id: tempId, title: '新条目', content: '# 新条目\n\n开始写作...', createdAt: now, updatedAt: now, __pending: true });
                    // update volume mapping
                    const vol = (g.volumes || []).find(v => (v.entryIds || []).includes(anchorEntryId)) || (g.volumes || [])[0];
                    if (vol) {
                        const at = (vol.entryIds || []).indexOf(anchorEntryId);
                        const ins = at === -1 ? 0 : (position === 'before' ? at : at + 1);
                        vol.entryIds = Array.isArray(vol.entryIds) ? vol.entryIds : [];
                        vol.entryIds.splice(ins, 0, tempId); try { const ui = uiRef.current; ui.orders.entries[groupId] = ui.orders.entries[groupId] || {}; ui.orders.entries[groupId][vol.id] = [...vol.entryIds]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
                    }
                    g.updatedAt = now;
                    saveData(server.host, server.port, next).catch(() => { });
                }
                return next;
            });
        }
        // map temp anchor to real when possible
        let sendAnchorId = anchorEntryId; let sendPos = position;
        if (String(anchorEntryId || '').startsWith('temp')) {
            const gNow = data.groups.find(g => g.id === groupId);
            const vol = gNow?.volumes?.find(v => (v.entryIds || []).includes(anchorEntryId));
            if (vol) {
                const ids = vol.entryIds || []; const idx = ids.indexOf(anchorEntryId);
                const prevReal = ids.slice(0, idx).reverse().find(id => !String(id).startsWith('temp'));
                const nextReal = ids.slice(idx + 1).find(id => !String(id).startsWith('temp'));
                if (prevReal && position === 'after') { sendAnchorId = prevReal; sendPos = 'after'; }
                else if (nextReal) { sendAnchorId = nextReal; sendPos = 'before'; }
                else { const firstReal = ids.find(id => !String(id).startsWith('temp')); if (firstReal) { sendAnchorId = firstReal; sendPos = 'before'; } }
            }
        }
        if (!String(groupId).startsWith('temp-group-')) {
            if (sendAnchorId && !String(sendAnchorId).startsWith('temp')) send('insert_entry', { groupId, anchorEntryId: sendAnchorId, position: sendPos });
            else send('create_entry', { groupId });
        }
    };

    const renameGroup = (group) => {
        // Use the group modal to edit name + tags
        setGroupModal({ visible: true, title: group.title || '', tags: (group.tags || []).join(','), mode: 'edit', groupId: group.id });
    };

    const deleteGroup = (group) => {
        Alert.alert('确认删除', `确定删除“${group.title || '未命名组'}”？此操作不可撤销。`, [
            { text: '取消', style: 'cancel' },
            {
                text: '删除', style: 'destructive', onPress: () => {
                    // optimistic local remove for offline UX
                    setData(prev => {
                        const next = JSON.parse(JSON.stringify(prev));
                        next.groups = (next.groups || []).filter(g => g.id !== group.id);
                        saveData(server.host, server.port, next).catch(() => { });
                        return next;
                    });
                    send('delete_group', { id: group.id });
                }
            }
        ]);
    };

    const deleteEntry = (groupId, entry) => {
        Alert.alert('确认删除', `确定删除条目“${entry.title || '未命名条目'}”？`, [
            { text: '取消', style: 'cancel' },
            {
                text: '删除', style: 'destructive', onPress: () => {
                    // optimistic local removal
                    setData(prev => {
                        const next = JSON.parse(JSON.stringify(prev));
                        const g = next.groups.find(gx => gx.id === groupId);
                        if (g) {
                            // remove from entries list
                            g.entries = (g.entries || []).filter(e => e.id !== entry.id);
                            // remove from all volumes
                            (g.volumes || []).forEach(v => {
                                v.entryIds = (v.entryIds || []).filter(id => id !== entry.id);
                            });
                            g.updatedAt = new Date().toISOString();
                            // update overlay for any volume that previously contained it
                            try {
                                const ui = uiRef.current; ui.orders.entries[groupId] = ui.orders.entries[groupId] || {};
                                (g.volumes || []).forEach(v => { const curr = ui.orders.entries[groupId][v.id] || v.entryIds || []; ui.orders.entries[groupId][v.id] = curr.filter(id => id !== entry.id); });
                                uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { });
                            } catch { }
                        }
                        saveData(server.host, server.port, next).catch(() => { });
                        return next;
                    });
                    // clear editor if deleting current
                    if (selectedEntry?.id === entry.id) setSelectedEntry(null);
                    // queue server deletion when applicable
                    if (!String(groupId).startsWith('temp-group-') && !String(entry.id).startsWith('temp')) {
                        send('delete_entry', { groupId, entryId: entry.id });
                    }
                }
            }
        ]);
    };

    const updateEntry = async (groupId, entryId, title, content) => {
        const updatedAt = new Date().toISOString();
        // If editing a temp/pending entry, offline-safe create with content
        const isTemp = String(entryId || '').startsWith('temp') || entry?.__pending;
        if (isTemp) {
            // find volume of this temp entry if exists
            const volId = group?.volumes?.find(v => (v.entryIds || []).includes(entryId))?.id;
            // find the local temp entry to preserve its createdAt for dedupe mapping
            const localGroup = (dataRef.current?.groups || []).find(g => g.id === groupId);
            const localTemp = localGroup?.entries?.find(e => e.id === entryId);
            const createdAt = localTemp?.createdAt || updatedAt;
            if (!String(groupId).startsWith('temp-group-')) {
                // Avoid duplicate creates: only send once per temp entry id
                const tec = uiRef.current.tempEntryCreateSent || {}; uiRef.current.tempEntryCreateSent = tec;
                const sentTs = tec[entryId] || 0;
                if (!sentTs || Date.now() - sentTs > 60_000) { // resend at most after 60s if still not materialized
                    try {
                        send('create_entry_with_content', { groupId, volumeId: volId, title, content, createdAt, updatedAt });
                        tec[entryId] = Date.now();
                        saveUI(server.host, server.port, uiRef.current).catch(() => { });
                    } catch { }
                }
            }
        } else {
            // send or queue update for existing entry
            send('update_entry', { groupId, entryId, title, content, updatedAt });
        }
        // local optimistic apply + persist
        setData(prev => {
            const next = JSON.parse(JSON.stringify(prev || { groups: [], tags: [] }));
            const g = next.groups.find(g => g.id === groupId);
            if (g) {
                const e = (g.entries || []).find(e => e.id === entryId);
                if (e) { e.title = title; e.content = content; e.updatedAt = updatedAt; g.updatedAt = updatedAt; }
            }
            // fire and forget persist
            saveData(server.host, server.port, next).catch(() => { });
            return next;
        });
    };

    // Autosave with leading throttle + trailing debounce for more real-time sync while typing
    const scheduleAutosave = (opts = {}) => {
        if (!group || !entry) return;
        if (editRef.current.isApplyingRemoteUpdate) return; // skip saving when applying remote
        const now = Date.now();
        const minGap = 350; // leading flush throttle window
        const forceImmediate = !!opts.immediate;
        const canFlushNow = forceImmediate || (now - (editRef.current.lastFlushAt || 0) > minGap);
        if (canFlushNow) {
            if (editRef.current.saveTimer) { clearTimeout(editRef.current.saveTimer); editRef.current.saveTimer = null; }
            editRef.current.lastFlushAt = now;
            updateEntry(group.id, entry.id, title, content);
            return;
        }
        // schedule trailing debounce as fallback
        if (editRef.current.saveTimer) clearTimeout(editRef.current.saveTimer);
        editRef.current.saveTimer = setTimeout(() => {
            editRef.current.saveTimer = null;
            editRef.current.lastFlushAt = Date.now();
            updateEntry(group.id, entry.id, title, content);
        }, 600);
    };

    const groups = useMemo(() => (data.groups || []).sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)), [data]);
    const filteredGroups = useMemo(() => groups.filter(g => {
        if (selectedTags.size === 0) return (g.title || '').toLowerCase().includes(search.toLowerCase());
        const hasTag = (g.tags || []).some(t => selectedTags.has(t));
        return hasTag && (g.title || '').toLowerCase().includes(search.toLowerCase());
    }), [groups, selectedTags, search]);

    const toggleTag = (tag) => {
        setSelectedTags(prev => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag); else next.add(tag);
            return next;
        });
    };

    // Volume helpers
    const reorderVolumesOptimistic = (group, fromIdx, toIdx) => {
        const vols = [...(group.volumes || [])];
        const [mv] = vols.splice(fromIdx, 1);
        vols.splice(toIdx, 0, mv);
        group.volumes = vols;
    };
    const sendReorderVolumes = (group, newOrderIds) => { send('reorder_volumes', { groupId: group.id, newOrder: newOrderIds }); };
    const onDragEndVolumes = (group, from, to) => {
        if (from === to) return;
        lastReorderAt.current = Date.now();
        setData(prev => {
            const groups = prev.groups.map(x => {
                if (x.id !== group.id) return x;
                const vols = [...(x.volumes || [])];
                const [mv] = vols.splice(from, 1);
                vols.splice(to, 0, mv);
                return { ...x, volumes: vols };
            });
            const next = { ...prev, groups };
            const newOrderIds = (groups.find(x => x.id === group.id)?.volumes || []).map(v => v.id);
            if (!String(group.id).startsWith('temp-group-')) sendReorderVolumes(group, newOrderIds);
            try { const ui = uiRef.current; ui.orders.volume[group.id] = [...newOrderIds]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
            saveData(server.host, server.port, next).catch(() => { });
            return next;
        });
    };
    const createVolume = (group) => {
        setPrompt({
            visible: true, title: '新建卷', placeholder: '卷标题', value: '', onConfirm: (val) => {
                const t = (val || '').trim() || '新分组';
                // optimistic add
                setData(prev => {
                    const next = JSON.parse(JSON.stringify(prev));
                    const g = next.groups.find(x => x.id === group.id);
                    if (g) {
                        g.volumes = Array.isArray(g.volumes) ? g.volumes : [];
                        const tempVolId = `temp-vol-${Date.now()}`;
                        g.volumes.push({ id: tempVolId, title: t, entryIds: [] });
                        try {
                            const ui = uiRef.current || { collapsedVolumes: {}, orders: { volume: {}, entries: {} } };
                            ui.orders = ui.orders || { volume: {}, entries: {} };
                            const currentOrder = (ui.orders.volume[group.id] && ui.orders.volume[group.id].length)
                                ? ui.orders.volume[group.id]
                                : g.volumes.map(v => v.id);
                            ui.orders.volume[group.id] = [...currentOrder.filter(id => id !== tempVolId), tempVolId];
                            uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { });
                        } catch { }
                        saveData(server.host, server.port, next).catch(() => { });
                    }
                    return next;
                });
                // If group is temp (offline), wait for reconciliation; otherwise send now
                if (!String(group.id).startsWith('temp-group-')) {
                    send('create_volume', { groupId: group.id, title: t });
                }
            }
        });
    };
    const renameVolume = (group, volume) => {
        setPrompt({
            visible: true, title: '重命名卷', placeholder: '卷标题', value: volume.title || '', onConfirm: (val) => {
                const newTitle = (val || '').trim() || volume.title;
                // optimistic update
                setData(prev => { const next = JSON.parse(JSON.stringify(prev)); const g = next.groups.find(x => x.id === group.id); const v = g?.volumes?.find(v => v.id === volume.id); if (v) { v.title = newTitle; g.updatedAt = new Date().toISOString(); } saveData(server.host, server.port, next).catch(() => { }); return next; });
                if (!String(group.id).startsWith('temp-group-')) { send('update_volume', { groupId: group.id, volumeId: volume.id, title: newTitle }); }
            }
        });
    };
    const deleteVolume = (group, volume) => {
        Alert.alert('删除确认', `确定删除卷“${volume.title}”？条目将移动到其他卷。`, [
            { text: '取消', style: 'cancel' },
            {
                text: '删除', style: 'destructive', onPress: () => {
                    // optimistic local delete volume for both temp and real groups
                    setData(prev => {
                        const next = JSON.parse(JSON.stringify(prev));
                        const g = next.groups.find(x => x.id === group.id);
                        if (g) {
                            const vols = g.volumes || [];
                            const idx = vols.findIndex(v => v.id === volume.id);
                            if (idx !== -1) {
                                const targetIdx = idx === 0 ? (vols.length > 1 ? 1 : -1) : 0;
                                if (targetIdx === -1) {
                                    const newId = `temp-vol-${Date.now()}`;
                                    vols.push({ id: newId, title: '默认分组', entryIds: [] });
                                }
                                const toV = vols[targetIdx === -1 ? vols.length - 1 : targetIdx];
                                toV.entryIds = [...(vols[idx].entryIds || []), ...(toV.entryIds || [])];
                                const removedVolId = vols[idx].id;
                                vols.splice(idx, 1);
                                g.volumes = vols; g.updatedAt = new Date().toISOString();
                                // update overlays: volumes order and entry orders
                                try {
                                    const ui = uiRef.current; ui.orders.volume[g.id] = (ui.orders.volume[g.id] || []).filter(id => id !== removedVolId);
                                    ui.orders.entries[g.id] = ui.orders.entries[g.id] || {}; delete ui.orders.entries[g.id][removedVolId];
                                    ui.orders.entries[g.id][toV.id] = [...(toV.entryIds || [])];
                                    uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { });
                                } catch { }
                            }
                        }
                        saveData(server.host, server.port, next).catch(() => { });
                        return next;
                    });
                    // queue server deletion when real group
                    if (!String(group.id).startsWith('temp-group-')) {
                        send('delete_volume', { groupId: group.id, volumeId: volume.id });
                    }
                }
            }
        ]);
    };
    const moveEntryUp = (group, volume, entryId) => {
        const ids = [...(volume.entryIds || [])]; const idx = ids.indexOf(entryId); if (idx <= 0) return;
        ids.splice(idx - 1, 0, ids.splice(idx, 1)[0]);
        lastReorderAt.current = Date.now();
        setData(prev => {
            const groups = prev.groups.map(gx => gx.id !== group.id ? gx : ({
                ...gx,
                volumes: (gx.volumes || []).map(vv => vv.id !== volume.id ? vv : ({ ...vv, entryIds: ids }))
            }));
            const next = { ...prev, groups };
            if (!String(group.id).startsWith('temp-group-')) send('reorder_entries', { groupId: group.id, volumeId: volume.id, newOrder: ids });
            try { const ui = uiRef.current; ui.orders.entries[group.id] = ui.orders.entries[group.id] || {}; ui.orders.entries[group.id][volume.id] = [...ids]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
            saveData(server.host, server.port, next).catch(() => { });
            return next;
        });
    };
    const moveEntryDown = (group, volume, entryId) => {
        const ids = [...(volume.entryIds || [])]; const idx = ids.indexOf(entryId); if (idx < 0 || idx >= ids.length - 1) return;
        ids.splice(idx + 1, 0, ids.splice(idx, 1)[0]);
        lastReorderAt.current = Date.now();
        setData(prev => {
            const groups = prev.groups.map(gx => gx.id !== group.id ? gx : ({
                ...gx,
                volumes: (gx.volumes || []).map(vv => vv.id !== volume.id ? vv : ({ ...vv, entryIds: ids }))
            }));
            const next = { ...prev, groups };
            if (!String(group.id).startsWith('temp-group-')) send('reorder_entries', { groupId: group.id, volumeId: volume.id, newOrder: ids });
            try { const ui = uiRef.current; ui.orders.entries[group.id] = ui.orders.entries[group.id] || {}; ui.orders.entries[group.id][volume.id] = [...ids]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
            saveData(server.host, server.port, next).catch(() => { });
            return next;
        });
    };
    const openMoveDialog = (volume, entryId) => {
        setMoveDialog({ visible: true, entryId, fromVolumeId: volume.id });
    };
    const confirmMoveToVolume = (group, toVolumeId) => {
        const { entryId, fromVolumeId } = moveDialog;
        setMoveDialog({ visible: false, entryId: null, fromVolumeId: null });
        if (!entryId || !fromVolumeId || fromVolumeId === toVolumeId) return;
        // optimistic update
        lastReorderAt.current = Date.now();
        setData(prev => {
            const groups = prev.groups.map(gx => {
                if (gx.id !== group.id) return gx;
                const volumes = (gx.volumes || []).map(v => ({ ...v }));
                const fromV = volumes.find(v => v.id === fromVolumeId);
                const toV = volumes.find(v => v.id === toVolumeId);
                if (fromV && toV) {
                    fromV.entryIds = (fromV.entryIds || []).filter(id => id !== entryId);
                    toV.entryIds = [entryId, ...(toV.entryIds || [])];
                }
                return { ...gx, volumes };
            });
            const next = { ...prev, groups };
            try { const ui = uiRef.current; ui.orders.entries[group.id] = ui.orders.entries[group.id] || {}; ui.orders.entries[group.id][fromVolumeId] = [...(groups.find(g => g.id === group.id).volumes.find(v => v.id === fromVolumeId).entryIds || [])]; ui.orders.entries[group.id][toVolumeId] = [...(groups.find(g => g.id === group.id).volumes.find(v => v.id === toVolumeId).entryIds || [])]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
            saveData(server.host, server.port, next).catch(() => { });
            return next;
        });
        if (!String(group.id).startsWith('temp-group-')) send('move_entry', { groupId: group.id, fromVolumeId, toVolumeId, entryId, toIndex: 0 });
    };

    // Files tab: fetch file list
    const loadFiles = async () => {
        try {
            setFilesLoading(true);
            const base = `http://${server.host}:${server.port}`;
            const res = await fetch(`${base}/files`);
            const list = await res.json();
            setFiles(Array.isArray(list) ? list : []);
        } catch {
            setFiles([]);
        } finally {
            setFilesLoading(false);
        }
    };
    useEffect(() => {
        if (!selectedGroup && activeTab === 'files') {
            loadFiles();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, selectedGroup, server.host, server.port]);

    if (loading) {
        return <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' }}><ActivityIndicator color="#818cf8" /><StatusBar style="light" /></SafeAreaView>;
    }

    if (!selectedGroup) {
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
                <StatusBar style="light" />
                {/* Header */}
                <View style={{ padding: 16, paddingBottom: 8 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <View>
                            <Text style={{ color: '#e2e8f0', fontSize: 20, fontWeight: '700' }}>{online ? '在线' : '离线'}</Text>
                            <Text style={{ color: '#94a3b8', marginTop: 4, fontSize: 12 }}>{server.host}:{server.port}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            {activeTab === 'notes' && <Button title="新建组" onPress={createGroup} />}
                            <Button title="切换服务器" onPress={onBack} style={{ backgroundColor: '#334155' }} />
                        </View>
                    </View>
                    {/* Tabs */}
                    <View style={{ marginTop: 12, flexDirection: 'row', backgroundColor: '#0b1220', borderRadius: 10, borderWidth: 1, borderColor: '#334155' }}>
                        {['notes', 'files'].map(tab => (
                            <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: activeTab === tab ? '#4f46e5' : 'transparent' }}>
                                <Text style={{ color: 'white', textAlign: 'center', fontWeight: '600' }}>{tab === 'notes' ? '笔记' : '文件'}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>

                {activeTab === 'notes' ? (
                    <>
                        <View style={{ paddingHorizontal: 16 }}>
                            <TextInput placeholder='搜索组...' placeholderTextColor="#64748b" value={search} onChangeText={setSearch}
                                style={{ color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                        </View>
                        {data.tags?.length ? (
                            <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
                                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                    <View style={{ flexDirection: 'row', gap: 8 }}>
                                        {data.tags.map(tag => (
                                            <TouchableOpacity key={tag} onPress={() => toggleTag(tag)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9999, backgroundColor: selectedTags.has(tag) ? '#4f46e5' : '#334155', borderWidth: 1, borderColor: '#475569' }}>
                                                <Text style={{ color: 'white', fontSize: 12 }}>{tag}</Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </ScrollView>
                            </View>
                        ) : null}
                        <FlatList data={filteredGroups}
                            keyExtractor={(g) => g.id}
                            contentContainerStyle={{ padding: 16 }}
                            renderItem={({ item: g }) => (
                                <View style={{ padding: 14, backgroundColor: '#1e293b', borderRadius: 10, marginBottom: 12, borderColor: '#334155', borderWidth: 1 }}>
                                    <TouchableOpacity onPress={() => setSelectedGroup(g)}>
                                        <Text style={{ color: 'white', fontSize: 16, fontWeight: '600' }}>
                                            {g.title || '未命名组'} {String(g.id).startsWith('temp-group-') ? '（待同步）' : ''}
                                        </Text>
                                        <Text style={{ color: '#94a3b8', marginTop: 4 }}>{(g.entries || []).length} 条目</Text>
                                    </TouchableOpacity>
                                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
                                        <TouchableOpacity onPress={() => renameGroup(g)}><Text style={{ color: '#93c5fd' }}>编辑</Text></TouchableOpacity>
                                        <TouchableOpacity onPress={() => deleteGroup(g)}><Text style={{ color: '#ef4444' }}>删除</Text></TouchableOpacity>
                                    </View>
                                </View>
                            )}
                        />
                    </>
                ) : (
                    // Files tab
                    <View style={{ flex: 1, padding: 16 }}>
                        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                            <Button title={filesLoading ? '刷新中...' : '刷新列表'} onPress={loadFiles} disabled={filesLoading} />
                            <Button title="打开上传页面" onPress={() => Linking.openURL(`http://${server.host}:${server.port}/`)} style={{ backgroundColor: '#10b981' }} />
                        </View>
                        {filesLoading ? (
                            <View style={{ marginTop: 24 }}><ActivityIndicator color="#818cf8" /></View>
                        ) : (
                            <FlatList
                                data={files}
                                keyExtractor={(name) => name}
                                ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
                                renderItem={({ item: name }) => (
                                    <TouchableOpacity onPress={() => Linking.openURL(`http://${server.host}:${server.port}/uploads/${encodeURIComponent(name)}`)}
                                        style={{ backgroundColor: '#1f2937', borderWidth: 1, borderColor: '#334155', borderRadius: 10, padding: 12 }}>
                                        <Text style={{ color: 'white' }}>{name}</Text>
                                    </TouchableOpacity>
                                )}
                                ListEmptyComponent={<Text style={{ color: '#94a3b8' }}>暂无文件</Text>}
                            />
                        )}
                    </View>
                )}
                {groupModal.visible && (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
                        <View style={{ backgroundColor: '#0f172a', borderRadius: 12, padding: 16, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 12 }}>{groupModal.mode === 'edit' ? '编辑组' : '新建组'}</Text>
                            <TextInput autoFocus value={groupModal.title} onChangeText={(t) => setGroupModal(s => ({ ...s, title: t }))} placeholder={'组名称'} placeholderTextColor="#64748b"
                                style={{ color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                            <View style={{ height: 10 }} />
                            <TextInput value={groupModal.tags} onChangeText={(t) => setGroupModal(s => ({ ...s, tags: t }))} placeholder={'标签，逗号分隔（如：工作,学习）'} placeholderTextColor="#64748b"
                                style={{ color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                            <View style={{ height: 12 }} />
                            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                                <Button title="取消" onPress={() => setGroupModal({ visible: false, title: '', tags: '', mode: 'create', groupId: null })} style={{ backgroundColor: '#334155' }} />
                                <Button title="确定" onPress={confirmGroupModal} />
                            </View>
                        </View>
                    </View>
                )}
            </SafeAreaView>
        );
    }

    if (selectedGroup && !selectedEntry) {
        const group = data.groups.find(g => g.id === selectedGroup.id);
        const entryMap = new Map((group?.entries || []).map(e => [e.id, e]));
        const volumes = group?.volumes || [];
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
                <StatusBar style="light" />
                <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
                    <TouchableOpacity onPress={() => setSelectedGroup(null)}><Text style={{ color: '#93c5fd' }}>← 返回</Text></TouchableOpacity>
                    <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginLeft: 12 }}>{group?.title || '未命名组'}</Text>
                    <View style={{ marginLeft: 'auto' }}>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            <Button title="导出" onPress={() => Linking.openURL(`http://${server.host}:${server.port}/export?groupId=${encodeURIComponent(group.id)}`)} style={{ backgroundColor: '#10b981' }} />
                            <Button title="新建卷" onPress={() => createVolume(group)} style={{ backgroundColor: '#6366f1' }} />
                        </View>
                    </View>
                </View>
                <View style={{ padding: 16, paddingTop: 0, flex: 1 }}>
                    <DraggableFlatList
                        data={volumes}
                        keyExtractor={(item) => item.id}
                        nestedScrollEnabled
                        contentContainerStyle={{ paddingBottom: 24 }}
                        renderItem={({ item: vol, drag, isActive, index: vIdx }) => {
                            const collapsed = !!uiRef.current.collapsedVolumes[vol.id];
                            return (
                                <View style={{ marginBottom: 18, opacity: isActive ? 0.9 : 1 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <TouchableOpacity onLongPress={drag} onPress={() => {
                                            const next = { ...uiRef.current, collapsedVolumes: { ...uiRef.current.collapsedVolumes, [vol.id]: !collapsed } };
                                            uiRef.current = next; saveUI(server.host, server.port, next).catch(() => { });
                                            // force refresh by updating state unrelatedly (toggle via setData clone)
                                            setData(prev => JSON.parse(JSON.stringify(prev)));
                                        }}>
                                            <Text style={{ color: '#e2e8f0', fontSize: 16, fontWeight: '700' }}>{collapsed ? '▶ ' : '▼ '} {vol.title}</Text>
                                        </TouchableOpacity>
                                        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                                            <TouchableOpacity onPress={() => renameVolume(group, vol)}><Text style={{ color: '#93c5fd' }}>重命名</Text></TouchableOpacity>
                                            <TouchableOpacity onPress={() => createEntryInVolume(group.id, vol.id)}><Text style={{ color: '#10b981' }}>＋ 条目</Text></TouchableOpacity>
                                            <TouchableOpacity onPress={() => deleteVolume(group, vol)}><Text style={{ color: '#ef4444' }}>删除</Text></TouchableOpacity>
                                        </View>
                                    </View>
                                    {!collapsed && (
                                        <View style={{ marginTop: 8 }}>
                                            <DraggableFlatList
                                                activationDistance={8}
                                                autoscrollThreshold={24}
                                                scrollEnabled
                                                nestedScrollEnabled
                                                data={(vol.entryIds || []).map(id => entryMap.get(id)).filter(Boolean)}
                                                keyExtractor={(item) => item.id}
                                                renderItem={({ item: e, drag, isActive, getIndex }) => (
                                                    <View style={{ padding: 12, backgroundColor: '#1f2937', borderRadius: 10, marginBottom: 12, borderColor: '#334155', borderWidth: 1, opacity: isActive ? 0.9 : 1 }}>
                                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                            <TouchableOpacity onLongPress={drag} onPress={() => setSelectedEntry(e)} style={{ flex: 1 }}>
                                                                <Text style={{ color: 'white', fontWeight: '600' }}>≡ {e.title || '未命名条目'}{e.__pending ? '（待创建）' : ''}</Text>
                                                                <Text numberOfLines={2} style={{ color: '#94a3b8', marginTop: 6 }}>{(e.content || '').replace(/[#*_`>\\-]/g, ' ').slice(0, 140)}</Text>
                                                            </TouchableOpacity>
                                                            <TouchableOpacity onPress={() => setActionSheet({ visible: true, groupId: group.id, volumeId: vol.id, entryId: e.id })}>
                                                                <Text style={{ color: '#93c5fd', paddingHorizontal: 8, paddingVertical: 6 }}>⋯ 操作</Text>
                                                            </TouchableOpacity>
                                                        </View>
                                                    </View>
                                                )}
                                                onDragEnd={({ data }) => {
                                                    // 仅对该卷的真实 entryIds 进行重排；保留未显示（理论上已过滤掉）的条目在尾部
                                                    const picked = data.map(x => x.id);
                                                    lastReorderAt.current = Date.now();
                                                    setData(prev => {
                                                        const next = JSON.parse(JSON.stringify(prev));
                                                        const g = next.groups.find(x => x.id === group.id);
                                                        const vv = g?.volumes.find(v => v.id === vol.id);
                                                        if (vv) {
                                                            const current = Array.isArray(vv.entryIds) ? vv.entryIds : [];
                                                            const allow = new Set(current);
                                                            const filteredPicked = picked.filter(id => allow.has(id));
                                                            const remaining = current.filter(id => !filteredPicked.includes(id));
                                                            const merged = [...filteredPicked, ...remaining];
                                                            vv.entryIds = merged;
                                                            if (!String(group.id).startsWith('temp-group-')) {
                                                                send('reorder_entries', { groupId: group.id, volumeId: vol.id, newOrder: merged });
                                                            }
                                                            try { const ui = uiRef.current; ui.orders.entries[group.id] = ui.orders.entries[group.id] || {}; ui.orders.entries[group.id][vol.id] = [...merged]; uiRef.current = ui; saveUI(server.host, server.port, ui).catch(() => { }); } catch { }
                                                        }
                                                        saveData(server.host, server.port, next).catch(() => { });
                                                        return next;
                                                    });
                                                }}
                                            />
                                        </View>
                                    )}
                                </View>
                            );
                        }}
                        onDragEnd={({ from, to }) => onDragEndVolumes(group, from, to)}
                    />
                </View>
                {/* Floating New Entry Button */}
                <View style={{ position: 'absolute', right: 20, bottom: 28 }}>
                    <TouchableOpacity onPress={() => createEntry(group.id)} style={{ backgroundColor: '#4f46e5', width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8 }}>
                        <Text style={{ color: 'white', fontSize: 28, lineHeight: 28, marginTop: -2 }}>＋</Text>
                    </TouchableOpacity>
                </View>
                {moveDialog.visible && (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
                        <View style={{ backgroundColor: '#0f172a', borderRadius: 12, padding: 16, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 12 }}>移动到卷</Text>
                            {volumes.filter(v => v.id !== moveDialog.fromVolumeId).map(v => (
                                <TouchableOpacity key={v.id} onPress={() => confirmMoveToVolume(group, v.id)} style={{ paddingVertical: 10 }}>
                                    <Text style={{ color: '#e2e8f0' }}>{v.title}</Text>
                                </TouchableOpacity>
                            ))}
                            <View style={{ height: 8 }} />
                            <Button title="取消" onPress={() => setMoveDialog({ visible: false, entryId: null, fromVolumeId: null })} style={{ backgroundColor: '#334155' }} />
                        </View>
                    </View>
                )}
                {/* Entry Action Sheet */}
                {actionSheet.visible && (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
                        <View style={{ backgroundColor: '#0f172a', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 12, borderColor: '#334155', borderWidth: 1 }}>
                            {[
                                { key: 'edit', label: '编辑', onPress: () => { const e = (data.groups.find(g => g.id === actionSheet.groupId)?.entries || []).find(x => x.id === actionSheet.entryId); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); if (e) setSelectedEntry(e); } },
                                { key: 'before', label: '上方插入', onPress: () => { insertEntry(actionSheet.groupId, actionSheet.entryId, 'before'); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); } },
                                { key: 'after', label: '下方插入', onPress: () => { insertEntry(actionSheet.groupId, actionSheet.entryId, 'after'); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); } },
                                { key: 'clone', label: '克隆', onPress: () => { cloneEntry(actionSheet.groupId, actionSheet.entryId); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); } },
                                { key: 'move', label: '移动到…', onPress: () => { const g = data.groups.find(x => x.id === actionSheet.groupId); const v = g?.volumes?.find(x => x.id === actionSheet.volumeId); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); if (v) openMoveDialog(v, actionSheet.entryId); } },
                                { key: 'delete', label: '删除', danger: true, onPress: () => { const gId = actionSheet.groupId; const eId = actionSheet.entryId; const g = data.groups.find(x => x.id === gId); const e = g?.entries?.find(x => x.id === eId); setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }); if (e) deleteEntry(gId, e); } },
                                { key: 'cancel', label: '取消', onPress: () => setActionSheet({ visible: false, groupId: null, volumeId: null, entryId: null }) }
                            ].map(item => (
                                <TouchableOpacity key={item.key} onPress={item.onPress} style={{ paddingVertical: 14 }}>
                                    <Text style={{ color: item.danger ? '#ef4444' : 'white', textAlign: 'center', fontSize: 16 }}>{item.label}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                )}
                {/* Pick volume for new entry */}
                {pickVolume.visible && (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
                        <View style={{ backgroundColor: '#0f172a', borderRadius: 12, padding: 16, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 12 }}>选择要添加到的卷</Text>
                            {(group?.volumes || []).map(v => (
                                <TouchableOpacity key={v.id} onPress={() => { const gid = group.id; setPickVolume({ visible: false, groupId: null }); createEntryInVolume(gid, v.id); }} style={{ paddingVertical: 10 }}>
                                    <Text style={{ color: '#e2e8f0' }}>{v.title}</Text>
                                </TouchableOpacity>
                            ))}
                            <View style={{ height: 8 }} />
                            <Button title="取消" onPress={() => setPickVolume({ visible: false, groupId: null })} style={{ backgroundColor: '#334155' }} />
                        </View>
                    </View>
                )}
                {prompt.visible && (
                    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
                        <View style={{ backgroundColor: '#0f172a', borderRadius: 12, padding: 16, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 12 }}>{prompt.title}</Text>
                            <TextInput autoFocus value={prompt.value} onChangeText={(t) => setPrompt(p => ({ ...p, value: t }))} placeholder={prompt.placeholder} placeholderTextColor="#64748b"
                                style={{ color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                            <View style={{ height: 12 }} />
                            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                                <Button title="取消" onPress={() => setPrompt(p => ({ ...p, visible: false }))} style={{ backgroundColor: '#334155' }} />
                                <Button title="确定" onPress={() => { const v = prompt.value; const fn = prompt.onConfirm; setPrompt(p => ({ ...p, visible: false })); fn && fn(v); }} />
                            </View>
                        </View>
                    </View>
                )}
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
            <StatusBar style="light" />
            <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity onPress={() => { scheduleAutosave({ immediate: true }); if (editRef.current.saveTimer) { clearTimeout(editRef.current.saveTimer); editRef.current.saveTimer = null; } setSelectedEntry(null); }}><Text style={{ color: '#93c5fd' }}>← 返回</Text></TouchableOpacity>
                <TextInput value={title} onChangeText={(t) => { setTitle(t); editRef.current.lastTitleEditAt = Date.now(); scheduleAutosave(); }} placeholder='标题' placeholderTextColor="#64748b" onFocus={() => { editRef.current.titleFocused = true; }} onBlur={() => { editRef.current.titleFocused = false; scheduleAutosave({ immediate: true }); }}
                    style={{ marginLeft: 12, flex: 1, borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: 'white' }} />
                {/* autosave; no explicit Save button */}
            </View>
            <View style={{ padding: 12, flex: 1 }}>
                <TextInput value={content} selection={forcedSel || undefined} onSelectionChange={(e) => { const s = e?.nativeEvent?.selection; if (!editRef.current.isApplyingRemoteUpdate && s && typeof s.start === 'number' && typeof s.end === 'number') { caretRef.current = s; } }} onChangeText={(t) => { setContent(t); editRef.current.lastLocalEditAt = Date.now(); scheduleAutosave(); }} multiline textAlignVertical='top' placeholder='内容' scrollEnabled onFocus={() => { editRef.current.editorFocused = true; }} onBlur={() => { editRef.current.editorFocused = false; scheduleAutosave({ immediate: true }); }}
                    placeholderTextColor="#475569" style={{ flex: 1, color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 300 }} />
            </View>
        </SafeAreaView>
    );
}

export default function App() {
    const [server, setServer] = useState(null);
    if (!server) return <ServerPicker onSelected={(s) => setServer(s)} />;
    const handleBack = () => { saveSelectedServer(null).catch(() => { }); setServer(null); };
    return <NotesScreen server={server} onBack={handleBack} />;
}
