import http from 'http';
import type { CounterBridge } from '@counter-bridge/core';

export interface HealthServerConfig {
  port: number;
  bridge: CounterBridge;
}

export function createHealthServer(config: HealthServerConfig): http.Server {
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') {
      const stats = config.bridge.getStats();
      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        stats,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(config.port);
  return server;
}
