/** What a writing job asks of the user's agent account. */
export type WriteRequest = { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal };
/** Writes the answer: a string, or the parsed JSON when `json` is set. */
export type Writer = (r: WriteRequest) => Promise<string | unknown>;
