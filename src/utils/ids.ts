import { randomBytes } from 'node:crypto';

export function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}
