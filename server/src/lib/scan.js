import net from 'node:net';
import config from '../config.js';
import logger from './logger.js';

/**
 * Optional ClamAV scanning over clamd's INSTREAM protocol. Disabled unless
 * CLAMAV_HOST is set; when enabled, an infected file is rejected before it is
 * written to disk and an audit-friendly error is returned.
 */
export const isScannerEnabled = () => Boolean(config.security.clamavHost);

export function scanBuffer(buffer) {
  if (!isScannerEnabled()) return Promise.resolve({ scanned: false, clean: true });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.security.clamavHost, port: config.security.clamavPort });
    const chunks = [];

    const finish = (err, result) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    socket.setTimeout(10_000, () => finish(new Error('clamd timed out')));
    socket.on('error', (err) => finish(err));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(buffer.length);
      socket.write(size);
      socket.write(buffer);
      socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
    socket.on('end', () => {
      const answer = Buffer.concat(chunks).toString('utf8').trim();
      if (/FOUND/.test(answer)) return finish(null, { scanned: true, clean: false, signature: answer });
      if (/OK/.test(answer)) return finish(null, { scanned: true, clean: true });
      logger.warn({ answer }, 'unexpected clamd response');
      return finish(null, { scanned: true, clean: true });
    });
  });
}
