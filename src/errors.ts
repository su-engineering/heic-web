/**
 * Typed error hierarchy. The parser consumes hostile input and the decode path
 * fails in browser-specific ways, so every throw carries enough context to file
 * a useful bug report without the reporter having to reproduce it.
 */

export interface HeicErrorContext {
  /** ftyp major brand, when we got far enough to read it. */
  brand?: string | undefined;
  /** item_type of the item being worked on ('grid', 'hvc1', ...). */
  itemType?: string | undefined;
  /** Item ID being worked on. */
  itemId?: number | undefined;
  /** Strategy that produced the failure. */
  strategy?: string | undefined;
  /** Codec string handed to VideoDecoder. */
  codec?: string | undefined;
  /** Byte offset in the source buffer, for parse failures. */
  offset?: number | undefined;
  /** Four-character box type being read, for parse failures. */
  box?: string | undefined;
}

export class HeicError extends Error {
  readonly context: HeicErrorContext;

  constructor(message: string, context: HeicErrorContext = {}, options?: ErrorOptions) {
    const detail = formatContext(context);
    super(detail ? `${message} (${detail})` : message, options);
    this.name = 'HeicError';
    this.context = context;
  }
}

/** The file is malformed, truncated, or uses a container feature we refuse to guess at. */
export class HeicParseError extends HeicError {
  constructor(message: string, context: HeicErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = 'HeicParseError';
  }
}

/** The file is well-formed but this environment cannot decode it. */
export class HeicUnsupportedError extends HeicError {
  /** Strategies that were tried, and why each one was unavailable or failed. */
  readonly attempts: ReadonlyArray<{ strategy: string; reason: string }>;

  constructor(
    message: string,
    attempts: ReadonlyArray<{ strategy: string; reason: string }> = [],
    context: HeicErrorContext = {},
    options?: ErrorOptions,
  ) {
    const summary = attempts.map((a) => `${a.strategy}: ${a.reason}`).join('; ');
    super(summary ? `${message} [${summary}]` : message, context, options);
    this.name = 'HeicUnsupportedError';
    this.attempts = attempts;
  }
}

/** A decoder was available and accepted the config, but decoding failed. */
export class HeicDecodeError extends HeicError {
  constructor(message: string, context: HeicErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = 'HeicDecodeError';
  }
}

/** The caller's AbortSignal fired. */
export class HeicAbortError extends HeicError {
  constructor(message = 'Decode aborted', context: HeicErrorContext = {}, options?: ErrorOptions) {
    super(message, context, options);
    this.name = 'HeicAbortError';
  }
}

function formatContext(context: HeicErrorContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}
