# HR Pull

> [!WARNING]
> **Disclaimer:** This project contains some AI-generated code. It was built with the assistance of an AI coding agent. If an AI-generated project doesn't align with your preferences, feel free to fork and modify it. This project is open-source and available under the MIT license.

A highly resilient, multicast-powered Node.js dashboard and failover relay server for the HR Push OSC project. Designed not only for individual VRChat and OBS streamers, but built to scale for massive esports tournaments and large-scale vMix productions that demand absolute zero downtime for their heart rate displays.

## Overview

This project acts as a central networking hub between your stream overlays and any device running HR Push (including Apple Watch, WearOS, or any standard Bluetooth Low Energy (BLE) heart rate monitor). It provides a beautiful, modern web dashboard to spawn independent UDP listeners, manage devices, and expose simple JSON APIs that vMix or OBS can consume. Because the dashboard is network-accessible and mobile-responsive, esports League Ops or production crews can easily spawn and manage player devices from a phone or tablet while on stage or backstage.

Most importantly, it features a **Peer-to-Peer Failover** architecture. By using UDP Multicast, the primary server constantly syncs state to a secondary backup server (e.g., a Raspberry Pi). If the main server crashes or reboots, the backup server seamlessly takes over, ensuring your heart rate never freezes on stream.

## Features

- **Dynamic OSC Listeners:** Spawn and despawn listeners on the fly from the web UI.
- **Glassmorphism Dashboard:** A modern, responsive web UI with Dark/Light modes synced to your OS.
- **Multicast Syncing:** Bypasses aggressive router firewalls by multicasting state to `239.255.0.1`.
- **Peer-to-Peer Backup:** A lightweight `backup.js` script that echoes the heartbeat if the main server goes offline.
- **State Persistence:** Automatically saves your active device listeners to disk, surviving server restarts.

## Installation

```bash
git clone <your-repo-url>
cd hr-pull
npm install
```

## Usage

### Main Server (Your Broadcasting PC)
Run the main hub on the computer running vMix or OBS:
```bash
npm run start:main
```
Open your browser to `http://<MAIN SERVER IP>:3000` to access the dashboard. From there, you can enter a Device ID (e.g. `Player1`) and a UDP port (e.g. `9000`) and click **Spawn Receiver**. 

Point your watch's HR Push app to stream OSC to your Main Server IP on port that you've set like `9000` like `127.0.0.1:9000`. The dashboard will immediately show your live BPM!

### Backup Server (Optional, e.g., Raspberry Pi)
Run the backup script on a different device on the same local network:
```bash
npm run start:backup
```
The dashboard on the Main Server will automatically detect the Backup Server and display its IP. The backup server silently mirrors all active listeners and caches the latest BPM. You can write a simple VB.NET script in vMix to pull from the Backup API if the Main API times out.

## Security Warning ⚠️
To achieve absolute zero-latency for live broadcasting, **this project does not use encryption**. All OSC UDP packets, Multicast sync data, and HTTP API JSON endpoints are transmitted in raw plaintext over your network. 

Because heart rate data is considered sensitive health information, you must ensure that your streaming PC and the mobile device/watch are connected to a **private, isolated, and password-protected Local Area Network (LAN)** (which is standard practice for esports and live productions). Do not run this over public venue WiFi.

## API Endpoints

Once a device is spawned (e.g., `Player1`), the server exposes raw JSON endpoints for your overlays:

- **Main Server API:** `http://<MAIN SERVER IP>:3000/api/bpm/Player1`
- **Backup Server API:** `http://<BACKUP SERVER IP>:3001/api/bpm/Player1`

Response format:
```json
{
  "id": "Player1",
  "port": 9000,
  "bpm": 85,
  "lastUpdate": 1715629482390,
  "connected": true
}
```

## Acknowledgements & Disclaimer

This project relies on and is built as a companion tool for the original **[HR Push](https://github.com/Ero-Cat/hr_push/)** project. A huge thank you to the original creators for building the watch app that makes this possible!

## Legal

**Disclaimer:** 
- **No Affiliation:** HR Pull is an independent, community-driven project and is **not associated, affiliated, endorsed, or sponsored** by the creators of the original HR Push project.

## License
MIT License.
