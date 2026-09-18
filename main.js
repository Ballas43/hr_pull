const express = require('express');
const cors = require('cors');
const path = require('path');
const osc = require('osc');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// State for multiple HR receivers
// Format: { [id]: { id: 'Player1', port: 9000, bpm: 0, percent: 0, timestamp: null, connected: false, lastUpdate: Date.now() } }
const devices = {};
const oscPorts = {}; // Holds the active OSC UDP listeners

// UDP Socket for broadcasting config to Backup servers
const syncSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
syncSocket.bind(8999, '0.0.0.0', () => {
    syncSocket.setBroadcast(true);
    syncSocket.setMulticastTTL(128);
    try { syncSocket.addMembership('239.255.0.1'); } catch(e) {}
});

let backupIp = null;
let lastBackupPing = 0;

syncSocket.on('message', (msg) => {
    try {
        const payload = JSON.parse(msg.toString());
        if (payload.action === 'backup_ping') {
            backupIp = payload.ip;
            lastBackupPing = Date.now();
        }
    } catch(e) {}
});

function broadcastConfig() {
    const payload = JSON.stringify({ action: 'sync', devices });
    const message = Buffer.from(payload);
    // Broadcast to multicast group on port 8999
    syncSocket.send(message, 0, message.length, 8999, '239.255.0.1', (err) => {
        if (err) console.error("[Main] Config broadcast error:", err);
    });
}

function startOscListener(device) {
    if (oscPorts[device.id]) return; // already listening

    const udpPort = new osc.UDPPort({
        localAddress: "0.0.0.0",
        localPort: parseInt(device.port),
        metadata: true
    });
    
    udpPort.on("ready", () => {
        try {
            if (udpPort.socket) {
                udpPort.socket.setBroadcast(true);
                udpPort.socket.setMulticastTTL(128);
                udpPort.socket.addMembership('239.255.0.1');
            }
        } catch(e) {}
    });

    udpPort.on("message", (oscMsg) => {
        let val = null;
        if (oscMsg.args && oscMsg.args.length > 0) {
            val = oscMsg.args[0].value;
        }

        if (val !== null) {
            // Handle specific OSC addresses sent by hr_push
            if (oscMsg.address.endsWith('hr_val')) {
                devices[device.id].bpm = val;
                devices[device.id].connected = true;
                devices[device.id].lastUpdate = Date.now();
                devices[device.id].timestamp = new Date().toISOString();
            } else if (oscMsg.address.endsWith('hr_percent')) {
                devices[device.id].percent = val;
            }
        }
    });

    udpPort.on("bundle", (oscBundle) => {
        console.log(`[Main] RAW OSC Bundle received on port ${device.port}:`, JSON.stringify(oscBundle));
    });

    udpPort.on("raw", (data) => {
        // Fallback for raw JSON over UDP
        try {
            const str = data.toString('utf8');
            if (str.startsWith('{') && str.includes('heart_rate')) {
                const parsed = JSON.parse(str);
                devices[device.id].bpm = parsed.heart_rate;
                devices[device.id].percent = parsed.percent || 0;
                devices[device.id].timestamp = parsed.timestamp || new Date().toISOString();
                devices[device.id].connected = true;
                devices[device.id].lastUpdate = Date.now();
            }
        } catch(e) {}
    });

    udpPort.on("error", (err) => {
        console.error(`[Main] OSC Error on port ${device.port}:`, err.message);
    });

    udpPort.open();
    oscPorts[device.id] = udpPort;
    console.log(`[Main] Started OSC listener for ${device.id} on port ${device.port}`);
}

function stopOscListener(deviceId) {
    if (oscPorts[deviceId]) {
        oscPorts[deviceId].close();
        delete oscPorts[deviceId];
        console.log(`[Main] Stopped OSC listener for ${deviceId}`);
    }
}

// --- API ROUTES ---

// Helper to calculate broadcast IP for the network
let cachedLocalIp = null;
function getLocalIp() {
    if (cachedLocalIp) return cachedLocalIp;
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                cachedLocalIp = iface.address;
                return cachedLocalIp;
            }
        }
    }
    return '127.0.0.1';
}

app.get('/api/network', (req, res) => {
    // If we haven't heard from backup in 10s, it's offline
    if (Date.now() - lastBackupPing > 10000) backupIp = null;
    res.json({ 
        broadcastIp: '239.255.0.1', 
        backupIp: backupIp,
        mainIp: getLocalIp()
    });
});

// API to get all devices for the dashboard
app.get('/api/devices', (req, res) => {
    res.json(Object.values(devices));
});

// API to spawn a new receiver
app.post('/api/devices', (req, res) => {
    const { id, port } = req.body;
    const portNum = parseInt(port);
    if (!id || isNaN(portNum)) {
        return res.status(400).json({ error: 'Device ID and Port are required' });
    }
    
    if (portNum < 9000 || portNum > 9050) {
        return res.status(400).json({ error: 'Port must be between 9000 and 9050' });
    }
    
    // Create if it doesn't exist
    if (!devices[id]) {
        devices[id] = { id, port: parseInt(port), bpm: 0, percent: 0, timestamp: null, connected: false, lastUpdate: Date.now() };
        startOscListener(devices[id]);
        saveConfig();
        broadcastConfig();
    }
    res.json(devices[id]);
});

// API to despawn a receiver
app.delete('/api/devices/:id', (req, res) => {
    const { id } = req.params;
    if (devices[id]) {
        stopOscListener(id);
        delete devices[id];
        saveConfig();
        broadcastConfig();
    }
    res.json({ success: true });
});

// Output route for OBS/vMix (Custom JSON)
app.get('/api/bpm/:id', (req, res) => {
    const { id } = req.params;
    if (devices[id]) {
        res.json(devices[id]);
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

// Periodic cleanup: mark devices offline if no data received for 5 seconds
setInterval(() => {
    const now = Date.now();
    for (const id in devices) {
        if (devices[id].connected && (now - devices[id].lastUpdate > 5000)) {
            devices[id].connected = false;
        }
    }
}, 2000);

// Periodically broadcast config to ensure backups stay perfectly in sync even if they join late
setInterval(broadcastConfig, 5000);

const CONFIG_FILE = path.join(__dirname, 'devices.json');

function saveConfig() {
    const dataToSave = {};
    for (const id in devices) {
        dataToSave[id] = { id: devices[id].id, port: devices[id].port };
    }
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2)); } catch(e) {}
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            for (const id in data) {
                devices[id] = { id: data[id].id, port: data[id].port, bpm: 0, percent: 0, timestamp: null, connected: false, lastUpdate: Date.now() };
                startOscListener(devices[id]);
            }
        }
    } catch(e) {}
}

// Load saved devices on boot
loadConfig();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Main] Server running on http://0.0.0.0:${PORT}`);
    console.log(`[Main] Dashboard accessible from other devices via your computer's local IP.`);
    console.log(`[Main] Broadcasting state sync to backup servers on UDP 8999...`);
});
