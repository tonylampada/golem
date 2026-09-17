import { createServer, type Server } from 'node:http';
import { shellPlaceholder } from './shell-placeholder.ts';

// The CLI owns logging and signals; replace the response here for the real shell.
export function startDevServer(port = 3000): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(shellPlaceholder);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
