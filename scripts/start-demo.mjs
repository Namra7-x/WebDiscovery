import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(__dirname, '../demo');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[Demo Server] ${req.method} ${url.pathname}`);

  // Mock Feature Flag Endpoint
  if (url.pathname === '/api/feature-flags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      "enable_admin": false,
      "beta_dashboard": false,
      "show_billing": false
    }));
    return;
  }

  // Serve static files from demo/
  let filePath = path.join(demoDir, url.pathname === '/' ? 'demo.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeMap = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.map': 'application/json',
    '.css': 'text/css'
  };

  res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
});

const PORT = 8888;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 DeepScope Demo Playground running at:`);
  console.log(`   http://localhost:${PORT}/demo.html`);
  console.log(`======================================================`);
  console.log(`Open Chrome, go to http://localhost:${PORT}/demo.html`);
  console.log(`Press F12 -> DeepScope tab to see ALL 6 features in action!`);
  console.log(`Press Ctrl+C to stop.`);
});
