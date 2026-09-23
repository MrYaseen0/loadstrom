const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const fs = require('fs');

function fetch(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

function testProxy(proxy) {
  return new Promise(r => {
    try {
      const url = new URL(proxy);
      const host = url.hostname;
      const port = Number(url.port);
      if (!host || !port || port < 1 || port > 65535) {
        r({ proxy, ok: false });
        return;
      }
      const s = net.createConnection({ host, port }, () => {
        s.destroy();
        r({ proxy, ok: true });
      });
      s.on('error', () => { s.destroy(); r({ proxy, ok: false }); });
      s.setTimeout(3000, () => { s.destroy(); r({ proxy, ok: false }); });
    } catch (e) {
      r({ proxy, ok: false });
    }
  });
}

function testProxyTarget(proxy, target) {
  return new Promise(r => {
    const start = Date.now();
    const url = new URL(proxy);
    const targetUrl = new URL(target);
    // SOCKS5 proxies can't be tested with HTTP CONNECT — validate the
    // SOCKS5 handshake (greeting) over TCP instead. Full target fetch via
    // SOCKS is covered by server POST /api/test-proxy.
    if ((url.protocol || '').toLowerCase().startsWith('socks')) {
      const s = net.createConnection({ host: url.hostname, port: Number(url.port) || 1080 }, () => {
        s.write(Buffer.from([0x05, 0x01, 0x00]));
        s.once('data', (d) => {
          s.destroy();
          if (d && d[0] === 0x05 && d[1] !== 0xff) r({ ok: true, ms: Date.now() - start, status: 'SOCKS5-handshake', size: 0 });
          else r({ ok: false, ms: Date.now() - start, error: 'SOCKS5 handshake rejected' });
        });
      });
      s.on('error', (e) => { s.destroy(); r({ ok: false, ms: Date.now() - start, error: e.code || e.message }); });
      s.setTimeout(5000, () => { s.destroy(); r({ ok: false, ms: Date.now() - start, error: 'socks timeout' }); });
      return;
    }
    const opts = {
      hostname: url.hostname,
      port: Number(url.port),
      timeout: 8000,
      method: 'CONNECT',
      path: targetUrl.hostname + ':443'
    };
    const req = http.request(opts);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        r({ ok: false, ms: Date.now() - start, error: 'CONNECT ' + res.statusCode });
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
        rejectUnauthorized: true
      }, () => {
        const req2 = https.request({
          socket: tlsSocket,
          hostname: targetUrl.hostname,
          port: 443,
          path: '/',
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html'
          }
        }, res2 => {
          let d = '';
          res2.on('data', c => d += c);
          res2.on('end', () => {
            tlsSocket.destroy();
            r({ ok: true, ms: Date.now() - start, status: res2.statusCode, size: d.length });
          });
        });
        req2.on('error', e => {
          tlsSocket.destroy();
          r({ ok: false, ms: Date.now() - start, error: e.code || e.message });
        });
        req2.setTimeout(6000, () => {
          req2.destroy();
          r({ ok: false, ms: Date.now() - start, error: 'request timeout' });
        });
        req2.end();
      });
      tlsSocket.on('error', e => {
        r({ ok: false, ms: Date.now() - start, error: e.code || e.message });
      });
      tlsSocket.setTimeout(6000, () => {
        tlsSocket.destroy();
        r({ ok: false, ms: Date.now() - start, error: 'tls timeout' });
      });
    });
    req.on('error', e => {
      r({ ok: false, ms: Date.now() - start, error: e.code || e.message });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      r({ ok: false, ms: Date.now() - start, error: 'connect timeout' });
    });
    req.end();
  });
}

async function fetchFromSources() {
  const allProxies = [];

  const sources = [
    {
      name: 'ProxyScrape HTTP Elite',
      url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite',
      parse: (raw) => raw.split('\n').map(l => l.trim()).filter(l => l && l.includes(':')).map(l => l.startsWith('http') ? l : 'http://' + l)
    },
    {
      name: 'ProxyScrape HTTP',
      url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
      parse: (raw) => raw.split('\n').map(l => l.trim()).filter(l => l && l.includes(':')).map(l => l.startsWith('http') ? l : 'http://' + l)
    },
    {
      name: 'ProxyScrape SOCKS5',
      url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all',
      parse: (raw) => raw.split('\n').map(l => l.trim()).filter(l => l && l.includes(':')).map(l => l.startsWith('socks') ? l : 'socks5://' + l)
    }
  ];

  for (const src of sources) {
    try {
      process.stdout.write('  ' + src.name + ' ... ');
      const raw = await fetch(src.url);
      const proxies = src.parse(raw);
      console.log(proxies.length + ' found');
      allProxies.push(...proxies);
    } catch (e) {
      console.log('Error: ' + e.message);
    }
  }

  return [...new Set(allProxies)];
}

async function main() {
  const target = process.argv[2] || 'https://example.com';

  console.log('============================================================');
  console.log('PROXY FINDER & TESTER');
  console.log('============================================================');
  console.log('');
  console.log('Target: ' + target);
  console.log('');

  console.log('Step 1: Fetching proxies from free sources...');
  const proxies = await fetchFromSources();
  console.log('  Total: ' + proxies.length + ' unique proxies');
  console.log('');

  console.log('Step 2: Testing connectivity...');
  const connectivityResults = await Promise.all(proxies.slice(0, 50).map(testProxy));
  const reachable = connectivityResults.filter(r => r.ok);
  console.log('  Reachable: ' + reachable.length + '/' + Math.min(50, proxies.length));
  console.log('');

  if (reachable.length === 0) {
    console.log('No reachable proxies found.');
    console.log('');
    console.log('For blocked sites like cecos.edu.pk, you need residential proxies:');
    console.log('  1. Bright Data  - brightdata.com/residential-proxy');
    console.log('  2. Smartproxy   - smartproxy.com/residential-proxy');
    console.log('  3. IPRoyal      - iproyal.com/residential-proxy');
    console.log('  4. Proxy-Seller - proxy-seller.com');
    return;
  }

  console.log('Step 3: Testing against ' + target + '...');
  const targetResults = [];
  for (const p of reachable) {
    process.stdout.write('  ' + p.proxy + ' ... ');
    const r = await testProxyTarget(p.proxy, target);
    targetResults.push({ ...r, proxy: p.proxy });
    if (r.ok) {
      console.log('OK (HTTP ' + r.status + ', ' + r.size + 'B, ' + r.ms + 'ms)');
    } else {
      console.log('FAIL (' + r.error + ')');
    }
  }
  console.log('');

  const working = targetResults.filter(r => r.ok);
  console.log('============================================================');
  console.log('RESULTS: ' + working.length + ' proxies can reach ' + target);
  console.log('============================================================');

  if (working.length > 0) {
    console.log('');
    console.log('Working proxies:');
    working.forEach((w, i) => {
      console.log('  ' + (i + 1) + '. ' + w.proxy + ' -> HTTP ' + w.status + ' (' + w.size + 'B, ' + w.ms + 'ms)');
    });

    const config = {
      proxyList: working.map(w => w.proxy)
    };

    console.log('');
    console.log('Strom Fire config:');
    console.log(JSON.stringify(config, null, 2));

    fs.writeFileSync('proxy-list.json', JSON.stringify(config, null, 2));
    console.log('');
    console.log('Saved to proxy-list.json');
  } else {
    console.log('');
    console.log('No working proxies for this target.');
    console.log('The site likely blocks datacenter IPs.');
    console.log('Use residential proxies instead.');
  }
}

main().catch(console.error);
