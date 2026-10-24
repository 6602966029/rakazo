import type { ModelBackupChoice } from "@rakazo/contracts";

export type ModelConnectionRequest = {
  provider: string;
  /** Prefills an OpenAI-compatible endpoint, such as the Ollama Cloud preset. */
  baseUrl?: string;
  /** Only the main model's first slot replaces the space's default on connect. */
  makeDefault: boolean;
  /** Set when connecting fills a model slot; managing a connection leaves it unset. */
  onConnected?: (choice: ModelBackupChoice) => Promise<void> | void;
};

let nextId = 0;
const requests = new Map<string, ModelConnectionRequest>();

/** Ephemeral, owner-scoped connect requests; never serialized into links or storage. */
export function openModelConnection(request: ModelConnectionRequest): string {
  const id = String(++nextId);
  requests.set(id, request);
  return id;
}

export function modelConnectionRequest(id: string): ModelConnectionRequest | undefined {
  return requests.get(id);
}

export function closeModelConnection(id: string): void {
  requests.delete(id);
}
