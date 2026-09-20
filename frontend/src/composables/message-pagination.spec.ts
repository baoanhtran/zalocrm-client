// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
import { describe, it, expect } from 'vitest';
import { mergeOlderMessages, shouldLoadOlder, olderPageOffset } from './message-pagination';

interface M { id: string; n: number }
const cmp = (a: M, b: M) => a.n - b.n;
const m = (id: string, n: number): M => ({ id, n });

describe('mergeOlderMessages', () => {
  it('ghép tin cũ vào ĐẦU danh sách, giữ thứ tự tăng dần', () => {
    const existing = [m('c', 3), m('d', 4)];
    const older = [m('a', 1), m('b', 2)];
    expect(mergeOlderMessages(existing, older, cmp).map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('loại trùng theo id — trang cũ chồng lấn tin đã có thì KHÔNG nhân đôi', () => {
    const existing = [m('b', 2), m('c', 3)];
    const older = [m('a', 1), m('b', 2)];
    const out = mergeOlderMessages(existing, older, cmp);
    expect(out.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('tin cũ về lộn xộn vẫn sắp đúng chỗ giữa danh sách hiện có', () => {
    const existing = [m('d', 4)];
    const older = [m('c', 3), m('a', 1), m('b', 2)];
    expect(mergeOlderMessages(existing, older, cmp).map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('không có tin cũ mới nào → trả về CHÍNH mảng cũ (không tạo mảng mới, khỏi re-render)', () => {
    const existing = [m('a', 1)];
    expect(mergeOlderMessages(existing, [m('a', 1)], cmp)).toBe(existing);
  });
});

describe('shouldLoadOlder', () => {
  it('cuộn sát đỉnh + còn tin cũ + không đang tải → tải', () => {
    expect(shouldLoadOlder({ scrollTop: 40, hasMore: true, loading: false })).toBe(true);
  });
  it('đang tải rồi → không gọi chồng', () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasMore: true, loading: true })).toBe(false);
  });
  it('hết tin cũ → không gọi nữa', () => {
    expect(shouldLoadOlder({ scrollTop: 0, hasMore: false, loading: false })).toBe(false);
  });
  it('còn xa đỉnh → chưa tải', () => {
    expect(shouldLoadOlder({ scrollTop: 900, hasMore: true, loading: false })).toBe(false);
  });
});

describe('olderPageOffset', () => {
  it('bỏ qua đúng số tin ĐÃ tải — tin mới đến chen vào chỉ gây chồng lấn, không nhảy cóc', () => {
    expect(olderPageOffset(100)).toBe(100);
    expect(olderPageOffset(237)).toBe(237);
  });
  it('chưa có tin nào → offset 0', () => {
    expect(olderPageOffset(0)).toBe(0);
  });
  it('số âm/rác → kẹp về 0', () => {
    expect(olderPageOffset(-5)).toBe(0);
    expect(olderPageOffset(Number.NaN)).toBe(0);
  });
});
