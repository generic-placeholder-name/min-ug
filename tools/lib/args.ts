export type ArgumentValue = string | boolean | (string | boolean)[];
export type ArgumentMap = Readonly<Record<string, ArgumentValue | undefined>>;

export interface ParsedArguments {
  [name: string]: ArgumentValue;
  _: string[];
}

export interface NumberArgumentOptions {
  readonly minimum?: number;
  readonly maximum?: number;
}

export function parseArgs (argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : token.slice(equals + 1);

    const next = argv[index + 1];
    if (value === undefined && next !== undefined && !next.startsWith("--")) {
      value = next;
      index += 1;
    }

    const parsedValue: string | boolean = value ?? true;

    if (Object.hasOwn(parsed, key)) {
      const existing = parsed[key]!;
      parsed[key] = Array.isArray(parsed[key])
        ? [...existing as (string | boolean)[], parsedValue]
        : [existing as string | boolean, parsedValue];
    } else {
      parsed[key] = parsedValue;
    }
  }

  return parsed;
}

export function numberArg (
  args: ArgumentMap,
  name: string,
  fallback: number,
  options?: NumberArgumentOptions
): number;
export function numberArg (
  args: ArgumentMap,
  name: string,
  fallback: undefined,
  options?: NumberArgumentOptions
): number | undefined;
export function numberArg (
  args: ArgumentMap,
  name: string,
  fallback: number | undefined,
  options: NumberArgumentOptions = {}
): number | undefined {
  const raw = args[name];
  if (raw === undefined) return fallback;
  const number = Number(raw);
  const minimum = options.minimum ?? -Infinity;
  const maximum = options.maximum ?? Infinity;
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} must be a number between ${minimum} and ${maximum}`);
  }
  return number;
}

export function booleanArg (
  args: ArgumentMap,
  name: string,
  fallback = false
): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`--${name} must be true or false`);
}

export function stringArg (
  args: ArgumentMap,
  name: string,
  fallback?: string
): string | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  throw new Error(`--${name} must be a string`);
}

export function stringArgs (
  args: ArgumentMap,
  name: string,
  fallback: readonly string[] = []
): string[] {
  const value = args[name];
  if (value === undefined) return [...fallback];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(item => typeof item === "string")) {
    throw new Error(`--${name} must be a string`);
  }
  return values as string[];
}
