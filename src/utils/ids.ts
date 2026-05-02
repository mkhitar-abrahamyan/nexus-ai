import { randomBytes } from 'crypto';

export function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}
