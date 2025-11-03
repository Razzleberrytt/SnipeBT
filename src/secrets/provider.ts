import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

export interface SecretsProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

function createFileProvider(baseDir: string): SecretsProvider {
  const dir = path.resolve(baseDir);
  const file = path.join(dir, "secrets.enc.json");
  const key = crypto.createHash("sha256").update(os.hostname()).digest();
  const iv = Buffer.alloc(16, 0);

  function readStore(): Record<string,string> {
    if (!fs.existsSync(file)) return {};
    const data = fs.readFileSync(file);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(json);
  }
  function writeStore(obj: Record<string,string>) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const json = Buffer.from(JSON.stringify(obj));
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const enc = Buffer.concat([cipher.update(json), cipher.final()]);
    fs.writeFileSync(file, enc);
  }

  return {
    async get(k) { const s = readStore(); return s[k] ?? null; },
    async set(k, v) { const s = readStore(); s[k] = v; writeStore(s); }
  };
}

export function getSecretsProvider(dataDir = "./data"): SecretsProvider {
  try {
    // optional dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keytar = require("keytar") as typeof import("keytar");
    return {
      async get(key) { return (await keytar.getPassword("SnipeBT", key)) ?? null; },
      async set(key, value) { await keytar.setPassword("SnipeBT", key, value); }
    };
  } catch {
    return createFileProvider(dataDir);
  }
}
