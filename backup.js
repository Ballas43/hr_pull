const express = require('express');
const cors = require('cors');
const osc = require('osc');
const dgram = require('dgram');
const os = require('os');

const app = express();
app.use(cors());

// State mirrored from the Main server
let devices = {};
const oscPorts = {};

function startOscListener(device) {
    if (oscPorts[device.id]) return;

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
        } catch (e) { }
    });

    udpPort.on("message", (oscMsg) => {
        let val = null;
        if (oscMsg.args && oscMsg.args.length > 0) {
            val = oscMsg.args[0].value;
        }

        if (val !== null && devices[device.id]) {
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

    udpPort.on("error", (err) => {
        console.error(`[Backup] OSC Error on port ${device.port}:`, err.message);
    });

    udpPort.open();
    oscPorts[device.id] = udpPort;
    console.log(`[Backup] Started OSC listener for ${device.id} on port ${device.port}`);
}

function stopOscListener(deviceId) {
    if (oscPorts[deviceId]) {
        oscPorts[deviceId].close();
        delete oscPorts[deviceId];
        console.log(`[Backup] Stopped OSC listener for ${deviceId}`);
    }
}

// --- Sync Listener ---
const syncSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

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

// Ping Main server with our IP so it can show it in the dashboard
setInterval(() => {
    const payload = JSON.stringify({ action: 'backup_ping', ip: getLocalIp() });
    const message = Buffer.from(payload);
    syncSocket.send(message, 0, message.length, 8999, '239.255.0.1');
}, 3000);

syncSocket.on('message', (msg) => {
    try {
        const payload = JSON.parse(msg.toString());
        if (payload.action === 'sync' && payload.devices) {
            const newDevices = payload.devices;

            // Start listeners for new devices
            for (const id in newDevices) {
                if (!devices[id]) {
                    startOscListener(newDevices[id]);
                }
            }

            // Stop listeners for removed devices
            for (const id in devices) {
                if (!newDevices[id]) {
                    stopOscListener(id);
                }
            }

            // Update the state (merging to preserve local bpm states if we received them recently)
            for (const id in newDevices) {
                if (!devices[id]) devices[id] = newDevices[id];
                else {
                    // Just update config details
                    devices[id].port = newDevices[id].port;
                }
            }

            // Remove deleted devices from local state
            for (const id in devices) {
                if (!newDevices[id]) {
                    delete devices[id];
                }
            }
        }
    } catch (e) {
        console.error("[Backup] Failed to parse sync message", e);
    }
});

syncSocket.on('listening', () => {
    const address = syncSocket.address();
    try { syncSocket.addMembership('239.255.0.1'); } catch (e) { }
    console.log(`[Backup] Listening for Main Server sync on UDP port ${address.port}...`);
});

syncSocket.bind(8999, '0.0.0.0');

// --- API ROUTES ---

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

const PORT = process.env.PORT || 3000; // default to 3001 for backup if running on same machine
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Backup] Server running on http://0.0.0.0:${PORT}`);
    console.log(`[Backup] API endpoint active. Awaiting configuration from Main Server.`);
});
