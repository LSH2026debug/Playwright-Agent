import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function ensureDir(targetPath: string, isFile = true): Promise<void> {
  const dirPath = isFile ? path.dirname(targetPath) : targetPath;
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(targetPath: string, fallback: T): Promise<T> {
  if (!(await fileExists(targetPath))) {
    return fallback;
  }

  try {
    const raw = await fs.readFile(targetPath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await ensureDir(targetPath);
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readText(targetPath: string): Promise<string | null> {
  if (!(await fileExists(targetPath))) {
    return null;
  }

  return fs.readFile(targetPath, 'utf8');
}

export async function writeText(targetPath: string, value: string): Promise<void> {
  await ensureDir(targetPath);
  await fs.writeFile(targetPath, value, 'utf8');
}
