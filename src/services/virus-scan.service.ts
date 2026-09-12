import net from 'net';
import { ScannerUnavailableError } from '../types/exceptions';

export interface ScanResult {
  clean: boolean;
  /** clamd signature name when infected — for server-side logging only, never sent to a client. */
  signature?: string;
}

export interface IVirusScanService {
  /** True when VIRUS_SCAN_ENABLED === 'true'. Uploads are scanned only when enabled. */
  isEnabled(): boolean;
  /** Scan bytes via clamd INSTREAM. Resolves clean/infected; throws ScannerUnavailableError
   *  on connect failure, timeout, misconfiguration, or an unparseable response (fail closed). */
  scan(data: Buffer): Promise<ScanResult>;
}

/**
 * clamd (ClamAV daemon) client speaking the INSTREAM protocol over TCP.
 *
 * Reads config lazily at scan time so the server boots without a scanner present:
 *   VIRUS_SCAN_ENABLED   'true' to scan uploads (default off)
 *   CLAMD_HOST           clamd host
 *   CLAMD_PORT           clamd TCP port (default 3310)
 *   VIRUS_SCAN_TIMEOUT_MS per-scan timeout (default 10000)
 *
 * Every failure mode (unreachable, timeout, bad config, garbled reply) throws
 * ScannerUnavailableError so the caller can fail closed and never promote an
 * unscanned file.
 */
class ClamdVirusScanService implements IVirusScanService {
  isEnabled(): boolean {
    return process.env.VIRUS_SCAN_ENABLED === 'true';
  }

  scan(data: Buffer): Promise<ScanResult> {
    const host = process.env.CLAMD_HOST;
    const port = Number(process.env.CLAMD_PORT ?? 3310);
    const timeoutMs = Number(process.env.VIRUS_SCAN_TIMEOUT_MS) || 10_000;
    if (!host || !Number.isFinite(port) || port <= 0) {
      // Enabled but not configured → fail closed rather than silently skip.
      return Promise.reject(new ScannerUnavailableError());
    }

    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let response = '';
      let settled = false;

      const finish = (result: ScanResult | null, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(result as ScanResult);
      };

      const timer = setTimeout(() => finish(null, new ScannerUnavailableError()), timeoutMs);

      socket.on('connect', () => {
        // zINSTREAM: null-terminated command, then <4-byte BE length><data> chunks,
        // terminated by a zero-length chunk.
        socket.write('zINSTREAM\0');
        const CHUNK = 8192;
        for (let i = 0; i < data.length; i += CHUNK) {
          const slice = data.subarray(i, i + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(slice.length, 0);
          socket.write(size);
          socket.write(slice);
        }
        socket.write(Buffer.alloc(4)); // zero-length terminator
      });

      socket.on('data', (buf) => { response += buf.toString('utf8'); });

      socket.on('end', () => {
        const r = response.replace(/\0/g, '').trim(); // "stream: OK" | "stream: <sig> FOUND"
        if (/\bOK$/.test(r)) return finish({ clean: true });
        const m = r.match(/:\s*(.+?)\s+FOUND$/);
        if (m) return finish({ clean: false, signature: m[1] });
        finish(null, new ScannerUnavailableError()); // unexpected reply → fail closed
      });

      socket.on('error', () => finish(null, new ScannerUnavailableError()));
    });
  }
}

export const virusScanService: IVirusScanService = new ClamdVirusScanService();
