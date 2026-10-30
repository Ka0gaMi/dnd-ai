interface ReplyLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}

/** The text body of a tool reply. */
export function replyText(result: unknown): string {
  return (result as ReplyLike).content?.[0]?.text ?? '';
}

/** A tool reply's data: structuredContent when present, else the compact JSON before any appended "\n\n" note (nag, roll rule). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replyData<T = any>(result: unknown): T {
  const structured = (result as ReplyLike).structuredContent;
  if (structured !== undefined) return structured as T;
  const text = replyText(result);
  const json = text.split('\n\n', 1)[0]!;
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Tool reply text is not JSON: ${text.slice(0, 200)}`);
  }
}
