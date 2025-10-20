const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Winreg = require('winreg');

const app = express();

function getCefPortFromRegistry() {
  return new Promise((resolve, reject) => {
    const regKey = new Winreg({
      hive: Winreg.HKCU,
      key: '\\Software\\RAGE-MP'
    });

    regKey.get('launch.cefPort', (err, item) => {
      if (err) {
        reject(new Error(`Failed to read registry key: ${err.message}`));
      } else {
        const port = parseInt(item.value, 10);
        if (isNaN(port)) {
          reject(new Error(`Invalid port value in registry: ${item.value}`));
        } else {
          resolve(port);
        }
      }
    });
  });
}

let config = { serverPort: 3000 };
try {
  const configData = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  const fileConfig = JSON.parse(configData);
  config.serverPort = fileConfig.serverPort || 3000;
} catch (err) {
  console.log('Using default server port: 3000');
}

let cefDebuggingPort = null;

async function initializeCefPort() {
  try {
    cefDebuggingPort = await getCefPortFromRegistry();
    console.log(`✓ CEF debugging port loaded from registry: ${cefDebuggingPort}`);
  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    console.error(`\nRegistry path: HKEY_CURRENT_USER\\Software\\RAGE-MP`);
    console.error(`Registry key: launch.cefPort`);
    console.error(`\nPlease ensure RAGE:MP is installed and configured correctly.\n`);
    process.exit(1);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    cefDebuggingPort: cefDebuggingPort,
    serverPort: config.serverPort
  });
});

app.get('/api/cef-targets', async (req, res) => {
  if (!cefDebuggingPort) {
    return res.status(400).json({
      success: false,
      error: 'CEF debugging port not available'
    });
  }

  const timestamp = Date.now();
  const url = `http://localhost:${cefDebuggingPort}/json/list?t=${timestamp}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    res.json({ success: true, targets: data });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      details: 'Make sure RAGE:MP is running with CEF debugging enabled'
    });
  }
});

app.get('/devtools/*', async (req, res) => {
  if (!cefDebuggingPort) {
    return res.status(400).send('CEF debugging port not available');
  }

  const devtoolsPath = req.path;
  const url = `http://localhost:${cefDebuggingPort}${devtoolsPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');

    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    const body = await response.buffer();
    res.send(body);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

async function startServer() {
  await initializeCefPort();

  const PORT = config.serverPort || 3000;
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`RAGE:MP CEF Debugging Server Started`);
    console.log(`========================================`);
    console.log(`Server running at: http://localhost:${PORT}`);
    console.log(`CEF debugging port: ${cefDebuggingPort}`);
    console.log(`========================================\n`);
  });
}

startServer();
