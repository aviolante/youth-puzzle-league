import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadEnv(filePath = ".env") {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!existsSync(absolutePath)) return;

  const text = readFileSync(absolutePath, "utf8");
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;

    const [, key, rawValue] = match;
    if (process.env[key]) return;

    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env or export it in your shell.`);
  }
  return value;
}

export function optionalEnv(name, fallback) {
  return process.env[name] || fallback;
}
