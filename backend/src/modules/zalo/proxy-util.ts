// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * Proxy utility for Zalo SDK connections — option proxy truyền vào `new Zalo()` của 1 nick.
 *
 * 2026-10-28: trước đây đặt env HTTP_PROXY/HTTPS_PROXY quanh lúc login. fetch của Node 20 và
 * thư viện ws KHÔNG đọc env đó → mọi nick vẫn đi IP của VPS dù đã cấu hình proxy. zca-js chỉ
 * đi qua proxy khi nhận:
 *   - `agent`    → WebSocket listener (ws) mở tunnel CONNECT qua proxy
 *   - `polyfill` → fetch cho MỌI request HTTP của zca-js. Dùng fetch của undici + ProxyAgent
 *                  để giữ đúng hành vi fetch mặc định (Headers.getSetCookie — zca-js cần để
 *                  không mất cookie zpsid/zpw_sek lúc login).
 * Chỉ hỗ trợ proxy http/https (route lưu proxy đã chặn kiểu khác).
 */
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

export interface ZaloProxyOptions {
  agent?: Agent;
  polyfill?: typeof fetch;
}

export function buildZaloProxyOptions(proxyUrl: string | null | undefined): ZaloProxyOptions {
  const url = proxyUrl?.trim();
  if (!url) return {};

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // xử lý chung bên dưới
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    // KHÔNG âm thầm đi thẳng IP VPS: mọi request của nick báo lỗi → nick không kết nối được,
    // lỗi hiện ở luồng login như lỗi mạng thường. Không ném ở đây vì caller tạo client ngoài try.
    const err = new Error('Proxy của nick không hợp lệ (chỉ hỗ trợ http/https) — sửa lại proxy của nick');
    return { polyfill: (() => Promise.reject(err)) as typeof fetch };
  }

  const dispatcher = new ProxyAgent(url);
  return {
    agent: new HttpsProxyAgent(url),
    polyfill: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      })) as unknown as typeof fetch,
  };
}
