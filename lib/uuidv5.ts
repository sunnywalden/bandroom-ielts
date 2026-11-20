// RFC 4122 version-5 (SHA-1) namespaced UUIDs.
//
// Used by backup restore (MT-5 / S5.1 / G5) to give every imported id a
// tenant-specific image. The derivation is deterministic, so re-restoring the
// same archive maps each source id to the same stored id (ON CONFLICT DO
// NOTHING still dedups) while a different tenant maps the same source id to a
// different stored id (no cross-tenant PK collision -> no existence oracle).

const encoder = new TextEncoder();

// Fixed Bandroom namespace for backup id derivation. Never change this value:
// it is the root of every stored backup id. Rotating it would make previously
// restored rows unmatchable on the next restore.
export const BANDROOM_BACKUP_NAMESPACE = "6f1c8d3a-2b4e-5c7d-9e0f-a1b2c3d4e5f6";

function uuidToBytes(value: string): Uint8Array {
  const hex = value.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid_uuid");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 §4.3: SHA-1(namespace bytes || name bytes), version/variant set. */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = encoder.encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** Stable per-tenant namespace: uuidv5(uid, BANDROOM_BACKUP_NAMESPACE). */
export async function backupTenantNamespace(uid: string): Promise<string> {
  return uuidv5(uid, BANDROOM_BACKUP_NAMESPACE);
}

/** Tenant-specific image of one imported id. */
export async function backupNamespacedId(uid: string, sourceId: string): Promise<string> {
  return uuidv5(sourceId, await backupTenantNamespace(uid));
}