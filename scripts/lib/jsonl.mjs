import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonl(filePath) {
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export async function writeJsonl(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

export async function appendJsonl(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
