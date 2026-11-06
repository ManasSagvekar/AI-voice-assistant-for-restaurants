import 'server-only';
import { randomBytes, randomInt } from 'node:crypto';

export const generatePin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// A password nobody knows, for an account whose owner is about to choose one from a link.
export const unknownPassword = () => randomBytes(32).toString('base64url');
