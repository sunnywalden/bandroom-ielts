import { z } from "zod/v4";

export const binaryManifestLimit = 4096;
export const acousticChunkIndex = z.number().int().min(0).max(50);
export const acousticChunkLimit = 4 + binaryManifestLimit + 800 * 768 * 4;
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const acousticChunkManifest = z.strictObject({
  format: z.literal("bandroom-acoustic-chunk-v1"),
  chunkIndex: acousticChunkIndex,
  previousSha256: sha256Schema,
  decodeSha256: sha256Schema,
  bundleSha256: sha256Schema,
  configSha256: sha256Schema,
  featuresSha256: sha256Schema,
});

export function acousticFeatureBytes(samples: number, index: number) {
  const frames = Math.floor((samples - 400) / 320) + 1;
  if (frames < 1) return 0;
  for (const offset of [0, 400]) {
    for (let frame = offset === 0 ? 0 : offset - 800; frame < frames; frame += 800) {
      if (index-- === 0) return (Math.min(frames, frame + 800) - Math.max(0, frame)) * 768 * 4;
    }
  }
  return 0;
}
