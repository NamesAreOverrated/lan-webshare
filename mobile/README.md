# LAN WebShare Mobile (Expo SDK 53)

A lightweight mobile client for browsing and editing notes with offline cache and WebSocket sync to the LAN server.

- Server picker: choose IP/port of the running LAN server (no "local machine" option on mobile)
- Offline first: cached data stored with AsyncStorage, edits queued while offline
- Sync: when online, queued ops are flushed; server broadcasts full_sync to update all devices

## Run

1. In a terminal:
   - cd mobile
   - npm install
   - npm start
2. Open Expo Go on your device and scan the QR code.

## Notes

- Ensure your phone and server are on the same network and the server's port is accessible.
- Replace icons in assets/ as needed.
