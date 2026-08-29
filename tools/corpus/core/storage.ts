import { opendir, rm, stat, statfs } from "node:fs/promises";
import { relative, resolve } from "node:path";

export function parseByteSize (value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|KIB|MIB|GIB)?$/iu.exec(value);
  if (!match) throw new Error(`Invalid byte size ${JSON.stringify(value)}`);
  const units: Record<string, number> = {
    B: 1,
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3
  };
  const bytes = Number(match[1]) * units[(match[2] ?? "B").toUpperCase()]!;
  if (!Number.isSafeInteger(Math.floor(bytes)) || bytes <= 0) {
    throw new Error(`Byte size is outside the supported range: ${value}`);
  }
  return Math.floor(bytes);
}

export function formatBytes (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function assertSafeChild (parent: string, target: string): string {
  const absoluteParent = resolve(parent);
  const absoluteTarget = resolve(target);
  const pathFromParent = relative(absoluteParent, absoluteTarget);
  if (
    pathFromParent.length === 0 ||
    pathFromParent === ".." ||
    pathFromParent.startsWith("../") ||
    pathFromParent.startsWith("..\\")
  ) throw new Error(`Refusing destructive operation outside ${absoluteParent}: ${absoluteTarget}`);
  return absoluteTarget;
}

export async function removeSafePath (parent: string, target: string): Promise<void> {
  await rm(assertSafeChild(parent, target), { recursive: true, force: true });
}

export async function directorySize (path: string): Promise<number> {
  let total = 0;
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) total += await directorySize(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return total;
}

export class StorageGuard {
  readonly roots: readonly string[];

  constructor (
    roots: readonly string[],
    readonly budgetBytes: number,
    readonly minimumFreeBytes: number
  ) {
    this.roots = [...new Set(roots.map(root => resolve(root)))];
  }

  async inspect (): Promise<{ used: number; free: number }> {
    let used = 0;
    for (const root of this.roots) used += await directorySize(root);
    const filesystem = await statfs(this.roots[0]!);
    return {
      used,
      free: Number(filesystem.bavail) * Number(filesystem.bsize)
    };
  }

  async assertWithinBudget (context: string): Promise<{ used: number; free: number }> {
    const observed = await this.inspect();
    if (observed.used > this.budgetBytes) {
      throw new Error(
        `${context}: pipeline data uses ${formatBytes(observed.used)}, above the ` +
        `${formatBytes(this.budgetBytes)} storage budget`
      );
    }
    if (observed.free < this.minimumFreeBytes) {
      throw new Error(
        `${context}: only ${formatBytes(observed.free)} remains, below the required ` +
        `${formatBytes(this.minimumFreeBytes)} reserve`
      );
    }
    return observed;
  }
}
