// CloudFront Function (viewer request, cloudfront-js-2.0) – access gate for invite links.
// Only used where the access gate is enabled (staging). Production keeps index-rewrite.js.
//
// A request passes if it targets a public path or carries a valid invite token,
// either as ?t=<token> (first visit from the invite link) or as cookie tsv_zugang.
// Token: <id>.<exp>.<sig>   id  = 8 chars [A-Za-z0-9_-]
//                           exp = expiry, unix seconds
//                           sig = first 32 hex chars of HMAC-SHA256(secret, "<id>.<exp>")
// KeyValueStore keys: "secret" (HMAC key), "revoked:<id>" (any value = link revoked).
import cf from 'cloudfront';
import crypto from 'crypto';

const kvs = cf.kvs('__KVS_ID__');
const COOKIE = 'tsv_zugang';
const NO_ACCESS = '/kein-zugang/';

// Reachable without invitation: no-access page, legal pages, committee form,
// share preview image, crest/favicon, and the CSS/JS/fonts those pages need.
// Photos and videos are NOT public.
const PUBLIC = [
  /^\/kein-zugang(\/|\/index\.html)?$/,
  /^\/impressum(\/|\/index\.html)?$/,
  /^\/datenschutz(\/|\/index\.html)?$/,
  /^\/en\/legal-notice(\/|\/index\.html)?$/,
  /^\/en\/privacy(\/|\/index\.html)?$/,
  /^\/admin(\/|\/index\.html)?$/,
  /^\/og-image\.jpg$/,
  /^\/favicon\.(svg|ico)$/,
  /^\/logo\/[\w.-]+\.svg$/,
  /^\/_astro\/[\w.-]+\.(css|js|woff2?)$/,
];

function rewriteIndex(uri) {
  if (uri.endsWith('/')) return uri + 'index.html';
  if (uri.lastIndexOf('.') < uri.lastIndexOf('/') + 1) return uri + '/index.html';
  return uri;
}

function isHtml(uri) {
  return uri.endsWith('/') || uri.endsWith('.html') || uri.lastIndexOf('.') < uri.lastIndexOf('/') + 1;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isValid(token) {
  if (!token || token.length > 80) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const id = parts[0], exp = parts[1], sig = parts[2];
  if (!/^[A-Za-z0-9_-]{8}$/.test(id) || !/^\d{10}$/.test(exp) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  if (parseInt(exp, 10) <= Math.floor(Date.now() / 1000)) return false;
  let secret;
  try { secret = await kvs.get('secret'); } catch (e) { return false; } // fail closed
  const expected = crypto.createHmac('sha256', secret).update(id + '.' + exp).digest('hex').slice(0, 32);
  if (!safeEqual(sig, expected)) return false;
  try { if (await kvs.exists('revoked:' + id)) return false; } catch (e) { return false; }
  return true;
}

async function handler(event) {
  const request = event.request;
  const uri = request.uri;
  const rewritten = rewriteIndex(uri);

  if (PUBLIC.some((re) => re.test(uri) || re.test(rewritten))) {
    request.uri = rewritten;
    return request;
  }

  const fromQuery = request.querystring.t && request.querystring.t.value;
  const fromCookie = request.cookies[COOKIE] && request.cookies[COOKIE].value;
  if ((fromQuery && (await isValid(fromQuery))) || (fromCookie && (await isValid(fromCookie)))) {
    request.uri = rewritten;
    return request;
  }

  if (isHtml(uri)) {
    return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: NO_ACCESS }, 'cache-control': { value: 'no-store' } } };
  }
  return { statusCode: 403, statusDescription: 'Forbidden', headers: { 'cache-control': { value: 'no-store' } } };
}
