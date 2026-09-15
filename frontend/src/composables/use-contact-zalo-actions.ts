// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * use-contact-zalo-actions.ts — "Tìm Zalo" + "Chat nội bộ" dùng chung cho hồ sơ KH và khung chat.
 *
 * KH từ phiếu khảo sát / nhập Excel chỉ có SĐT, CRM chưa biết UID Zalo. UID Zalo khác nhau theo
 * từng nick → phải tra SĐT bằng đúng nick sẽ nhắn, rồi gắn KH vào hội thoại Zalo của nick đó.
 * Tra bấm tay từng KH, KHÔNG quét hàng loạt: tra SĐT nhiều là Zalo khoá tạm nick.
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth';
import { pickLookupNick, type NickLike } from '@/utils/zalo-link';

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

function errorMessage(err: any, fallback: string): string {
  const d = err?.response?.data;
  return d?.detail || d?.message || d?.error || fallback;
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
  const auth = useAuthStore();
  const findingZalo = ref(false);
  const openingInternal = ref(false);

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
  async function findZaloAndOpen(contact: { id: string; phone?: string | null }): Promise<boolean> {
    if (findingZalo.value) return false;
    if (!contact.phone) {
      toast.warning('Khách chưa có SĐT — không tra được Zalo');
      return false;
    }
    findingZalo.value = true;
    let result: LinkZaloResult;
    let nickName = '';
    try {
      const { data: nicks } = await api.get<Array<NickLike & { displayName: string | null }>>('/zalo-accounts');
      const nick = pickLookupNick(nicks, auth.user?.id);
      if (!nick) {
        toast.warning('Chưa có nick Zalo nào đang kết nối để tra SĐT');
        return false;
      }
      nickName = nick.displayName || '';
      result = await linkContactToZalo({ contactId: contact.id, phone: contact.phone, accountId: nick.id });
    } catch (err) {
      toast.error(errorMessage(err, 'Không tải được danh sách nick Zalo'));
      return false;
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
    const via = nickName ? ` qua nick ${nickName}` : '';
    toast.success(`Đã tìm thấy Zalo${who}${via} — mở chat Zalo`);
    await router.push({ name: 'Chat', params: { convId: result.conversationId } });
    return true;
  }

  return { findingZalo, openingInternal, openInternalChat, findZaloAndOpen };
}
