export interface CorpusRow {
  id: string;
  text: string;
  source: string;
}

/** Loads the bundled demo corpus that also backs the quality evaluation. */
export async function loadCorpus(): Promise<CorpusRow[]> {
  const response = await fetch("/eval/corpus.jsonl");
  if (!response.ok) throw new Error("示例语料不可用，请确认 web/public/eval/corpus.jsonl 存在");
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusRow);
}
