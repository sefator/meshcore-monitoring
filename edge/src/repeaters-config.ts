import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { config } from "./config.js";
import type { Repeater } from "./types.js";

const repeaterSchema = z.object({
  repeater_id: z.string(),
  public_key_hex: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).optional(),
  label: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  tags: z.array(z.string()).optional(),
});

const configSchema = z.object({ repeaters: z.array(repeaterSchema).min(1) });

export async function loadRepeaters(): Promise<Repeater[]> {
  const resolvedPath = path.isAbsolute(config.repeatersConfigPath)
    ? config.repeatersConfigPath
    : path.join(process.cwd(), config.repeatersConfigPath);
  const content = await fs.readFile(resolvedPath, "utf8");
  const parsed = configSchema.parse(JSON.parse(content));
  const active = parsed.repeaters.filter((r) => r.enabled !== false);
  if (!active.length) {
    throw new Error("repeaters config has no enabled repeaters");
  }
  return active.map((r) => ({
    repeaterId: r.repeater_id,
    publicKeyHex: r.public_key_hex,
    password: r.password,
    label: r.label,
    tags: r.tags ?? [],
  }));
}
