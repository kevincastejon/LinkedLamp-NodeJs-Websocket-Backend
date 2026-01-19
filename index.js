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
let hue = 0;

function setHue(increase) {
  hue += increase ? 1 : -1;
  if (hue >= 256) {
    hue = 0;
  } else if (hue < 0) {
    hue = 255;
  }
  console.log(`hue changed to ${hue}`);
}

function onMessage(message) {
  console.log(`Received: ${message}`);
  if (message == '+') {
    setHue(true);
  } else if (message == '-') {
    setHue(false);
  }
  console.log(`broadcasting hue ${hue}`);
  s.clients.forEach((client) => {
    client.send(`${hue}`);
  });
}

function onDisconnection(ws) {
  console.log(`lost one client ${ws}`);
}

function onConnection(ws) {
  console.log('new client connected');
  ws.on('message', (message) => onMessage(message));
  ws.on('close', () => onDisconnection(ws));
  ws.send(`${hue}`);
}

s.on('connection', (ws) => onConnection(ws));
server.listen(3000);
console.log(`server is listening on port 3000`);
