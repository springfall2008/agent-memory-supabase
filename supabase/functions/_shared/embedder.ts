import type { Embedder } from './types.ts';

export const EMBEDDING_DIMENSIONS = 384;

interface Session {
  run(text: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<unknown>;
}

/** gte-small via the Edge Runtime's built-in inference session (mean-pooled, normalised, 384 dims). */
export class GteSmallEmbedder implements Embedder {
  // deno-lint-ignore no-explicit-any
  #session: Session = new (globalThis as any).Supabase.ai.Session('gte-small');

  async embed(text: string): Promise<number[]> {
    try {
      const v = await this.#session.run(text, { mean_pool: true, normalize: true });
      const vec = Array.from(v as ArrayLike<number>);
      if (vec.length !== EMBEDDING_DIMENSIONS) throw new Error(`expected ${EMBEDDING_DIMENSIONS} dimensions`);
      return vec;
    } catch (e) {
      console.error('gte-small embedding failed:', e);
      throw new Error('Embedding failed');
    }
  }

  /** Sequential: parallel inference saves no CPU. */
  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embed(t));
    if (out.length !== texts.length) throw new Error('Embedding failed');
    return out;
  }
}

/** Defers building the real embedder to the first embed, so requests that never embed (browse, graph) never pay for it. */
export class LazyEmbedder implements Embedder {
  #make: () => Embedder;
  #inner: Embedder | undefined;

  constructor(make: () => Embedder) {
    this.#make = make;
  }

  #get(): Embedder {
    return this.#inner ??= this.#make();
  }

  embed(text: string): Promise<number[]> {
    return this.#get().embed(text);
  }

  embedMany(texts: string[]): Promise<number[][]> {
    return this.#get().embedMany(texts);
  }
}
