const net = require('net');

function checkPort(port) {
  return new Promise(resolve => {
    const s = net.createConnection(port, '127.0.0.1', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  if (await checkPort(9150)) {
    process.stdout.write('9150');
  } else if (await checkPort(9050)) {
    process.stdout.write('9050');
  } else {
    process.stdout.write('0');
  }
}

main();
