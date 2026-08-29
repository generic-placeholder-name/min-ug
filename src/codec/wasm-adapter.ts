import type { CanonicalUrl } from "../canonicalize/index.js";

const DESCRIPTOR_BYTES = 8;
const DESCRIPTOR_ALIGNMENT = 4;

const DEFAULT_LIMITS = Object.freeze({
  canonicalUrlBytes: 1024 * 1024,
  payloadBytes: 1024 * 1024,
  memoryBytes: 64 * 1024 * 1024
});

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const CodecStatus = Object.freeze({
  OK: 0,
  INVALID_INPUT: 1,
  MALFORMED_PAYLOAD: 2,
  RESOURCE_LIMIT: 3,
  INTERNAL_ERROR: 4
} as const);

export interface LoadedCodec {
  encode(url: CanonicalUrl): Uint8Array;
  decode(payload: Uint8Array): string;
}

export interface WasmCodecLimits {
  readonly maxCanonicalUrlBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly maxMemoryBytes?: number;
}

export type WasmSource = BufferSource | WebAssembly.Module;

type CodecOperation = "encode" | "decode";
type NumericWasmFunction = (...args: number[]) => unknown;

export class WasmCodecError extends Error {
  readonly code: string;

  constructor (code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WasmCodecError";
    this.code = code;
  }
}

export class WasmCodecStatusError extends WasmCodecError {
  readonly operation: CodecOperation;
  readonly status: number;

  constructor (operation: CodecOperation, status: number) {
    super("codec-status", `${operation} returned codec status ${status}`);
    this.name = "WasmCodecStatusError";
    this.operation = operation;
    this.status = status;
  }
}

function positiveLimit (value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new WasmCodecError("invalid-limit", `${name} must be a positive u32 byte count`);
  }
  return value;
}

function requireFunction (
  exports: WebAssembly.Exports,
  name: string,
  parameters: number
): NumericWasmFunction {
  const value = exports[name];
  if (typeof value !== "function" || value.length !== parameters) {
    throw new WasmCodecError(
      "invalid-exports",
      `${name} must be an exported function with ${parameters} parameters`
    );
  }
  return value as NumericWasmFunction;
}

function rangesOverlap (
  leftPointer: number,
  leftLength: number,
  rightPointer: number,
  rightLength: number
): boolean {
  if (leftLength === 0 || rightLength === 0) return false;
  return leftPointer < rightPointer + rightLength && rightPointer < leftPointer + leftLength;
}

/**
 * Wrap already-instantiated ABI exports. Exported separately so hostile ABI behavior can be
 * tested without treating JavaScript mocks as real WebAssembly modules.
 */
