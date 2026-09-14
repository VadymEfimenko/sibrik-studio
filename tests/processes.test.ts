import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

it('runs API and worker in separate processes, delivering completion through PostgreSQL SSE', async () => {
  const port = await freePort();
  const callbackPort = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    CALLBACK_PORT: String(callbackPort),
    WORKER_EMBEDDED: 'false',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
  };
  const children: ChildProcess[] = [];
  let processErrors = '';
  function launch(path: string) {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', path], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      processErrors += String(chunk).slice(0, 1000);
    });
    children.push(child);
    return child;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    const api = launch('src/server/main.ts');
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
      } catch {
        /* startup */
      }
      if (api.exitCode !== null) throw new Error(processErrors);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, processErrors).toBe(true);
    const stream = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('resync');
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        modelId: 'seedance-2.5',
        prompt: 'Separate process integration check',
        duration: 5,
        resolution: '480p',
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    launch('src/server/worker-main.ts');
    let completed = false;
    while (!completed) {
      const event = await reader.read();
      expect(event.done).toBe(false);
      const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      const job = state.jobs.find((job: { id: string }) => job.id === created.id);
      if (job.status === 'failed' || job.status === 'timed_out') throw new Error(job.errorMessage);
      if (job.status === 'completed') {
        expect(job.actualDurationSeconds).toBe(4.5);
        expect(job.chargedMilli).toBe(12825);
        expect(job.releasedMilli).toBe(4275);
        const media = await fetch(`http://127.0.0.1:${port}${job.videoUrl}`, {
          headers: { Range: 'bytes=0-63' },
        });
        expect(media.status).toBe(206);
        expect((await media.arrayBuffer()).byteLength).toBe(64);
        completed = true;
      }
    }
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }),
    );
  }
}, 25000);
