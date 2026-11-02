import 'server-only';
import { randomInt } from 'node:crypto';

export const generatePin = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// Readable: no 0/O, 1/l/I.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const generatePassword = (length = 14) => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
