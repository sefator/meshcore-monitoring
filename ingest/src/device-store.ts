import type { Sql } from "postgres";
import { sql } from "./database.js";
import type { CompanionDevice, SignatureAlgo } from "./config.js";
import type { LocationId } from "./types.js";

type DeviceRow = {
  device_id: string;
  location_id: string;
  public_key: string;
  signature_algo: string;
  revoked_at: Date | null;
};

const cache = new Map<string, CompanionDevice>();

export async function ensureLocationExists(locationId: LocationId) {
  await sql`
    INSERT INTO locations (location_id, name, network_id)
    VALUES (${locationId}, ${locationId}, ${locationId})
    ON CONFLICT (location_id) DO NOTHING
  `;
}

export async function ensureRepeatersExist(
  repeaterIds: Iterable<string>,
  locationId: LocationId,
  db: Sql = sql
) {
  const uniqueRepeaterIds = Array.from(new Set(repeaterIds));
  for (const repeaterId of uniqueRepeaterIds) {
    await db`
      INSERT INTO repeaters (repeater_id, location_id, label)
      VALUES (${repeaterId}, ${locationId}, ${repeaterId})
      ON CONFLICT (repeater_id) DO UPDATE
      SET
        location_id = EXCLUDED.location_id,
        label = COALESCE(repeaters.label, EXCLUDED.label)
    `;
  }
}

export async function getDevice(deviceId: string) {
  if (cache.has(deviceId)) {
    return cache.get(deviceId) ?? null;
  }
  const rows = await sql<DeviceRow[]>`
    SELECT device_id, location_id, public_key, signature_algo, revoked_at
    FROM devices
    WHERE device_id = ${deviceId}
  `;
  const row = rows[0];
  if (!row) return null;
  const device: CompanionDevice = {
    deviceId: row.device_id,
    locationId: row.location_id,
    publicKey: row.public_key,
    signatureAlgo: (row.signature_algo as SignatureAlgo) ?? "unknown",
    revokedAt: row.revoked_at
  };
  cache.set(deviceId, device);
  return device;
}

export function invalidateDevice(deviceId: string) {
  cache.delete(deviceId);
}

export async function upsertDeviceByPublicKey({
  publicKey,
  deviceId,
  locationId
}: {
  publicKey: string;
  deviceId?: string;
  locationId?: LocationId;
}) {
  const resolvedDeviceId = deviceId ?? publicKey;
  await sql`
    WITH updated AS (
      UPDATE devices
      SET
        device_id = ${resolvedDeviceId},
        public_key = ${publicKey},
        signature_algo = ${"ed25519"},
        location_id = COALESCE(${locationId ?? null}, devices.location_id)
      WHERE device_id = ${resolvedDeviceId} OR public_key = ${publicKey}
      RETURNING device_id
    )
    INSERT INTO devices (device_id, public_key, signature_algo, location_id)
    SELECT ${resolvedDeviceId}, ${publicKey}, ${"ed25519"}, ${locationId ?? null}
    WHERE NOT EXISTS (SELECT 1 FROM updated)
  `;
  const device: CompanionDevice = {
    deviceId: resolvedDeviceId,
    locationId: locationId ?? "unknown",
    publicKey,
    signatureAlgo: "ed25519",
    revokedAt: null
  };
  cache.set(device.deviceId, device);
  return device;
}
