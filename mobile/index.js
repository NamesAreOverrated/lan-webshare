import 'react-native-gesture-handler';
import 'react-native-reanimated';
import { registerRootComponent } from 'expo';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import App from './App';

function Root() {
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <App />
        </GestureHandlerRootView>
    );
}

registerRootComponent(Root);
