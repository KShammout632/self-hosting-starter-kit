import { z } from 'zod';
import { agentRequest, type AgentRequest } from './actions';

export const ERROR_CODES = [
  'invalid_json',
  'invalid_request',
  'unknown_action',
  'request_too_large',
  'confirm_required',
  'not_implemented',
  'busy',
  'docker_unavailable',
  'not_installed',
  'failed',
] as const;
export const errorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCode>;

// Replies are newline-delimited JSON. A streaming action sends chunks, then end.
export const agentResponse = z.union([
  z.object({ id: z.string().nullable(), ok: z.literal(true), data: z.unknown().optional() }),
  z.object({
    id: z.string().nullable(),
    ok: z.literal(false),
    error: z.object({ code: errorCode, message: z.string() }),
  }),
  z.object({ id: z.string(), chunk: z.unknown() }),
  z.object({ id: z.string(), end: z.literal(true) }),
]);
export type AgentResponse = z.infer<typeof agentResponse>;

export type ParsedRequest =
  | { ok: true; request: AgentRequest }
  | { ok: false; id: string | null; code: ErrorCode; message: string };

export function parseRequest(line: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: 'invalid_json', message: 'Request is not valid JSON.' };
  }

  const parsed = agentRequest.safeParse(raw);
  if (parsed.success) return { ok: true, request: parsed.data };

  const object = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = typeof object.id === 'string' && object.id.length <= 64 ? object.id : null;
  const unknownAction = parsed.error.issues.some((issue) => issue.code === 'invalid_union');
  return {
    ok: false,
    id,
    code: unknownAction ? 'unknown_action' : 'invalid_request',
    message: unknownAction ? 'Unknown action.' : 'Request arguments are not valid.',
  };
}