export function createWasmCodecAdapter (
  exports: WebAssembly.Exports,
  options: WasmCodecLimits = {}
): LoadedCodec {
  const memoryExport = exports?.memory;
  if (!(memoryExport instanceof WebAssembly.Memory)) {
    throw new WasmCodecError("invalid-exports", "memory must be an exported WebAssembly.Memory");
  }
  const memory: WebAssembly.Memory = memoryExport;
  if (
    typeof SharedArrayBuffer === "function" &&
    memory.buffer instanceof SharedArrayBuffer
  ) {
    throw new WasmCodecError("invalid-memory", "Codec memory must not be shared");
  }

  const allocateExport = requireFunction(exports, "minug_alloc", 1);
  const freeExport = requireFunction(exports, "minug_free", 2);
  const encodeExport = requireFunction(exports, "minug_encode", 3);
  const decodeExport = requireFunction(exports, "minug_decode", 3);
  const limits = Object.freeze({
    canonicalUrlBytes: positiveLimit(
      options.maxCanonicalUrlBytes ?? DEFAULT_LIMITS.canonicalUrlBytes,
      "maxCanonicalUrlBytes"
    ),
    payloadBytes: positiveLimit(
      options.maxPayloadBytes ?? DEFAULT_LIMITS.payloadBytes,
      "maxPayloadBytes"
    ),
    memoryBytes: positiveLimit(
      options.maxMemoryBytes ?? DEFAULT_LIMITS.memoryBytes,
      "maxMemoryBytes"
    )
  });

  let poisoned = false;

  function poison (code: string, message: string, cause?: unknown): WasmCodecError {
    poisoned = true;
    return new WasmCodecError(code, message, cause === undefined ? undefined : { cause });
  }

  function assertUsable (): void {
    if (poisoned) {
      throw new WasmCodecError("poisoned-instance", "Codec instance cannot be reused after an ABI failure");
    }
  }

  function resultAsU32 (value: unknown, label: string): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < -0x80000000 ||
      value > 0x7fffffff
    ) {
      throw poison("invalid-result", `${label} did not return an i32`);
    }
    return value >>> 0;
  }

  function memorySize (): number {
    const size = memory.buffer.byteLength;
    if (size > limits.memoryBytes) {
      throw poison("memory-limit", `Codec memory grew to ${size} bytes`);
    }
    return size;
  }

  function validateSlice (pointer: number, length: number, label: string): void {
    const size = memorySize();
    if (length === 0) {
      if (pointer !== 0) throw poison("invalid-slice", `${label} has a pointer for an empty slice`);
      return;
    }
    if (pointer === 0 || pointer > size || length > size - pointer) {
      throw poison("invalid-slice", `${label} is outside codec memory`);
    }
  }

  function invoke (fn: NumericWasmFunction, label: string, ...args: number[]): unknown {
    memorySize();
    let result;
    try {
      result = fn(...args);
    } catch (cause) {
      throw poison("codec-trap", `${label} trapped`, cause);
    }
    memorySize();
    return result;
  }

  function allocate (length: number, label: string): number {
    if (length === 0) return 0;
    const pointer = resultAsU32(invoke(allocateExport, "minug_alloc", length), "minug_alloc");
    if (pointer === 0) {
      throw new WasmCodecError("allocation-failed", `Could not allocate ${label}`);
    }
    validateSlice(pointer, length, label);
    return pointer;
  }

  function release (pointer: number, length: number): void {
    // Zero is both the canonical empty pointer and the allocator's failure sentinel.
    if (pointer === 0) return;
    invoke(freeExport, "minug_free", pointer, length);
  }

  function transform (
    operation: CodecOperation,
    input: Uint8Array,
    maximumInput: number,
    maximumOutput: number
  ): Uint8Array {
    assertUsable();
    if (!(input instanceof Uint8Array)) {
      throw new WasmCodecError("invalid-input", `${operation} input must be a Uint8Array`);
    }
    const inputLength = input.byteLength;
    if (inputLength > maximumInput) {
      throw new WasmCodecError(
        "input-limit",
        `${operation} input is ${inputLength} bytes; limit is ${maximumInput}`
      );
    }
    // Do not let a caller-supplied view alias or become detached by this module's memory.grow.
    const inputBytes = Uint8Array.from(input);

    let inputPointer = 0;
    let descriptorPointer = 0;
    let outputPointer = 0;
    let outputLength = 0;
    try {
      inputPointer = allocate(inputLength, `${operation} input`);
      descriptorPointer = allocate(DESCRIPTOR_BYTES, `${operation} output descriptor`);
      if (descriptorPointer % DESCRIPTOR_ALIGNMENT !== 0) {
        throw poison("invalid-alignment", "Output descriptor is not four-byte aligned");
      }
      if (rangesOverlap(inputPointer, inputLength, descriptorPointer, DESCRIPTOR_BYTES)) {
        throw poison("aliased-allocation", "Input and output descriptor allocations overlap");
      }

      // Allocations may grow memory, so create views only after both allocations finish.
      new Uint8Array(memory.buffer, inputPointer, inputLength).set(inputBytes);
      const beforeCall = new DataView(memory.buffer, descriptorPointer, DESCRIPTOR_BYTES);
      beforeCall.setUint32(0, 0, true);
      beforeCall.setUint32(4, 0, true);

      const operationExport = operation === "encode" ? encodeExport : decodeExport;
      const status = resultAsU32(
        invoke(operationExport, `minug_${operation}`, inputPointer, inputLength, descriptorPointer),
        `minug_${operation}`
      );

      // The codec may grow memory. Never reuse a pre-call ArrayBuffer view here.
      const descriptor = new DataView(memory.buffer, descriptorPointer, DESCRIPTOR_BYTES);
      outputPointer = descriptor.getUint32(0, true);
      outputLength = descriptor.getUint32(4, true);

      if (status > CodecStatus.INTERNAL_ERROR) {
        throw poison("invalid-status", `${operation} returned unknown codec status ${status}`);
      }
      if (status !== CodecStatus.OK) {
        if (outputPointer !== 0 || outputLength !== 0) {
          throw poison("invalid-error-result", `${operation} returned an error with an output slice`);
        }
        throw new WasmCodecStatusError(operation, status);
      }
      validateSlice(outputPointer, outputLength, `${operation} output`);
      if (
        rangesOverlap(outputPointer, outputLength, inputPointer, inputLength) ||
        rangesOverlap(outputPointer, outputLength, descriptorPointer, DESCRIPTOR_BYTES)
      ) {
        throw poison("aliased-output", `${operation} output aliases host-owned memory`);
      }
      if (outputLength > maximumOutput) {
        throw new WasmCodecError(
          "output-limit",
          `${operation} output is ${outputLength} bytes; limit is ${maximumOutput}`
        );
      }

      return new Uint8Array(memory.buffer, outputPointer, outputLength).slice();
    } finally {
      if (!poisoned) {
        release(outputPointer, outputLength);
        release(descriptorPointer, DESCRIPTOR_BYTES);
        release(inputPointer, inputLength);
      }
    }
  }

  memorySize();
  return Object.freeze({
    encode (canonicalUrl: CanonicalUrl) {
      if (typeof canonicalUrl !== "string") {
        throw new WasmCodecError("invalid-input", "encode input must be a canonical URL string");
      }
      const input = utf8Encoder.encode(canonicalUrl);
      if (utf8Decoder.decode(input) !== canonicalUrl) {
        throw new WasmCodecError("invalid-utf8", "Canonical URL is not stable under UTF-8 encoding");
      }
      return transform("encode", input, limits.canonicalUrlBytes, limits.payloadBytes);
    },

    decode (payload: Uint8Array) {
      const output = transform("decode", payload, limits.payloadBytes, limits.canonicalUrlBytes);
      try {
        return utf8Decoder.decode(output);
      } catch (cause) {
        throw poison("invalid-utf8", "Codec produced invalid UTF-8", cause);
      }
    }
  });
}

