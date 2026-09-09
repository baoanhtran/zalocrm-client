// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/** Trần token tối thiểu cho model đời 3.x — MINIMAL vẫn tiêu token suy luận. */
const THINKING_MIN_OUTPUT_TOKENS = 3000;

/**
 * Chọn generationConfig theo ĐỜI model.
 *
 * 2026-05-21: gemini-2.5-flash mặc định bật "thinking" — token suy luận ăn hết
 * maxOutputTokens trước khi kịp viết câu trả lời → response cụt. Tắt bằng
 * thinkingConfig.thinkingBudget = 0.
 *
 * 2026-09-09: đời 3.x đổi hẳn tham số sang thinkingLevel (MINIMAL|LOW|MEDIUM|HIGH)
 * và KHÔNG tắt hẳn được — MINIMAL là mức thấp nhất. Gửi kèm thinkingBudget trong
 * cùng request là Gemini trả lỗi, nên hai nhánh phải loại trừ nhau. Vì suy luận
 * vẫn tốn token, đời 3.x cần nới trần output; nếu không sẽ dính đúng lỗi
 * MAX_TOKENS mà thinkingBudget=0 đã chữa cho 2.5.
 * Tham khảo: https://ai.google.dev/gemini-api/docs/generate-content/thinking
 */
export function buildGeminiGenerationConfig(model: string, maxTokens: number): Record<string, unknown> {
  const major = Number(/^(?:models\/)?gemini-(\d+)\./i.exec(model)?.[1] ?? 0);
  const config: Record<string, unknown> = {
    temperature: 0.4,
    maxOutputTokens: maxTokens,
  };

  if (major >= 3) {
    config.thinkingConfig = { thinkingLevel: 'MINIMAL' };
    config.maxOutputTokens = Math.max(maxTokens, THINKING_MIN_OUTPUT_TOKENS);
  } else if (/^(?:models\/)?gemini-2\.5/i.test(model)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }

  return config;
}

export async function generateWithGemini(baseUrl: string, apiKey: string, model: string, system: string, prompt: string, maxTokens = 600) {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const generationConfig = buildGeminiGenerationConfig(model, maxTokens);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gemini request failed (${status}): ${errBody.slice(0, 200)}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    };
    const finishReason = data.candidates?.[0]?.finishReason || '';
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
    if (!text) {
      // Log usage để debug max_tokens issue.
      const usage = data.usageMetadata;
      throw new Error(`Gemini returned empty content (finishReason=${finishReason}, usage=${JSON.stringify(usage)})`);
    }
    if (finishReason === 'MAX_TOKENS') {
      // Output bị cắt → throw để caller biết là token issue, không phải logic
      throw new Error(`Gemini hit MAX_TOKENS — increase maxTokens (current=${maxTokens}, output len=${text.length})`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
