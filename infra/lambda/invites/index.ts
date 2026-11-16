/**
 * Invite-link API for the committee form (/admin/).
 * Reached via CloudFront /api/* → Lambda Function URL (Origin Access Control).
 *
 *   GET  /api/invites               list invites
 *   POST /api/invites               create  { name, days, createdBy? } → { id, token, expiresAt }
 *   POST /api/invites/{id}/revoke   revoke one invite
 *
 * Auth: header x-admin-password (the Authorization header is taken by the OAC signature),
 * checked against a scrypt hash in SSM. Tokens are signed with the HMAC secret from the
 * CloudFront KeyValueStore – the same key the gate function uses.
 */
import { randomBytes, createHmac, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import '@aws-sdk/signature-v4a'; // KeyValueStore API requires SigV4A signing

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const { TABLE_NAME, KVS_ARN, PASSWORD_PARAM } = process.env as Record<string, string>;
const MAX_DAYS = 60;
const DEFAULT_DAYS = 14;
const RETAIN_AFTER_EXPIRY = 30 * 24 * 3600; // DynamoDB TTL: delete 30 days after expiry

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const kvs = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

// Short-lived cache: after `staging:setup --rotate-secret` / `--new-password` all Lambda
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

function newId(): string {
  return randomBytes(6).toString('base64url'); // 8 chars [A-Za-z0-9_-]
}

async function revokeInKvs(id: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
    try {
      await kvs.send(new PutKeyCommand({ KvsARN: KVS_ARN, Key: `revoked:${id}`, Value: '1', IfMatch: ETag }));
      return;
    } catch (e) {
      if ((e as { name?: string }).name !== 'ConflictException') throw e;
    }
  }
  throw new Error('KeyValueStore busy, please retry');
}

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '');

  if (!(await checkPassword(event.headers['x-admin-password']))) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    return json(401, { error: 'Falsches Passwort' });
  }

  if (method === 'GET' && path === '/api/invites') {
    // ConsistentRead: a link created a moment ago must show up in the list right away.
    const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ConsistentRead: true }));
    Items.sort((a, b) => b.createdAt - a.createdAt);
    return json(200, Items.map(({ id, name, createdBy, createdAt, expiresAt, revoked }) => ({ id, name, createdBy, createdAt, expiresAt, revoked: !!revoked })));
  }

  if (method === 'POST' && path === '/api/invites') {
    let input: { name?: unknown; days?: unknown; createdBy?: unknown } = {};
    try {
      input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}');
    } catch {
      return json(400, { error: 'Ungültige Anfrage' });
    }
    const name = clean(input.name, 40);
    if (!name) return json(400, { error: 'Bitte einen Namen bzw. ein Kürzel angeben' });
    const days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(input.days) || DEFAULT_DAYS)));
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + days * 24 * 3600;
    const id = newId();
    const sig = createHmac('sha256', await getSecret()).update(`${id}.${expiresAt}`).digest('hex').slice(0, 32);
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { id, name, createdBy: clean(input.createdBy, 40), createdAt: now, expiresAt, ttl: expiresAt + RETAIN_AFTER_EXPIRY },
      ConditionExpression: 'attribute_not_exists(id)',
    }));
    return json(201, { id, token: `${id}.${expiresAt}.${sig}`, expiresAt });
  }

  const revoke = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{8})\/revoke$/);
  if (method === 'POST' && revoke) {
    const id = revoke[1];
    await revokeInKvs(id);
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME, Key: { id },
      UpdateExpression: 'SET revoked = :t', ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':t': true },
    })).catch(() => undefined); // already deleted by TTL → revocation in KVS is what matters
    return json(200, { id, revoked: true });
  }

  return json(404, { error: 'Nicht gefunden' });
}
