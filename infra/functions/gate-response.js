// CloudFront Function (viewer response, cloudfront-js-2.0).
// When a page was opened via an invite link (?t=<token>) and the gate let it through,
// store the token in a cookie so reloads and subpages work without the query string.
// Deliberately no redirect: link previews (WhatsApp etc.) then see the real page.
// The cookie holds only link id + expiry + signature – no personal data.
function handler(event) {
  const response = event.response;
  const q = event.request.querystring;
  const token = q.t && q.t.value;
  if (!token || response.statusCode !== 200) return response;

  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[1])) return response;
  const maxAge = parseInt(parts[1], 10) - Math.floor(Date.now() / 1000);
  if (maxAge <= 0) return response;

  response.cookies['tsv_zugang'] = {
    value: token,
    attributes: 'Path=/; Max-Age=' + maxAge + '; Secure; HttpOnly; SameSite=Lax',
  };
  return response;
}
