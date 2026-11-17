// Committee password hash for the invite API – used by scripts/gate-setup.sh.
//   node make-password.mjs           → "<password> <hash>"  (random password)
//   node make-password.mjs --stdin   → "<hash>"             (password read from stdin, never printed)
// Random password: 4 groups of 5 chars without easily confused characters (0/O, 1/l/I), ~115 bits.
// Chosen passwords are NFC-normalised (an "ö" typed as o + combining diaeresis hashes the same);
// the API normalises the same way (infra/lambda/invites/index.ts).
// Hash format: scrypt$<N>$<saltHex>$<hashHex>
import { randomInt, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const N = 32768;
const hashOf = (password) => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
};

if (process.argv.includes('--stdin')) {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '').normalize('NFC');
  if (!password) { console.error('Kein Passwort übergeben'); process.exit(1); }
  process.stdout.write(`${hashOf(password)}\n`);
} else {
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chars = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const password = chars.match(/.{5}/g).join('-');
  process.stdout.write(`${password} ${hashOf(password)}\n`);
}
