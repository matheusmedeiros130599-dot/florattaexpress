const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Prevent development server from crashing on uncaught errors or aborted requests
process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', reason => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const PORT = 8000;

// Read credentials from .env file, fall back to known keys if missing
const dotenv = {};
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length > 1) {
      dotenv[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
}
const ZUCKPAY_CLIENT_ID = process.env.ZUCKPAY_CLIENT_ID || dotenv.ZUCKPAY_CLIENT_ID || 'matheusmedeiros130599_2781149172';
const ZUCKPAY_CLIENT_SECRET = process.env.ZUCKPAY_CLIENT_SECRET || dotenv.ZUCKPAY_CLIENT_SECRET || 'e2df3cd0c85ea4570627bb3699c57245281de3ecafe195e59a90f747a86ec7d3';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// Helper for making requests to ZuckPay API
function zuckRequest(method, path, payloadObj = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(ZUCKPAY_CLIENT_ID + ":" + ZUCKPAY_CLIENT_SECRET).toString('base64');
    const options = {
      hostname: 'www.zuckpay.com.br',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth
      }
    };
    
    let bodyData = '';
    if (payloadObj) {
      bodyData = JSON.stringify(payloadObj);
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }
    
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: responseBody });
        }
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    if (payloadObj) {
      req.write(bodyData);
    }
    req.end();
  });
}

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);

  req.on('error', err => console.error('Client Request error:', err));
  res.on('error', err => console.error('Client Response error:', err));

  // 1. Intercept ZuckPay creation endpoint
  if (req.url === '/api/pix/create' && req.method === 'POST') {
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());
        
        // ZuckPay payload structure
        const zuckPayload = {
          nome: body.nome || 'Cliente',
          cpf: body.cpf || '12345678909',
          valor: body.totalReais || (body.totalCents / 100),
          email: body.email || 'teste@floratta.site',
          telefone: body.tel || '11999999999',
          descricao: 'Pedido Floratta - ' + (body.externalRef || 'Loja'),
          external_id_client: body.externalRef || ('FL-' + Date.now())
        };
        
        console.log(`[ZuckPay] Requesting Pix creation for ${zuckPayload.nome} (Value: R$ ${zuckPayload.valor.toFixed(2)})`);
        const zuckRes = await zuckRequest('POST', '/conta/v3/pix/qrcode', zuckPayload);
        
        if (zuckRes.statusCode === 200 && zuckRes.data && zuckRes.data.transactionId) {
          console.log(`[ZuckPay] Created successfully: ${zuckRes.data.transactionId}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            transactionId: zuckRes.data.transactionId,
            pixCode: zuckRes.data.qrcode
          }));
        } else {
          console.error("[ZuckPay] Create error response:", zuckRes);
          res.writeHead(zuckRes.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: zuckRes.data?.message || 'Erro do gateway ZuckPay' }));
        }
      } catch (err) {
        console.error("Error processing /api/pix/create:", err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
      }
    });
    return;
  }

  // 2. Intercept ZuckPay status consult endpoint
  if (req.url.startsWith('/api/pix/status/') && req.method === 'GET') {
    const parts = req.url.split('/');
    const txId = parts[parts.length - 1];
    
    (async () => {
      try {
        console.log(`[ZuckPay] Consulting status for transaction: ${txId}`);
        const zuckRes = await zuckRequest('GET', `/conta/v3/pix/status?transactionId=${txId}`);
        
        if (zuckRes.statusCode === 200 && zuckRes.data) {
          console.log(`[ZuckPay] Status response: ${zuckRes.data.status}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            raw: zuckRes.data,
            paid: zuckRes.data.status === 'PAID'
          }));
        } else {
          console.error("[ZuckPay] Status check error response:", zuckRes);
          res.writeHead(zuckRes.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: zuckRes.data?.message || 'Erro ao consultar status' }));
        }
      } catch (err) {
        console.error("Error processing /api/pix/status:", err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
      }
    })();
    return;
  }

  // 3. Serve static files
  let safeUrl = req.url.split('?')[0];
  if (safeUrl === '/') {
    safeUrl = '/index.html';
  }

  // Resolve file path
  const filePath = path.join(__dirname, safeUrl);
  
  // Verify file is within directory (security check)
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado localmente.');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) {
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Servidor local Floratta Express (ZuckPay) ativo!`);
  console.log(`URL local: http://localhost:${PORT}`);
  console.log(`Gateway Integrado: ZuckPay`);
  console.log(`==================================================`);
});
