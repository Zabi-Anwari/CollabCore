import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

console.log('WebSocket server started on port 8080');

const clients = new Map();

function broadcastUserList() {
  const users = Array.from(clients.values()).filter(u => u);
  const message = JSON.stringify({ type: 'user-list', users });
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

wss.on('connection', function connection(ws) {
  ws.on('error', console.error);

  ws.on('close', () => {
    if (clients.has(ws)) {
      clients.delete(ws);
      broadcastUserList();
    }
  });

  ws.on('message', function message(data, isBinary) {
    let parsed = null;
    try {
      const str = isBinary ? data.toString() : data;
      parsed = JSON.parse(str);
    } catch (e) {
      // ignore
    }

    if (parsed && parsed.type === 'join' && parsed.user) {
      clients.set(ws, parsed.user);
      broadcastUserList();
    } else {
      // Broadcast to all other clients
      wss.clients.forEach(function each(client) {
        if (client !== ws && client.readyState === 1) { // 1 = OPEN
          // Re-send the data exactly as received
          client.send(data, { binary: isBinary });
        }
      });
    }
  });
});
