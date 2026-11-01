// HTTPS mit eigener CA (docs/API.md, Erweiterung 3)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from '../server.js';

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpsGet(url, ca) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

describe('HTTPS mit eigener Zertifizierungsstelle', { skip: !hasOpenssl() && 'openssl fehlt' }, () => {
  let dir;
  let app;
  let httpBase;
  let httpsPort;
  const tlsHosts = ['localhost', '127.0.0.1'];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-https-'));
    httpsPort = await freePort();
    app = createServer({ dataDir: dir, httpsPort, tlsHosts, log: () => {} });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    await new Promise((r) => app.httpsServer.listen(httpsPort, '127.0.0.1', r));
    httpBase = `http://127.0.0.1:${app.server.address().port}`;
  });

  after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('erzeugt CA und Serverzertifikat mit SAN für alle Hosts', () => {
    const tlsDir = path.join(dir, 'tls');
    for (const f of ['ca.key', 'ca.crt', 'server.key', 'server.crt', 'hosts.txt']) {
      assert.ok(fs.existsSync(path.join(tlsDir, f)), f + ' fehlt');
    }
    const ca = new crypto.X509Certificate(fs.readFileSync(path.join(tlsDir, 'ca.crt')));
    assert.equal(ca.ca, true);
    assert.match(ca.subject, /Boobo Zuhause CA/);
    const srv = new crypto.X509Certificate(fs.readFileSync(path.join(tlsDir, 'server.crt')));
    assert.equal(srv.ca, false);
    assert.match(srv.subjectAltName, /DNS:localhost/);
    assert.match(srv.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.ok(srv.checkIssued(ca), 'Serverzertifikat ist nicht von der CA ausgestellt');
    const days = (new Date(srv.validTo) - new Date(srv.validFrom)) / 86400000;
    assert.ok(days > 800 && days <= 825, 'Laufzeit ' + days);
  });

  test('antwortet über https mit der eigenen CA als Vertrauensanker', async () => {
    const ca = fs.readFileSync(path.join(dir, 'tls', 'ca.crt'));
    const res = await httpsGet(`https://127.0.0.1:${httpsPort}/api/health`, ca);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.https.enabled, true);
    assert.equal(body.https.port, httpsPort);
    assert.deepEqual(body.https.hosts, []);
    assert.equal(body.https.ca_url, '/boobo-ca.crt');
    assert.equal(body.https.ca_name, 'Boobo Zuhause CA');
  });

  test('liefert das CA-Zertifikat über http zum Download', async () => {
    const res = await fetch(httpBase + '/boobo-ca.crt');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.match(res.headers.get('content-disposition'), /boobo-ca\.crt/);
    const pem = await res.text();
    assert.match(pem, /-----BEGIN CERTIFICATE-----/);
  });

  test('verwendet vorhandene Zertifikate wieder und erneuert nur bei neuen Hosts', async () => {
    const tlsDir = path.join(dir, 'tls');
    const caBefore = fs.readFileSync(path.join(tlsDir, 'ca.crt'), 'utf8');
    const srvBefore = fs.readFileSync(path.join(tlsDir, 'server.crt'), 'utf8');

    const again = createServer({ dataDir: dir, httpsPort, tlsHosts, log: () => {} });
    await again.close();
    assert.equal(fs.readFileSync(path.join(tlsDir, 'server.crt'), 'utf8'), srvBefore, 'unverändert bei gleichen Hosts');

    const changed = createServer({ dataDir: dir, httpsPort, tlsHosts: [...tlsHosts, '192.168.0.124', 'nas.local'], log: () => {} });
    await changed.close();
    assert.equal(fs.readFileSync(path.join(tlsDir, 'ca.crt'), 'utf8'), caBefore, 'CA bleibt stabil');
    const srvAfter = new crypto.X509Certificate(fs.readFileSync(path.join(tlsDir, 'server.crt')));
    assert.match(srvAfter.subjectAltName, /IP Address:192\.168\.0\.124/);
    assert.match(srvAfter.subjectAltName, /DNS:nas\.local/);
    assert.equal(fs.readFileSync(path.join(tlsDir, 'hosts.txt'), 'utf8').trim(), 'localhost,127.0.0.1,192.168.0.124,nas.local');
  });

  test('HTTPS_PORT=0 schaltet HTTPS ab, http bleibt', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-nohttps-'));
    const off = createServer({ dataDir: d2, httpsPort: 0, log: () => {} });
    await new Promise((r) => off.server.listen(0, '127.0.0.1', r));
    try {
      assert.equal(off.httpsServer, null);
      const base = `http://127.0.0.1:${off.server.address().port}`;
      const health = await (await fetch(base + '/api/health')).json();
      assert.deepEqual(health.https, { enabled: false });
      assert.equal((await fetch(base + '/boobo-ca.crt')).status, 404);
      assert.ok(!fs.existsSync(path.join(d2, 'tls')));
    } finally {
      await off.close();
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});
