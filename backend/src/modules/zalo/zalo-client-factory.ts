// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * zalo-client-factory.ts — tạo instance zca-js `Zalo` cho 1 nick.
 *
 * Tách khỏi zalo-pool.ts để test được pool: zca-js nạp qua require CJS nên vi.mock
 * không chặn được nếu để trong pool.
 *
 * Note: zca-js is imported via createRequire because its TypeScript
 * declarations don't expose named exports in ESM mode.
 */
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import { imageSize } from 'image-size';
import { buildZaloProxyOptions, type ZaloProxyOptions } from './proxy-util.js';

// zca-js has no reliable ESM type exports — load via CJS interop
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Zalo } = require('zca-js') as { Zalo: new (opts: { logging: boolean; selfListen?: boolean; imageMetadataGetter?: (path: string) => Promise<{ width: number; height: number; size: number }> } & ZaloProxyOptions) => any };

async function imageMetadataGetter(filePath: string) {
  const data = await readFile(filePath);
  const info = imageSize(data);
  if (!info.width || !info.height) throw new Error(`Cannot read image size: ${filePath}`);
  return { width: info.width, height: info.height, size: data.length };
}

/** Proxy của nick (nếu có) áp cho MỌI request HTTP + WebSocket của client — xem proxy-util.ts. */
export function createZaloClient(proxyUrl?: string | null): any {
  return new Zalo({ logging: false, selfListen: true, imageMetadataGetter, ...buildZaloProxyOptions(proxyUrl) });
}
