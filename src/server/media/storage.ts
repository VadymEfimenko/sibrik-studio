import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { get, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { secondsToMicros } from '../billing/money.js';
import { ProviderError } from '../errors.js';
import type { ProviderResult } from '../providers/types.js';

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Only global-unicast IPv6; excludes loopback, private/link-local and mapped IPv4.
  return /^[23][0-9a-f]{3}:/i.test(address);
}

async function assertPublicHttps(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new ProviderError('invalid_video_url', 'Некоректне посилання на відео.');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new ProviderError('invalid_video_host', 'Недопустима адреса відео.');
  return { url, address: addresses[0] };
}

export async function download(url: string, path: string, maximumBytes = 200 * 1024 * 1024) {
  const signal = AbortSignal.timeout(60000);
  let next = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const { url: checkedUrl, address } = await assertPublicHttps(next);
    // Pin the validated address while preserving HTTPS Host/SNI. No second DNS lookup.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        signal,
        family: address.family,
        autoSelectFamily: false,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      };
      const request = get(checkedUrl, options, resolve);
      request.on('error', reject);
    });
    const status = response.statusCode || 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('Missing redirect');
      next = new URL(location, next).href;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Download returned HTTP ${status}`);
    }
    const size = Number(response.headers['content-length']);
    if (size > maximumBytes) {
      response.destroy();
      throw new Error('Media exceeds the size limit');
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > maximumBytes ? new Error('Media exceeds the size limit') : null, chunk);
      },
    });
    await pipeline(response, limiter, createWriteStream(path, { flags: 'wx' }), { signal });
    return;
  }
  throw new Error('Too many redirects');
}

export async function probeVideo(path: string, ffprobePath: string): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_type,duration:format=duration',
        '-of',
        'json',
        path,
      ],
      { shell: false, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 65536) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`ffprobe failed (${code ?? signal}): ${stderr.slice(0, 200)}`)),
    );
  });
  const media = JSON.parse(output) as {
    streams?: { codec_type?: string; duration?: string }[];
    format?: { duration?: string };
  };
  if (!media.streams?.length || media.streams[0].codec_type !== 'video')
    throw new Error('Result contains no video stream');
  const streamDuration = media.streams[0].duration;
  const duration =
    streamDuration && streamDuration !== 'N/A' ? streamDuration : media.format?.duration;
  if (typeof duration !== 'string') throw new Error('Video duration is unavailable');
  return secondsToMicros(duration);
}

export async function storeVideo(
  result: ProviderResult,
  storageDir: string,
  jobId: string,
  leaseToken: string,
  ffprobePath: string,
  outputFormat: 'mp4' | 'mov' = 'mp4',
) {
  await mkdir(storageDir, { recursive: true });
  const filename = `${jobId}-${leaseToken}.${outputFormat}`;
  const temporary = join(storageDir, `${filename}.part`);
  const final = join(storageDir, filename);
  try {
    if (result.source.kind === 'file') await copyFile(result.source.path, temporary);
    else await download(result.source.url, temporary);
    const info = await stat(temporary);
    if (info.size === 0 || info.size > 200 * 1024 * 1024)
      throw new Error('Invalid video file size');
    const durationMicros = await probeVideo(temporary, ffprobePath);
    await rename(temporary, final);
    return {
      resultFile: filename,
      durationMicros,
      providerCostUsd: result.costUsd,
      providerCreditsCost: result.creditsCost,
    };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function removeUncommittedVideo(storageDir: string, filename: string) {
  await unlink(join(storageDir, filename)).catch(() => {});
}
