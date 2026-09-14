import type { ServerResponse } from 'node:http';
import pg from 'pg';

/** Notifications invalidate browser snapshots; reconnect always fetches authoritative state. */
export class Events {
  private streams = new Set<ServerResponse>();
  private client?: pg.Client;
  private retry?: NodeJS.Timeout;
  private closed = false;
  constructor(private url: string) {}
  async start() {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.url, connectionTimeoutMillis: 5000 });
    this.client = client;
    const disconnected = () => {
      if (this.client !== client || this.closed) return;
      this.client = undefined;
      void client.end().catch(() => {});
      this.broadcast('resync');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => {
        void this.start();
      }, 2000);
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', () => this.broadcast('changed'));
    try {
      await client.connect();
      await client.query('LISTEN studio_updates');
      this.broadcast('resync');
    } catch {
      disconnected();
    }
  }
  add(stream: ServerResponse) {
    this.streams.add(stream);
    stream.write('event: resync\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      if (!stream.write(': heartbeat\n\n')) stream.destroy();
    }, 15000);
    stream.on('close', () => {
      clearInterval(heartbeat);
      this.streams.delete(stream);
    });
  }
  private broadcast(event: string) {
    for (const stream of this.streams)
      if (!stream.write(`event: ${event}\ndata: {}\n\n`)) stream.destroy();
  }
  async stop() {
    this.closed = true;
    clearTimeout(this.retry);
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await this.client?.end().catch(() => {});
  }
}
