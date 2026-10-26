/**
 * Splits text into overlapping chunks on paragraph boundaries so that each
 * chunk stays inside the embedding model's comfortable input length.
 */
export function chunkText(
  text: string,
  { maxChars = 320, overlap = 64 }: { maxChars?: number; overlap?: number } = {},
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}|\n(?=#)/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";

  const push = () => {
    const value = buffer.trim();
    if (value) chunks.push(value);
    buffer = value.length > overlap ? value.slice(-overlap) : value;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (buffer) push();
      for (let start = 0; start < paragraph.length; start += maxChars - overlap) {
        chunks.push(paragraph.slice(start, start + maxChars).trim());
      }
      buffer = "";
      continue;
    }
    if (buffer.length + paragraph.length + 1 > maxChars) push();
    buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.filter((chunk) => chunk.length >= 12);
}

/** Stable id so re-importing the same file updates instead of duplicating. */
export function chunkId(source: string, index: number, text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${source}#${index}#${(hash >>> 0).toString(36)}`;
}
