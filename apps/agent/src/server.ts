import net from 'node:net';
import type { Dispatch } from './dispatch';

export const MAX_LINE_BYTES = 64 * 1024;

export function createAgentServer(dispatch: Dispatch, maxLineBytes = MAX_LINE_BYTES): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let buffer = '';

    const handleLine = async (line: string) => {
      for await (const message of dispatch(line)) {
        if (socket.destroyed) return;
        socket.write(JSON.stringify(message) + '\n');
      }
    };

    socket.on('data', (data: string) => {
      buffer += data;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void handleLine(line);
      }
      if (buffer.length > maxLineBytes) {
        const error = {
          id: null,
          ok: false,
          error: { code: 'request_too_large', message: 'Request is too large.' },
        };
        socket.end(JSON.stringify(error) + '\n');
      }
    });
  });
}
