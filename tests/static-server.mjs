import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';

const root = resolve(process.cwd(), 'dist/site');
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(requestUrl.pathname);
      const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const file = resolve(root, `.${relativePath}`);
      if (file !== root && !file.startsWith(`${root}${normalize('/')}`)) {
        response.writeHead(400).end('bad path');
        return;
      }
      const bytes = await readFile(file);
      response
        .writeHead(200, { 'content-type': mimeTypes.get(extname(file)) ?? 'application/octet-stream' })
        .end(bytes);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('STATIC_SERVER_UNAVAILABLE');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
