const bodyParser = require('body-parser');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = http.createServer(app);
const s = new WebSocket.Server({ server });
class LinkedLampGroup {
    constructor(name, client) {
        this.name = name;
        this.clients = [client];
        this.hue = 0;
    }
}
var groups = new Map();
var clients = new Map();

function setHue(increase, emitterGroup) {
    emitterGroup.hue += increase ? 1 : -1;
    if (emitterGroup.hue >= 256) {
        emitterGroup.hue = 0;
    } else if (emitterGroup.hue < 0) {
        emitterGroup.hue = 255;
    }
    console.log(`Hue on group ${emitterGroup.name} changed to ${emitterGroup.hue}`);
}

function onMessage(client, message) {
    if (message.substr(0, 5) == "AUTH:") {
        let groupName = message.substr(5);
        console.log("Received AUTH message for group " + groupName);
        var group;
        if (groups.has(groupName)) {
            group = groups.get(groupName);
            group.clients.push(client);
            console.log("Registered client on group " + groupName);
        }
        else {
            group = new LinkedLampGroup(groupName, client);
            groups.set(groupName, group);
            console.log("Created group " + groupName+ " and registered client");
        }
        clients.set(client, group);
        return;
    }
    if (!clients.has(client)) {
        return;
    }
    var emitterGroup = clients.get(client);
    console.log(`Received: ${message} from group ${emitterGroup.name}`);
    if (message == '+') {
        setHue(true, emitterGroup);
    } else if (message == '-') {
        setHue(false, emitterGroup);
    }
    console.log(`Broadcasting hue ${hue} to group ${emitterGroup.name}`);
    emitterGroup.clients.forEach((client) => {
        client.send(`${hue}`);
    });
}

function onDisconnection(ws) {
    console.log(`lost one client ${ws}`);
    let groupName = clients.get(ws).name;
    clients.delete(ws);
    groups.get(groupName).clients.splice();
}

function onConnection(ws) {
    console.log('new client connected');
    ws.on('message', (ws, message) => onMessage(ws, message));
    ws.on('close', () => onDisconnection(ws));
}

s.on('connection', (ws) => onConnection(ws));
server.listen(3000);
console.log(`server is listening on port 3000`);
