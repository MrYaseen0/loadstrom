// Prints the Tor control port to use: the derived port when it answers as a
// Tor control port, else the alternate when *it* answers (mixed-pair hosts,
// e.g. SOCKS 9050 + control 9151), else the derived port (caller warns;
// the engine then surfaces its specific control-port error at rotation time).
// Usage: node check-tor-control.js <derived> [alternate]
// A 515 reply counts as alive: cookie-auth control ports reject empty
// AUTHENTICATE with 515, which still proves a Tor control port is there.
const net = require('net');

function torControlAlive(port, ms = 2000) {
  return new Promise((resolve) => {
    let done = false;
    let data = '';
    const s = net.createConnection(Number(port), '127.0.0.1', () => {
      s.write('AUTHENTICATE\r\n');
    });
    const fin = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(v);
    };
    s.on('data', (c) => {
      data += c.toString();
      if (/250|515|5\d\d/.test(data)) fin(true);
    });
    s.on('error', () => fin(false));
    s.setTimeout(ms, () => fin(false));
  });
}

async function pickControlPort(derived, alternate) {
  if (await torControlAlive(derived)) return String(derived);
  if (alternate && String(alternate) !== String(derived) && await torControlAlive(alternate)) {
    return String(alternate);
  }
  return String(derived);
}

if (require.main === module) {
  (async () => {
    const derived = process.argv[2];
    const alternate = process.argv[3];
    if (!derived) {
      console.error('Usage: node check-tor-control.js <derived> [alternate]');
      process.exit(2);
    }
    process.stdout.write(await pickControlPort(derived, alternate));
  })().catch(() => process.stdout.write(String(process.argv[2] || '')));
}

module.exports = { torControlAlive, pickControlPort };
