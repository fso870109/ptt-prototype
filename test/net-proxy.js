'use strict';
// 本機 WebSocket 代理：可注入延遲與隨機丟棄二進位音訊封包，用來模擬弱網路。
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

function startWsProxy({ target, delayMs = 0, dropBin = 0, listen = 0 } = {}) {
  const stats = { up: 0, down: 0, dropped: 0, delayed: 0 };
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server, path: '/ws' });

  function fwd(from, to, dir) {
    from.on('message', (data, isBinary) => {
      if (isBinary && dropBin > 0 && Math.random() < dropBin) { stats.dropped++; return; }
      const send = () => { if (to.readyState === 1) to.send(data, { binary: isBinary }); };
      if (dir === 'down') stats.down++; else stats.up++;
      if (delayMs > 0) { stats.delayed++; setTimeout(send, delayMs); } else send();
    });
    from.on('close', () => { try { to.close(); } catch {} });
    from.on('error', () => { try { to.close(); } catch {} });
  }

  wss.on('connection', (client) => {
    const queued = [];
    const onEarly = (data, isBinary) => queued.push([data, isBinary]);
    client.on('message', onEarly);
    const up = new WebSocket(target);
    up.on('open', () => {
      client.off('message', onEarly);
      for (const [data, isBinary] of queued) {
        if (isBinary && dropBin > 0 && Math.random() < dropBin) { stats.dropped++; continue; }
        stats.up++;
        const send = () => { if (up.readyState === 1) up.send(data, { binary: isBinary }); };
        if (delayMs > 0) { stats.delayed++; setTimeout(send, delayMs); } else send();
      }
      fwd(client, up, 'up');
      fwd(up, client, 'down');
    });
    up.on('error', () => { try { client.close(); } catch {} });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(listen, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, stats,
        url: 'ws://127.0.0.1:' + port + '/ws',
        close() { return new Promise(r => server.close(r)); }
      });
    });
  });
}

module.exports = { startWsProxy };
