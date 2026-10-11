import type { Me } from "@rakazo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Image } from "react-native";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import { artifactCacheFileName, artifactShareFileName } from "./artifact-file";
import { t } from "./i18n";
import type { ImageSize } from "./inline-image";
import { createKeyedPromiseCache } from "./inline-image";
import {
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
} from "./session";

export type MobileArtifactTarget = { botId: string } | { groupId: string };

/**
 * An artifact travels as base64 inside the RPC body: up to the attachment limit (10 MiB) plus
 * a third of encoding overhead. The default RPC timeout is sized for small JSON replies and
 * gives up on a multi-megabyte photo over a relayed cellular link, so downloads get a budget
 * of their own.
 */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;
/** Disk budget for downloaded previews; the least recently written are deleted past it. */
export const ARTIFACT_PREVIEW_CACHE_BYTES = 200 * 1024 * 1024;
export const ARTIFACT_PREVIEW_CACHE_ENTRIES = 100;
const PREVIEWS = "artifact-previews";

/** Writes an artifact's bytes to its cache file; no network call. */
export function writeArtifactCacheFile(
  artifactId: string,
  mimeType: string,
  contentBase64: string,
): File {
  if (Math.floor((contentBase64.length * 3) / 4) > ARTIFACT_PREVIEW_CACHE_BYTES)
    throw new Error(t("Could not load this artifact."));
  const root = new Directory(
    Paths.cache,
    "artifact-downloads",
    artifactCacheFileName(artifactId, mimeType),
  );
  root.create({ intermediates: true, idempotent: true });
  const file = new File(root, artifactCacheFileName(artifactId, mimeType));
  file.create({ overwrite: true });
  file.write(contentBase64, { encoding: "base64" });
  pruneArtifactPreviews(new Directory(Paths.cache, "artifact-downloads"), root);
  return file;
}

type ArtifactScope = {
  context: ApiRequestContext;
  generation: number;
  selectionId: string | null;
  namespace: string;
  userId: string;
};
let identity: { key: string; scope: Promise<ArtifactScope> } | undefined;

function assertCurrent(scope: ArtifactScope): void {
  if (
    scope.generation !== currentSessionGeneration() ||
    scope.context.apiBase !== currentApiBase() ||
    scope.selectionId !== selectedSpaceId()
  ) {
    throw new Error("Artifact session changed");
  }
}

function artifactScope(): Promise<ArtifactScope> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const selectionId = selectedSpaceId();
  const key = JSON.stringify([apiBase, generation, selectionId]);
  if (identity?.key === key) return identity.scope;
  imageArtifactUris.clear();
  imageArtifactSizes.clear();
  imageArtifactRequests.clear();
  const scope = (async () => {
    const context = await captureApiRequestContext();
    const token = await loadSessionToken();
    if (
      apiBase !== context.apiBase ||
      generation !== currentSessionGeneration() ||
      selectionId !== selectedSpaceId()
    )
      throw new Error("Artifact session changed");
    // The verified scope is bound to this token, so previews already on disk open offline. The
    // user is the same in every Space on this server; requests still carry the current Space.
    const verified = await loadVerifiedIntegrationsScope();
    const userId =
      verified?.apiBase === apiBase
        ? verified.userId
        : (await rpc<Pick<Me, "userId">>("me", {}, { requestContext: context })).userId;
    if (generation !== currentSessionGeneration()) throw new Error("Artifact session changed");
    if (!userId) throw new Error("Missing artifact owner");
    const result = {
      context,
      generation,
      selectionId,
      userId,
      namespace: await artifactCacheSession(token),
    };
    assertCurrent(result);
    return result;
  })();
  const entry = { key, scope };
  identity = entry;
  void scope.catch(() => {
    if (identity === entry) identity = undefined;
  });
  return scope;
}

function requestKey(target: MobileArtifactTarget, artifactId: string, mimeType: string): string {
  return JSON.stringify([
    "botId" in target ? "bot" : "group",
    "botId" in target ? target.botId : target.groupId,
    artifactId,
    mimeType,
  ]);
}

