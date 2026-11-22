import type { ErrorCode } from '@selfhost/shared';

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
