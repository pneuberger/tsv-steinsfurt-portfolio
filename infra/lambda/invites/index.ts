/**
 * Invite-link API for the committee form (/admin/).
 * Reached via CloudFront /api/* → Lambda Function URL (Origin Access Control).
 *
 *   GET  /api/invites               list invites
 *   POST /api/invites               create  { name, hours (24|48), createdBy? } → { id, token, expiresAt }
 *   POST /api/invites/{id}/revoke   revoke one invite
 *   POST /api/invites/revoke-all    EMERGENCY STOP: revoke every active invite and rotate the
 *                                   HMAC secret (also kills links that are no longer in the table)
 *   GET  /api/greeting              PUBLIC (no password): { name } for the visitor's own valid,
 *                                   non-revoked access cookie – used to greet invited players
 *   GET  /api/invites/{id}/check    is the revocation already in effect at the edge?
 *                                   (the revocation list in the KeyValueStore needs ~20–60 s
 *                                   to reach all edge locations; this calls the site with the
 *                                   revoked link and records when it is rejected)
 *
 * Auth: header x-admin-password (the Authorization header is taken by the OAC signature),
 * checked against a scrypt hash in SSM. Tokens are signed with the HMAC secret from the
 * CloudFront KeyValueStore – the same key the gate function uses.
 */
import { randomBytes, createHmac, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import '@aws-sdk/signature-v4a'; // KeyValueStore API requires SigV4A signing

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const { TABLE_NAME, KVS_ARN, PASSWORD_PARAM, SITE_URL_PARAM } = process.env as Record<string, string>;
// Link validity: the committee can only choose 24 or 48 hours; anything else falls back to 24.
const ALLOWED_HOURS = [24, 48];
const DEFAULT_HOURS = 24;
const RETAIN_AFTER_EXPIRY = 30 * 24 * 3600; // DynamoDB TTL: delete 30 days after expiry

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const kvs = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

// Short-lived cache: after `prod:setup` / `staging:setup --rotate-secret` / `--new-password` all Lambda
// instances pick up the new values within a minute.
const CACHE_MS = 60_000;
const cache = new Map<string, { value: string; at: number }>();
async function cached(key: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (value) cache.set(key, { value, at: Date.now() });
  return value;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

async function checkPassword(given: string | undefined): Promise<boolean> {
  const passwordHash = await cached('pw', async () =>
    (await ssm.send(new GetParameterCommand({ Name: PASSWORD_PARAM, WithDecryption: true }))).Parameter?.Value);
  if (!passwordHash || !given) return false;
  // format: scrypt$<N>$<saltHex>$<hashHex>
  const [algo, n, saltHex, hashHex] = passwordHash.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(given, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

async function getSecret(): Promise<string> {
  const secret = await cached('secret', async () => (await kvs.send(new GetKeyCommand({ KvsARN: KVS_ARN, Key: 'secret' }))).Value);
  if (!secret) throw new Error('HMAC secret missing in KeyValueStore');
  return secret;
}

async function getSiteUrl(): Promise<string> {
  const url = await cached('site', async () =>
    (await ssm.send(new GetParameterCommand({ Name: SITE_URL_PARAM }))).Parameter?.Value);
  if (!url) throw new Error('Site URL missing in SSM');
  return url;
}

async function sign(id: string, expiresAt: number): Promise<string> {
  const sig = createHmac('sha256', await getSecret()).update(`${id}.${expiresAt}`).digest('hex').slice(0, 32);
  return `${id}.${expiresAt}.${sig}`;
}

/** Ask the nearest edge (Frankfurt for this Lambda) whether the revoked link is still let through. */
async function rejectedAtEdge(token: string): Promise<boolean> {
  const res = await fetch(`${await getSiteUrl()}/?t=${encodeURIComponent(token)}`, {
    method: 'HEAD',
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  return res.status !== 200; // gate answers 302 → /no-access/ once the revocation has arrived
}

function newId(): string {
  return randomBytes(6).toString('base64url'); // 8 chars [A-Za-z0-9_-]
}

/** Write one key to the KeyValueStore (optimistic locking via ETag, retried on conflicts). */
async function putKvs(key: string, value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
    try {
      await kvs.send(new PutKeyCommand({ KvsARN: KVS_ARN, Key: key, Value: value, IfMatch: ETag }));
      return;
    } catch (e) {
      if ((e as { name?: string }).name !== 'ConflictException') throw e;
    }
  }
  throw new Error('KeyValueStore busy, please retry');
}

const revokeInKvs = (id: string) => putKvs(`revoked:${id}`, '1');

/** Mark one invite as revoked in the table (no-op if it was already deleted by TTL). */
async function markRevoked(id: string, now: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME, Key: { id },
    UpdateExpression: 'SET revoked = :t, revokedAt = if_not_exists(revokedAt, :now)', ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':t': true, ':now': now },
  })).catch(() => undefined); // already deleted by TTL → revocation in KVS is what matters
}

/** Name for a valid, non-revoked access token (from the visitor's tsv_zugang cookie), else undefined. */
async function nameForToken(token: string | undefined): Promise<string | undefined> {
  if (!token || token.length > 80) return undefined;
  const [id, exp, sig] = token.split('.');
  if (!/^[A-Za-z0-9_-]{8}$/.test(id ?? '') || !/^\d{10}$/.test(exp ?? '') || !/^[0-9a-f]{32}$/.test(sig ?? '')) return undefined;
  if (Number(exp) <= Math.floor(Date.now() / 1000)) return undefined;
  const expected = Buffer.from((await sign(id, Number(exp))).split('.')[2]);
  if (!timingSafeEqual(Buffer.from(sig), expected)) return undefined;
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { id }, ConsistentRead: true }));
  if (!Item || Item.revoked || Item.expiresAt !== Number(exp)) return undefined; // revoked → no greeting, immediately
  return typeof Item.name === 'string' ? Item.name : undefined;
}