async function cacheMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
  cachedScope?: ArtifactScope,
): Promise<File> {
  const scope = cachedScope ?? (await artifactScope());
  assertCurrent(scope);
  const key = requestKey(target, artifactId, mimeType);
  const root = new Directory(
    Paths.cache,
    PREVIEWS,
    scope.namespace,
    `endpoint-${encodeURIComponent(scope.context.apiBase)}`,
    `user-${encodeURIComponent(scope.userId)}`,
    `target-${encodeURIComponent("botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`)}`,
    `artifact-${encodeURIComponent(artifactId)}`,
    `mime-${encodeURIComponent(mimeType)}`,
  );
  if (!root.exists) root.create({ intermediates: true });
  const file = new File(root, artifactCacheFileName(artifactId, mimeType));
  const metadata = new File(root, `${file.name}.json`);
  // Legacy unscoped files and incomplete writes are never authorized cache entries.
  if (
    file.exists &&
    file.size <= ARTIFACT_PREVIEW_CACHE_BYTES &&
    metadata.exists &&
    metadata.size <= 8192
  ) {
    try {
      if (JSON.parse(metadata.textSync()).key === key) return file;
    } catch {
      // A corrupt sidecar is a cache miss.
    }
  }
  const artifact = await rpc<{ contentBase64: string }>(
    "artifacts/get",
    { ...target, artifactId },
    { timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS, requestContext: scope.context },
  );
  assertCurrent(scope);
  if (Math.floor((artifact.contentBase64.length * 3) / 4) > ARTIFACT_PREVIEW_CACHE_BYTES)
    throw new Error(t("Could not load this artifact."));
  // Invalidate first so an interrupted overwrite cannot leave valid metadata for wrong bytes.
  if (metadata.exists) metadata.delete();
  file.create({ overwrite: true });
  file.write(artifact.contentBase64, { encoding: "base64" });
  metadata.create({ overwrite: true });
  metadata.write(JSON.stringify({ key }));
  pruneArtifactPreviews(new Directory(Paths.cache, PREVIEWS), root);
  return file;
}

/** Keeps one session's previews under the disk budget, deleting the least recently written. */
function pruneArtifactPreviews(namespace: Directory, keep: Directory): void {
  try {
    const entries: Array<{ dir: Directory; bytes: number; written: number }> = [];
    const walk = (dir: Directory) => {
      let bytes = 0;
      let written = 0;
      let leaf = false;
      for (const item of dir.list()) {
        if (item instanceof Directory) {
          walk(item);
        } else {
          leaf = true;
          bytes += item.size;
          written = Math.max(written, item.lastModified ?? 0);
        }
      }
      if (leaf) entries.push({ dir, bytes, written });
    };
    walk(namespace);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = entries.length;
    for (const entry of entries.sort((a, b) => a.written - b.written)) {
      if (total <= ARTIFACT_PREVIEW_CACHE_BYTES && count <= ARTIFACT_PREVIEW_CACHE_ENTRIES) break;
      if (entry.dir.uri === keep.uri) continue;
      entry.dir.delete();
      total -= entry.bytes;
      count -= 1;
    }
    if (total > ARTIFACT_PREVIEW_CACHE_BYTES || count > ARTIFACT_PREVIEW_CACHE_ENTRIES)
      throw new Error(t("Could not load this artifact."));
  } catch (error) {
    keep.delete();
    throw error;
  }
}

/** Deletes every downloaded preview; the session namespace rotates with it. */
export function clearArtifactPreviews(): void {
  identity = undefined;
  imageArtifactUris.clear();
  imageArtifactSizes.clear();
  imageArtifactRequests.clear();
  for (const name of [PREVIEWS, "artifact-downloads", "artifact-shares"]) {
    try {
      const root = new Directory(Paths.cache, name);
      if (root.exists) root.delete();
    } catch {
      // One failed physical wipe cannot skip the other caches; namespaces gate reuse.
    }
  }
}

export async function readMobileArtifactText(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  return file.text();
}

export async function openMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  await shareNamedFile(file, mimeType, name);
}

const imageArtifactUris = createKeyedPromiseCache<string>(async (key) => {
  const request = imageArtifactRequests.get(key);
  if (!request) throw new Error("unknown image artifact");
  const file = await cacheMobileArtifact(
    request.target,
    request.artifactId,
    request.mimeType,
    request.scope,
  );
  return file.uri;
});
const imageArtifactRequests = new Map<
  string,
  { target: MobileArtifactTarget; artifactId: string; mimeType: string; scope: ArtifactScope }
>();

/**
 * Local file URI of an image artifact, downloaded through the authenticated RPC and cached on
 * disk. Concurrent callers (every bubble showing the same image) share one download.
 */
export async function imageArtifactUri(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const scope = await artifactScope();
  assertCurrent(scope);
  const key = JSON.stringify([
    scope.context.apiBase,
    scope.userId,
    scope.namespace,
    scope.generation,
    requestKey(target, artifactId, mimeType),
  ]);
  imageArtifactRequests.set(key, { target, artifactId, mimeType, scope });
  const entry = imageArtifactUris.get(key);
  const uri = await entry;
  assertCurrent(scope);
  if (new File(uri).exists) return uri;
  imageArtifactUris.forget(key, entry);
  const refreshed = await imageArtifactUris.get(key);
  assertCurrent(scope);
  return refreshed;
}

// Natural dimensions share the URI cache's session lifetime; fitted sizes stay per layout.
const imageArtifactSizes = createKeyedPromiseCache<ImageSize>(
  (uri) =>
    new Promise((resolve, reject) => {
      Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    }),
);

export async function imageArtifactPreview(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<{ uri: string; size: ImageSize }> {
  const scope = await artifactScope();
  const uri = await imageArtifactUri(target, artifactId, mimeType);
  assertCurrent(scope);
  const size = await imageArtifactSizes.get(uri);
  assertCurrent(scope);
  return { uri, size };
}

/** Share a file already on disk (for example an image the viewer is showing) without downloading it again. */
export async function shareLocalFile(uri: string, mimeType: string, name: string): Promise<void> {
  await shareNamedFile(new File(uri), mimeType, name);
}

async function shareNamedFile(source: File, mimeType: string, name: string): Promise<void> {
  const root = new Directory(Paths.cache, "artifact-shares");
  if (!root.exists) root.create();
  const dir = new Directory(root, source.name || "attachment");
  if (!dir.exists) dir.create();
  const shared = new File(dir, artifactShareFileName(name, mimeType));
  source.copySync(shared, { overwrite: true });
  pruneArtifactPreviews(root, dir);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shared.uri, { mimeType });
    return;
  }
  throw new Error(t("Saved {name} locally", { name }));
}
