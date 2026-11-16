/**
 * Personal greeting for invited players (staging build with access gate only).
 * Asks /api/greeting for the name belonging to the visitor's own access cookie and
 * puts it into the hero headline ("Max, wir wollen dich …"). The name is inserted with
 * textContent – never as HTML. No name / no JS / any error → the normal headline stays.
 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function greet() {
  const h1 = document.querySelector<HTMLElement>('h1[data-greeting]');
  if (!h1) return;
  try {
    const res = await fetch('/api/greeting', {
      cache: 'no-store',
      credentials: 'same-origin',
      // CloudFront Origin Access Control signs requests to the Lambda URL and needs the body hash.
      headers: { 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    if (!res.ok) return;
    const { name } = (await res.json()) as { name?: unknown };
    if (typeof name !== 'string' || !name.trim()) return;
    h1.textContent = h1.dataset.greeting!.replace('{name}', name.trim());
    h1.classList.add('greeted');
  } catch {
    /* keep the normal headline */
  }
}

greet();
