// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * use-contact-zalo-actions.ts — "Tìm Zalo" + "Chat nội bộ" dùng chung cho hồ sơ KH và khung chat.
 *
 * KH từ phiếu khảo sát / nhập Excel chỉ có SĐT, CRM chưa biết UID Zalo. UID Zalo khác nhau theo
 * từng nick → phải tra SĐT bằng đúng nick sẽ nhắn, rồi gắn KH vào hội thoại Zalo của nick đó.
 * Nick = nick của sale phụ trách KH; không xác định được thì hỏi người bấm (NickPickerPopup).
 * Tra bấm tay từng KH, KHÔNG quét hàng loạt: tra SĐT nhiều là Zalo khoá tạm nick.
 */
import { reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';
import { resolveNickForContact, type NickLike } from '@/utils/zalo-link';

/** Nick trả về từ GET /zalo-accounts — đủ field cho NickPickerPopup. */
export interface ZaloNick extends NickLike {
  displayName: string | null;
  avatarUrl?: string | null;
  privacyMode?: string | null;
  owner?: { id: string; fullName: string | null } | null;
}

export type LinkZaloResult =
  | { status: 'linked'; conversationId: string; uid: string; zaloName: string | null }
  | { status: 'not_found'; message: string }
  | { status: 'error'; message: string };

interface LookupResponse {
  found: boolean;
  uid?: string;
  zaloName?: string | null;
  username?: string | null;
  globalId?: string | null;
  avatar?: string | null;
  phone?: string;
}

const PICK_TITLES = {
  no_sale: 'Khách chưa có sale phụ trách — chọn nick để tìm Zalo',
  sale_no_nick: 'Nick của sale phụ trách chưa kết nối — chọn nick để tìm Zalo',
  sale_many_nicks: 'Sale phụ trách có nhiều nick — chọn nick để tìm Zalo',
} as const;

function errorMessage(err: any, fallback: string): string {
  const d = err?.response?.data;
  return d?.detail || d?.message || d?.error || fallback;
}

/** Các nick người đang đăng nhập được dùng (backend đã lọc theo phân quyền). */
export async function fetchZaloNicks(): Promise<ZaloNick[]> {
  const { data } = await api.get<ZaloNick[]>('/zalo-accounts');
  return data;
}

/** Tra SĐT bằng nick → gắn KH vào hội thoại Zalo của nick đó (tạo nếu chưa có). */
export async function linkContactToZalo(p: { contactId: string; phone: string; accountId: string }): Promise<LinkZaloResult> {
  let lookup: LookupResponse;
  try {
    const res = await api.post<LookupResponse>(`/zalo-accounts/${p.accountId}/friends/lookup-by-phone`, { phone: p.phone });
    lookup = res.data;
  } catch (err) {
    return { status: 'error', message: errorMessage(err, 'Không tra được SĐT trên Zalo') };
  }
  if (!lookup?.found || !lookup.uid) {
    return { status: 'not_found', message: 'Không tìm thấy Zalo từ SĐT này (khách không dùng Zalo hoặc đã tắt cho tìm bằng SĐT)' };
  }
  try {
    const res = await api.post<{ conversationId: string }>('/conversations/ensure-by-uid', {
      zaloAccountId: p.accountId,
      uid: lookup.uid,
      commit: true,
      contactMode: `attach:${p.contactId}`,
      zaloName: lookup.zaloName,
      zaloAvatarUrl: lookup.avatar,
      zaloGlobalId: lookup.globalId,
      zaloUsername: lookup.username,
      phone: lookup.phone,
    });
    return { status: 'linked', conversationId: res.data.conversationId, uid: lookup.uid, zaloName: lookup.zaloName ?? null };
  } catch (err) {
    return { status: 'error', message: errorMessage(err, 'Tìm thấy Zalo nhưng không gắn được vào khách') };
  }
}

export function useContactZaloActions() {
  const router = useRouter();
  const toast = useToast();
  const findingZalo = ref(false);
  const openingInternal = ref(false);

  // Hộp chọn nick — component gắn vào <NickPickerPopup v-model="nickPicker.open" ... @pick="onNickPicked">.
  const nickPicker = reactive({ open: false, title: '', choices: [] as ZaloNick[] });
  let resolvePick: ((nick: ZaloNick | null) => void) | null = null;

  // Đóng hộp mà không chọn (✕ / bấm ra ngoài) → huỷ lượt Tìm Zalo đang chờ.
  watch(() => nickPicker.open, (open) => {
    if (!open && resolvePick) {
      resolvePick(null);
      resolvePick = null;
    }
  });

  function onNickPicked(picked: { id: string }) {
    const nick = nickPicker.choices.find((n) => n.id === picked.id) ?? null;
    resolvePick?.(nick);
    resolvePick = null;
  }

  async function chooseNick(assignedUserId: string | null | undefined): Promise<ZaloNick | null> {
    findingZalo.value = true;
    let nicks: ZaloNick[];
    try {
      nicks = await fetchZaloNicks();
    } catch (err) {
      toast.error(errorMessage(err, 'Không tải được danh sách nick Zalo'));
      return null;
    } finally {
      findingZalo.value = false;
    }
    const r = resolveNickForContact(nicks, assignedUserId);
    if ('nick' in r) return r.nick;
    if (!r.choices.length) {
      toast.warning('Không có nick Zalo nào đang kết nối để tra SĐT');
      return null;
    }
    resolvePick?.(null);
    nickPicker.title = PICK_TITLES[r.reason];
    nickPicker.choices = r.choices;
    nickPicker.open = true;
    return new Promise((resolve) => { resolvePick = resolve; });
  }

  /** Luôn mở chat nội bộ, kể cả KH đã có chat Zalo. true = đã chuyển sang trang chat. */
  async function openInternalChat(contactId: string): Promise<boolean> {
    if (openingInternal.value) return false;
    openingInternal.value = true;
    try {
      const res = await api.post<{ conversationId: string }>(
        `/contacts/${contactId}/virtual-conversation`, { internal: true },
      );
      await router.push({ name: 'Chat', params: { convId: res.data.conversationId } });
      return true;
    } catch (err) {
      toast.error(errorMessage(err, 'Không mở được chat nội bộ — vui lòng thử lại'));
      return false;
    } finally {
      openingInternal.value = false;
    }
  }

  /** Tra SĐT: có Zalo → mở chat Zalo; không có → báo rồi mở chat nội bộ. true = đã chuyển trang. */
  async function findZaloAndOpen(contact: {
    id: string;
    phone?: string | null;
    assignedUserId?: string | null;
    assignedUser?: { id?: string } | null;
  }): Promise<boolean> {
    if (findingZalo.value) return false;
    const phone = contact.phone;
    if (!phone) {
      toast.warning('Khách chưa có SĐT — không tra được Zalo');
      return false;
    }
    const nick = await chooseNick(contact.assignedUserId ?? contact.assignedUser?.id);
    if (!nick) return false;

    findingZalo.value = true;
    let result: LinkZaloResult;
    try {
      result = await linkContactToZalo({ contactId: contact.id, phone, accountId: nick.id });
    } finally {
      findingZalo.value = false;
    }

    if (result.status === 'error') {
      toast.error(result.message);
      return false;
    }
    if (result.status === 'not_found') {
      toast.warning(`${result.message} — mở chat nội bộ`, 5000);
      return openInternalChat(contact.id);
    }
    const who = result.zaloName ? ` "${result.zaloName}"` : '';
    const via = nick.displayName ? ` qua nick ${nick.displayName}` : '';
    toast.success(`Đã tìm thấy Zalo${who}${via} — mở chat Zalo`);
    await router.push({ name: 'Chat', params: { convId: result.conversationId } });
    return true;
  }

  return { findingZalo, openingInternal, nickPicker, onNickPicked, openInternalChat, findZaloAndOpen };
}
