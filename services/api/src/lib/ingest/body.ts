import { ApiError } from '@z-cloudbase/contracts';

/** Size of `value` as UTF-8 JSON, the unit all ingestion limits are expressed in. */
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Read a JSON batch body, rejecting oversized (413) or malformed (400) payloads before any parsing work. */
export async function readBatchBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new ApiError('payload_too_large', `Batch exceeds ${maxBytes} bytes`);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ApiError('payload_too_large', `Batch exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('invalid_request', 'Body must be valid JSON');
  }
}
