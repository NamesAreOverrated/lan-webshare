import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createWS } from './app/lib/wsClient';
import { loadData, saveData, loadQueue, pushOp, clearQueue, loadServerList, saveServerList, loadSelectedServer, saveSelectedServer } from './app/lib/storage';

function Button({ title, onPress, style }) {
    return (
        <TouchableOpacity onPress={onPress} style={[{ paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#4f46e5', borderRadius: 8 }, style]}>
            <Text style={{ color: 'white', fontWeight: '600', textAlign: 'center' }}>{title}</Text>
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
    const [online, setOnline] = useState(false);
    const [selectedGroup, setSelectedGroup] = useState(null);
    const [selectedEntry, setSelectedEntry] = useState(null);
    const wsRef = useRef(null);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let closed = false;
        (async () => {
            const cached = await loadData(server.host, server.port);
            if (cached && !closed) {
                setData(cached);
            }
            const ws = createWS({ host: server.host, port: server.port, onSync: async (payload) => { setData(payload); await saveData(server.host, server.port, payload); setLoading(false); }, onStatus: ({ online }) => setOnline(online) });
            wsRef.current = ws;
            setLoading(false);
        })();
        return () => { closed = true; wsRef.current?.close(); };
    }, [server.host, server.port]);

    const send = (type, payload) => {
        if (!wsRef.current) return;
        wsRef.current.send(type, payload);
    };

    const createGroup = () => {
        Alert.prompt?.('新建组', '输入组名', text => send('create_group', { title: text || '新建组', tags: [] })) || send('create_group', { title: '新建组', tags: [] });
    };

    const createEntry = (groupId) => {
        send('create_entry', { groupId });
    };

    const updateEntry = async (groupId, entryId, title, content) => {
        const updatedAt = new Date().toISOString();
        // send or queue
        send('update_entry', { groupId, entryId, title, content, updatedAt });
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

    const groups = useMemo(() => (data.groups || []).sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)), [data]);

    if (loading) {
        return <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' }}><ActivityIndicator color="#818cf8" /><StatusBar style="light" /></SafeAreaView>;
    }

    if (!selectedGroup) {
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
                <StatusBar style="light" />
                <View style={{ padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: '#e2e8f0', fontSize: 20, fontWeight: '700' }}>笔记（{online ? '在线' : '离线'}）</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Button title="新建组" onPress={createGroup} />
                        <Button title="切换服务器" onPress={onBack} style={{ backgroundColor: '#334155' }} />
                    </View>
                </View>
                <View style={{ paddingHorizontal: 16 }}>
                    <TextInput placeholder='搜索组...' placeholderTextColor="#64748b" value={search} onChangeText={setSearch}
                        style={{ color: 'white', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 }} />
                </View>
                <FlatList data={groups.filter(g => (g.title || '').toLowerCase().includes(search.toLowerCase()))}
                    keyExtractor={(g) => g.id}
                    contentContainerStyle={{ padding: 16 }}
                    renderItem={({ item: g }) => (
                        <TouchableOpacity onPress={() => setSelectedGroup(g)} style={{ padding: 14, backgroundColor: '#1e293b', borderRadius: 10, marginBottom: 12, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontSize: 16, fontWeight: '600' }}>{g.title || '未命名组'}</Text>
                            <Text style={{ color: '#94a3b8', marginTop: 4 }}>{(g.entries || []).length} 条目</Text>
                        </TouchableOpacity>
                    )}
                />
            </SafeAreaView>
        );
    }

    if (selectedGroup && !selectedEntry) {
        const group = data.groups.find(g => g.id === selectedGroup.id);
        const entryMap = new Map((group?.entries || []).map(e => [e.id, e]));
        const volumes = group?.volumes || [];
        const orderedIds = volumes.flatMap(v => v.entryIds || []);
        const entries = orderedIds.map(id => entryMap.get(id)).filter(Boolean);
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
                <StatusBar style="light" />
                <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
                    <TouchableOpacity onPress={() => setSelectedGroup(null)}><Text style={{ color: '#93c5fd' }}>← 返回</Text></TouchableOpacity>
                    <Text style={{ color: 'white', fontSize: 18, fontWeight: '700', marginLeft: 12 }}>{group?.title || '未命名组'}</Text>
                    <View style={{ marginLeft: 'auto' }}>
                        <Button title="新建条目" onPress={() => createEntry(group.id)} />
                    </View>
                </View>
                <FlatList data={entries}
                    keyExtractor={(e) => e.id}
                    contentContainerStyle={{ padding: 16 }}
                    renderItem={({ item: e }) => (
                        <TouchableOpacity onPress={() => setSelectedEntry(e)} style={{ padding: 12, backgroundColor: '#1f2937', borderRadius: 10, marginBottom: 12, borderColor: '#334155', borderWidth: 1 }}>
                            <Text style={{ color: 'white', fontWeight: '600' }}>{e.title || '未命名条目'}</Text>
                            <Text numberOfLines={2} style={{ color: '#94a3b8', marginTop: 6 }}>{(e.content || '').replace(/[#*_`>\-]/g, ' ').slice(0, 140)}</Text>
                        </TouchableOpacity>
                    )}
                />
            </SafeAreaView>
        );
    }

    const group = data.groups.find(g => g.id === selectedGroup?.id);
    const entry = group?.entries.find(e => e.id === selectedEntry?.id);
    const [title, setTitle] = useState(entry?.title || '');
    const [content, setContent] = useState(entry?.content || '');
    useEffect(() => { setTitle(entry?.title || ''); setContent(entry?.content || ''); }, [entry?.id]);

    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#0f172a' }}>
            <StatusBar style="light" />
            <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity onPress={() => setSelectedEntry(null)}><Text style={{ color: '#93c5fd' }}>← 返回</Text></TouchableOpacity>
                <TextInput value={title} onChangeText={setTitle} placeholder='标题' placeholderTextColor="#64748b"
                    style={{ marginLeft: 12, flex: 1, borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: 'white' }} />
                <View style={{ marginLeft: 8 }}>
                    <Button title="保存" onPress={() => updateEntry(group.id, entry.id, title, content)} />
                </View>
            </View>
            <View style={{ padding: 12, flex: 1 }}>
                <TextInput value={content} onChangeText={setContent} multiline textAlignVertical='top' placeholder='内容'
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