function cookie(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const all = [...(event.cookies ?? []), ...(event.headers.cookie ?? '').split(';')];
  for (const c of all) {
    const [k, ...v] = c.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '');

  // Public: greet invited players by name. Only answers for the caller's own valid cookie.
  if (method === 'GET' && path === '/api/greeting') {
    const name = await nameForToken(cookie(event, 'tsv_zugang')).catch(() => undefined);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private' },
      body: JSON.stringify(name ? { name } : {}),
    };
  }

  if (!(await checkPassword(event.headers['x-admin-password']))) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    return json(401, { error: 'Falsches Passwort' });
  }

  if (method === 'GET' && path === '/api/invites') {
    // ConsistentRead: a link created a moment ago must show up in the list right away.
    const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ConsistentRead: true }));
    Items.sort((a, b) => b.createdAt - a.createdAt);
    return json(200, Items.map(({ id, name, createdBy, createdAt, expiresAt, revoked, revokedAt, effectiveAt }) =>
      ({ id, name, createdBy, createdAt, expiresAt, revoked: !!revoked, revokedAt, effectiveAt })));
  }

  if (method === 'POST' && path === '/api/invites') {
    let input: { name?: unknown; hours?: unknown; createdBy?: unknown } = {};
    try {
      input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}');
    } catch {
      return json(400, { error: 'Ungültige Anfrage' });
    }
    const name = clean(input.name, 40);
    if (!name) return json(400, { error: 'Bitte einen Namen bzw. ein Kürzel angeben' });
    const hours = ALLOWED_HOURS.includes(Number(input.hours)) ? Number(input.hours) : DEFAULT_HOURS;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + hours * 3600;
    const id = newId();
    const token = await sign(id, expiresAt);
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { id, name, createdBy: clean(input.createdBy, 40), createdAt: now, expiresAt, ttl: expiresAt + RETAIN_AFTER_EXPIRY },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
    return json(201, { id, token, expiresAt });
  }

  const revoke = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{8})\/revoke$/);
  if (method === 'POST' && revoke) {
    const id = revoke[1];
    await revokeInKvs(id);
    await markRevoked(id, Math.floor(Date.now() / 1000));
    return json(200, { id, revoked: true });
  }

  // Emergency stop: revoke every active invite (same path as single revocation, so the list and
  // /check keep working), then rotate the HMAC secret so that even links missing from the table die.
  if (method === 'POST' && path === '/api/invites/revoke-all') {
    const now = Math.floor(Date.now() / 1000);
    const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ConsistentRead: true }));
    const active = Items.filter((i) => !i.revoked && i.expiresAt > now);
    for (const inv of active) {
      await revokeInKvs(inv.id);
      await markRevoked(inv.id, now);
    }
    const secret = randomBytes(32).toString('hex');
    await putKvs('secret', secret);
    cache.set('secret', { value: secret, at: Date.now() }); // this instance signs with the new secret right away
    return json(200, { revoked: active.length });
  }

  const check = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{8})\/check$/);
  if (method === 'GET' && check) {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: check[1] }, ConsistentRead: true }));
    if (!Item) return json(404, { error: 'Nicht gefunden' });
    if (!Item.revoked) return json(409, { error: 'Link ist nicht gesperrt' });
    const revokedAt: number | undefined = Item.revokedAt;
    if (Item.effectiveAt) return json(200, { id: Item.id, effective: true, revokedAt, effectiveAt: Item.effectiveAt });
    if (!(await rejectedAtEdge(await sign(Item.id, Item.expiresAt)))) return json(200, { id: Item.id, effective: false, revokedAt });
    const effectiveAt = Math.floor(Date.now() / 1000);
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: { id: Item.id },
      UpdateExpression: 'SET effectiveAt = if_not_exists(effectiveAt, :now)',
      ExpressionAttributeValues: { ':now': effectiveAt },
    }));
    return json(200, { id: Item.id, effective: true, revokedAt, effectiveAt });
  }

  return json(404, { error: 'Nicht gefunden' });
}
