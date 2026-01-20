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
    message = message.toString();
    if (message.substr(0, 5) == "AUTH:") {
        if (message.length == 5) {
            console.log("Received empty auth");
            return;
        }
        let groupName = message.substr(5).toLowerCase();
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
            console.log("Created group " + groupName + " and registered client");
        }
        clients.set(client, group);
        client.send(`${group.hue}`)
        return;
    }
    if (!clients.has(client)) {
        return;
    }
    var emitterGroup = clients.get(client);
    console.log(`${message} hue for group ${emitterGroup.name}`);
    if (message == '+') {
        setHue(true, emitterGroup);
    } else if (message == '-') {
        setHue(false, emitterGroup);
    }
    console.log(`Broadcasting hue ${emitterGroup.hue} to group ${emitterGroup.name}`);
    emitterGroup.clients.forEach((client) => {
        client.send(`${emitterGroup.hue}`);
    });
}

function onDisconnection(ws) {
    console.log(`Client disconnected  ${ws}`);
    if (clients.has(ws)) {
        let groupName = clients.get(ws).name;
        clients.delete(ws);
        groups.get(groupName).clients = groups.get(groupName).clients.filter(c => c !== ws);
    }
}

function onConnection(ws) {
    console.log(`Client connected  ${ws}`);
    ws.on('message', (message) => onMessage(ws, message));
    ws.on('close', () => onDisconnection(ws));
}

s.on('connection', (ws) => onConnection(ws));
server.listen(3000);
console.log(`server is listening on port 3000`);
