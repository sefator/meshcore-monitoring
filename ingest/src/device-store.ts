import { sql } from "./database.js";
import type { CompanionDevice, SignatureAlgo } from "./config.js";

type DeviceRow = {
  device_id: string;
  location_id: string;
  public_key: string;
  signature_algo: string;
  revoked_at: Date | null;
};

const cache = new Map<string, CompanionDevice>();

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
  locationId?: string;
}) {
  await sql`
    INSERT INTO devices (device_id, public_key, signature_algo, location_id)
    VALUES (${deviceId ?? publicKey}, ${publicKey}, ${"ed25519"}, ${locationId ?? null})
    ON CONFLICT (public_key) DO UPDATE SET location_id = COALESCE(EXCLUDED.location_id, devices.location_id)
  `;
  const device: CompanionDevice = {
    deviceId: deviceId ?? publicKey,
    locationId: locationId ?? "unknown",
    publicKey,
    signatureAlgo: "ed25519",
    revokedAt: null
  };
  cache.set(device.deviceId, device);
  return device;
}
