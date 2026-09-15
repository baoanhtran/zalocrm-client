// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Nick chứa chat nội bộ của KH: nick sale phụ trách → nick người bấm sở hữu → nick đầu tiên người bấm
 * truy cập được. Chat nội bộ không gửi Zalo, nhưng nick quyết định ai thấy chat và "Kết bạn" gửi từ
 * đâu — admin không sở hữu nick từng làm chat nội bộ rơi vào nick của sale khác.
 */
export function pickVirtualChatNick(
  accessibleIds: string[],
  ownedIds: Set<string>,
  assignedSaleNickIds: string[],
): string | null {
  return (
    accessibleIds.find((id) => assignedSaleNickIds.includes(id))
    ?? accessibleIds.find((id) => ownedIds.has(id))
    ?? accessibleIds[0]
    ?? null
  );
}
