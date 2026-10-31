// Run the browser checks with a temporary static server, or WQV_APP_URL.
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
// Node 24 lacks this flag; newer Node releases may expose Web Storage to
// browser-test dependencies. Probe the CLI rather than assuming a version.
const nodeOptions = spawnSync(process.execPath, ['--no-webstorage', '--version'], { stdio: 'ignore' }).status === 0 ? ['--no-webstorage'] : [];

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
function run(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeOptions, path.join(__dirname, file)], { cwd: repo, env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(file + ' failed: ' + (signal || code)));
    });
  });
}

(async () => {
  const available = (await fs.readdir(__dirname)).filter(file => file.endsWith('.cjs') && file !== 'run.cjs').sort();
  const files = process.argv.length > 2 ? process.argv.slice(2) : available;
  for (const file of files) if (!available.includes(file)) throw new Error('Unknown browser check: ' + file);
  const artifacts = process.env.WQV_BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'wqv-browser');
  let server, url = process.env.WQV_APP_URL;
  try {
    if (!url) {
      const port = await unusedPort(); url = 'http://127.0.0.1:' + port + '/';
      server = spawn('python3', [path.join(repo, 'serve.py'), '--port', String(port)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        let errors = '', output = '';
        const timer = setTimeout(() => reject(new Error('Static server did not start. ' + errors)), 5000);
        server.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
        server.stdout.on('data', chunk => {
          output = (output + chunk).slice(-256);
          if (output.includes('WQV WebUSB:')) { clearTimeout(timer); resolve(); }
        });
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.once('exit', code => { clearTimeout(timer); reject(new Error('Static server exited: ' + code + ' ' + errors)); });
      });
    }
    for (const file of files) {
      console.log('Browser check:', file);
      await run(file, { ...process.env, WQV_APP_URL: url, WQV_BROWSER_ARTIFACTS: path.join(artifacts, path.basename(file, '.cjs')) });
    }
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM'); await once(server, 'exit');
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
