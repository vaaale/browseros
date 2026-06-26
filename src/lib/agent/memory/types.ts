export type MemoryType = "lesson" | "fact" | "preference" | "procedure";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  createdAt: number;
  /** Increments each time the memory is recalled or marked useful. */
  usefulness: number;
}

export interface RecalledMemory extends Memory {
  score: number;
}
