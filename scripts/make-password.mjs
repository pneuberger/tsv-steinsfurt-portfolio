// Generates a committee password and its scrypt hash for the invite API.
// Output (one line): "<password> <hash>"   – used by scripts/staging-setup.sh.
// Password: 4 groups of 5 chars without easily confused characters (0/O, 1/l/I), ~115 bits.
// Hash format: scrypt$<N>$<saltHex>$<hashHex>  (verified by infra/lambda/invites/index.ts)
import { randomInt, randomBytes, scryptSync } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const chars = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const password = chars.match(/.{5}/g).join('-');

const N = 32768;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, maxmem: 256 * 1024 * 1024 });

process.stdout.write(`${password} scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}\n`);
