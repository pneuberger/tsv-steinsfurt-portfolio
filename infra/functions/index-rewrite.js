// CloudFront Function (viewer request, cloudfront-js-2.0).
// CloudFront only serves index.html for the root, so map directory URLs to their index file:
//   /en/  -> /en/index.html
//   /en   -> /en/index.html
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/') + 1) {
    // no file extension in the last path segment
    request.uri = uri + '/index.html';
  }
  return request;
}
