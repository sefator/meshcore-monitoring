export function base64urlDecode(input: string) {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export function base64urlEncode(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
