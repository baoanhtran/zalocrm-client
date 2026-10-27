/**
 * zalo-proxy.test.ts — proxy từng nick phải THẬT SỰ được dùng.
 * Trước đây proxy-util chỉ đặt env HTTP_PROXY quanh lúc login; fetch của Node 20 và thư viện
 * ws không đọc env đó → mọi nick vẫn đi IP của VPS. zca-js chỉ đi qua proxy khi nhận
 * `agent` (WebSocket listener) + `polyfill` fetch có proxy (mọi request HTTP).
 * Test dựng proxy CONNECT thật trên localhost, không cần Internet.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { buildZaloProxyOptions } from '../src/modules/zalo/proxy-util.js';
import { createZaloClient } from '../src/modules/zalo/zalo-client-factory.js';

let target: http.Server;
let wss: WebSocketServer;
let proxy: http.Server;
let targetPort = 0;
let proxyUrl = '';
const tunnels: Array<{ host: string; auth: string | undefined }> = [];

beforeAll(async () => {
  target = http.createServer((_req, res) => {
    res.setHeader('set-cookie', ['zpsid=abc; Expires=Wed, 18 Mar 2026 10:00:00 GMT; Path=/', 'zpw_sek=xyz; Path=/']);
    res.end('ok-from-target');
  });
  wss = new WebSocketServer({ server: target });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  targetPort = (target.address() as AddressInfo).port;

  proxy = http.createServer((_req, res) => { res.statusCode = 405; res.end(); });
  proxy.on('connect', (req, clientSocket: net.Socket, head) => {
    tunnels.push({ host: req.url ?? '', auth: req.headers['proxy-authorization'] });
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  // Mật khẩu có ký tự @ (viết %40 trong URL) — đúng kiểu proxy bán ở VN hay có.
  proxyUrl = `http://user:p%40ss@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(() => {
  wss.close();
  target.closeAllConnections();
  proxy.closeAllConnections();
  target.close();
  proxy.close();
});

beforeEach(() => {
  tunnels.length = 0;
});

describe('buildZaloProxyOptions', () => {
  it('request HTTP của zca-js (polyfill) đi qua proxy, kèm đăng nhập proxy', async () => {
    const { polyfill } = buildZaloProxyOptions(proxyUrl);
    expect(polyfill).toBeTypeOf('function');
    const res = await polyfill!(`http://127.0.0.1:${targetPort}/api`, { method: 'GET' });
    expect(await res.text()).toBe('ok-from-target');
    expect(tunnels).toEqual([{ host: `127.0.0.1:${targetPort}`, auth: 'Basic dXNlcjpwQHNz' }]);
  });

  it('giữ nguyên từng Set-Cookie (zca-js cần getSetCookie để không mất zpsid/zpw_sek)', async () => {
    const { polyfill } = buildZaloProxyOptions(proxyUrl);
    const res = await polyfill!(`http://127.0.0.1:${targetPort}/login`, {});
    await res.text();
    expect(res.headers.getSetCookie()).toEqual([
      'zpsid=abc; Expires=Wed, 18 Mar 2026 10:00:00 GMT; Path=/',
      'zpw_sek=xyz; Path=/',
    ]);
  });

  it('WebSocket nhận tin (listener zca-js dùng agent) đi qua proxy', async () => {
    const { agent } = buildZaloProxyOptions(proxyUrl);
    const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws`, { agent });
    await once(ws, 'open');
    ws.send('hi');
    const [msg] = await once(ws, 'message');
    ws.close();
    expect(String(msg)).toBe('echo:hi');
    expect(tunnels).toEqual([{ host: `127.0.0.1:${targetPort}`, auth: 'Basic dXNlcjpwQHNz' }]);
  });

  it('proxy hỏng (socks5 / chuỗi rác) → KHÔNG âm thầm đi thẳng IP VPS: request của nick báo lỗi', async () => {
    for (const bad of ['socks5://1.2.3.4:1080', 'không-phải-url']) {
      const { polyfill } = buildZaloProxyOptions(bad);
      await expect(polyfill!(`http://127.0.0.1:${targetPort}/api`, {})).rejects.toThrow(/proxy/i);
    }
    expect(tunnels).toEqual([]);
  });

  it('nick không cấu hình proxy → không gắn gì, zca-js dùng fetch mặc định', () => {
    expect(buildZaloProxyOptions(null)).toEqual({});
    expect(buildZaloProxyOptions(undefined)).toEqual({});
    expect(buildZaloProxyOptions('   ')).toEqual({});
  });
});

// zca-js chép `client.options` vào context lúc login → mọi request HTTP dùng options.polyfill,
// listener WebSocket dùng options.agent.
describe('createZaloClient — client zca-js của nick', () => {
  it('nick có proxy: HTTP và WebSocket của client đều đi qua proxy đó', async () => {
    const client = createZaloClient(proxyUrl);
    const res = await client.options.polyfill(`http://127.0.0.1:${targetPort}/api`, {});
    expect(await res.text()).toBe('ok-from-target');

    const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws`, { agent: client.options.agent });
    await once(ws, 'open');
    ws.close();

    expect(tunnels).toEqual([
      { host: `127.0.0.1:${targetPort}`, auth: 'Basic dXNlcjpwQHNz' },
      { host: `127.0.0.1:${targetPort}`, auth: 'Basic dXNlcjpwQHNz' },
    ]);
  });

  it('nick không proxy: không gắn polyfill/agent (zca-js tự dùng fetch mặc định)', () => {
    const client = createZaloClient(null);
    expect(client.options.polyfill).toBeUndefined();
    expect(client.options.agent).toBeUndefined();
    expect(client.options.selfListen).toBe(true);
  });
});
