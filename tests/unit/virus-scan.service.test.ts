/**
 * VirusScanService — socket-level INSTREAM tests.
 *
 * Drives the real clamd client against a local net.createServer stub (no external
 * deps). Asserts the wire framing (zINSTREAM command, 4-byte big-endian chunk
 * length prefixes, zero-length terminator) and every reply path, incl. fail-closed
 * on garbled reply and abrupt socket close.
 */
import { describe, it, beforeAll, afterEach, expect } from '@jest/globals';
import net from 'net';
import { virusScanService } from '../../src/services/virus-scan.service';
import { ScannerUnavailableError } from '../../src/types/exceptions';

/** Parse the INSTREAM bytes clamd would receive: "zINSTREAM\0" then <len><data>... <0>. */
function parseInstream(buf: Buffer): { command: string; chunkLengths: number[]; terminated: boolean } {
  const nul = buf.indexOf(0);
  if (nul < 0) return { command: '', chunkLengths: [], terminated: false };
  const command = buf.subarray(0, nul).toString('ascii');
  let off = nul + 1;
  const chunkLengths: number[] = [];
  let terminated = false;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    if (len === 0) { terminated = true; break; }
    if (off + len > buf.length) break;
    chunkLengths.push(len);
    off += len;
  }
  return { command, chunkLengths, terminated };
}

interface Stub {
  port: number;
  received: () => Buffer;
  close: () => Promise<void>;
}

/** Fake clamd. behavior.reply → send it once the stream terminates; behavior.closeEarly → destroy the socket. */
async function fakeClamd(behavior: { reply?: string; closeEarly?: boolean }): Promise<Stub> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (parseInstream(all).terminated) {
        if (behavior.closeEarly) socket.destroy();
        else socket.end(behavior.reply ?? '');
      }
    });
    socket.on('error', () => { /* client reset — ignore */ });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => Buffer.concat(chunks),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

const DATA = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(20000, 0x41)]); // ~20KB → multiple chunks

beforeAll(() => {
  process.env.CLAMD_HOST = '127.0.0.1';
  process.env.VIRUS_SCAN_TIMEOUT_MS = '3000';
});

afterEach(() => {
  delete process.env.CLAMD_PORT;
});

describe('VirusScanService.scan — clamd INSTREAM over a socket stub', () => {
  it('clean file: "stream: OK" → { clean: true }, and wire framing is correct', async () => {
    const stub = await fakeClamd({ reply: 'stream: OK\0' });
    process.env.CLAMD_PORT = String(stub.port);
    try {
      const res = await virusScanService.scan(DATA);
      expect(res).toEqual({ clean: true });

      // Framing: zINSTREAM command, 4-byte BE length prefixes summing to the payload, zero-length terminator.
      const parsed = parseInstream(stub.received());
      expect(parsed.command).toBe('zINSTREAM');
      expect(parsed.terminated).toBe(true);
      expect(parsed.chunkLengths.length).toBeGreaterThan(1); // 20KB → several 8KB chunks
      expect(parsed.chunkLengths.reduce((a, b) => a + b, 0)).toBe(DATA.length);
    } finally {
      await stub.close();
    }
  });

  it('infected file: "stream: <sig> FOUND" → { clean: false, signature }', async () => {
    const stub = await fakeClamd({ reply: 'stream: Eicar-Test-Signature FOUND\0' });
    process.env.CLAMD_PORT = String(stub.port);
    try {
      const res = await virusScanService.scan(DATA);
      expect(res.clean).toBe(false);
      expect(res.signature).toBe('Eicar-Test-Signature');
    } finally {
      await stub.close();
    }
  });

  it('garbled reply → fail closed (ScannerUnavailableError)', async () => {
    const stub = await fakeClamd({ reply: 'wat is this\0' });
    process.env.CLAMD_PORT = String(stub.port);
    try {
      await expect(virusScanService.scan(DATA)).rejects.toBeInstanceOf(ScannerUnavailableError);
    } finally {
      await stub.close();
    }
  });

  it('abrupt socket close (no reply) → fail closed (ScannerUnavailableError)', async () => {
    const stub = await fakeClamd({ closeEarly: true });
    process.env.CLAMD_PORT = String(stub.port);
    try {
      await expect(virusScanService.scan(DATA)).rejects.toBeInstanceOf(ScannerUnavailableError);
    } finally {
      await stub.close();
    }
  });

  it('unconfigured host/port → fail closed without connecting', async () => {
    delete process.env.CLAMD_PORT;
    const prevHost = process.env.CLAMD_HOST;
    delete process.env.CLAMD_HOST;
    try {
      await expect(virusScanService.scan(DATA)).rejects.toBeInstanceOf(ScannerUnavailableError);
    } finally {
      process.env.CLAMD_HOST = prevHost;
    }
  });
});