export async function instantiateWasmCodec (
  source: WasmSource,
  options: WasmCodecLimits = {}
): Promise<LoadedCodec> {
  let module;
  try {
    module = source instanceof WebAssembly.Module
      ? source
      : await WebAssembly.compile(source);
  } catch (cause) {
    throw new WasmCodecError("invalid-module", "Codec is not a valid WebAssembly module", { cause });
  }
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    const names = imports.map(entry => `${entry.module}.${entry.name}`).join(", ");
    throw new WasmCodecError("forbidden-imports", `Codec modules must have no imports: ${names}`);
  }
  const requiredExports = new Map([
    ["memory", "memory"],
    ["minug_alloc", "function"],
    ["minug_free", "function"],
    ["minug_encode", "function"],
    ["minug_decode", "function"]
  ]);
  const seenRequiredExports = new Set();
  for (const entry of WebAssembly.Module.exports(module)) {
    const requiredKind = requiredExports.get(entry.name);
    if (requiredKind !== undefined) {
      if (entry.kind !== requiredKind) {
        throw new WasmCodecError(
          "invalid-exports",
          `${entry.name} must be exported as ${requiredKind}, received ${entry.kind}`
        );
      }
      seenRequiredExports.add(entry.name);
    } else if (entry.kind !== "global") {
      throw new WasmCodecError(
        "unexpected-export",
        `Codec modules may not export extra ${entry.kind} ${entry.name}`
      );
    }
  }
  for (const name of requiredExports.keys()) {
    if (!seenRequiredExports.has(name)) {
      throw new WasmCodecError("invalid-exports", `Codec module is missing required export ${name}`);
    }
  }
  let instance;
  try {
    instance = await WebAssembly.instantiate(module, {});
  } catch (cause) {
    throw new WasmCodecError("instantiation-failed", "Codec could not be instantiated", { cause });
  }
  return createWasmCodecAdapter(instance.exports, options);
}
