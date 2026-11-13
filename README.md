# TSV Steinsfurt – Recruitment One-Pager

A single scrolling page that wins new players (aged 16–40) for TSV Steinsfurt. It's built with **Astro** as a static site and hosted on **AWS** (S3 in `eu-central-1` / Frankfurt behind CloudFront). It's deployed by **GitHub Actions**.

- German at `/`, English at `/en/`. The DE/EN switch sits top right.
- No tracking and no cookies. Fonts are self-hosted.

## Local development

Requires the Node version in `.nvmrc` (currently 26.x LTS).

```sh
nvm use
npm install
npm run dev        # http://localhost:4321  (English: /en/)
npm run build      # static output in dist/
npm run preview
npx astro check    # type-check
```

## Editing content

| What | Where |
| --- | --- |
| All texts (per language) | `src/i18n/de.json`, `src/i18n/en.json` |
| Teams, offers, testimonials, contacts, training times | same JSON files (arrays) |
| Club colours, fonts, spacing | tokens at the top of `src/styles/global.css` |
| Gallery tiles (order and size) | `tiles` array in `src/components/sections/Gallery.astro` |
| Social links | `src/components/sections/Footer.astro` |
| Crest / favicon | `public/favicon.svg` (+ `favicon.ico`) |
| Social share image | `public/og-image.jpg` (1200×630) |
| Domain for canonical/SEO URLs | `site` in `astro.config.mjs` |

> ⚠️ The **Impressum** and **Datenschutz** texts in the JSON files are placeholders. Fill them in before going live (both are legally required in Germany).

### Replacing placeholder photos

Photos are referenced by a key (e.g. `"image": "team-erste"`). Put a real photo with the **same file name** into `src/assets/photos/` (e.g. `src/assets/photos/team-erste.jpg`). It automatically takes precedence over the placeholder in `src/assets/placeholders/`. Astro resizes the photos and converts them to WebP at build time.

### Videos

Clips live in `public/media/videos/`:

| File | Used for |
| --- | --- |
| `hero.mp4` + `hero-poster.jpg` | full-screen hero background |
| `clip-01.mp4` + `clip-01-poster.jpg`, `clip-02…` | gallery tiles |

Until an MP4 exists, its poster image is shown. Recommendations: 5–15 s, no sound needed, H.264 MP4, ≤ 1080p, ideally < 5 MB each. For example:

```sh
ffmpeg -i input.mov -t 12 -an -vf "scale=-2:1080" -c:v libx264 -crf 26 -preset slow -movflags +faststart hero.mp4
ffmpeg -i hero.mp4 -frames:v 1 -q:v 3 hero-poster.jpg
```

Clips autoplay muted only while visible and never for visitors who have "reduce motion" turned on.

### Content-Security-Policy

The page ships a strict CSP (`security.csp` in `astro.config.mjs`): only files from the site itself may load, and Astro adds hashes for its own scripts and styles on every build. Consequences:

- **Don't use inline `style="…"` attributes or `<script is:inline>`.** The browser blocks them. Use CSS classes or regular `<script>` blocks (bundled and hashed by Astro). For staggered reveal animations, put the `stagger` class on the parent element.
- **External content** (YouTube/Instagram embeds, a Google Maps iframe, analytics, external fonts) needs its origin added to the matching directive (`frame-src`, `img-src`, `script-src` …). Remember that this also needs the privacy policy updated.
- The CSP only applies to `npm run build` + `npm run preview`, not to `npm run dev`.

Other security headers (HSTS, X-Frame-Options, Permissions-Policy …) are set by CloudFront in `infra/lib/site-stack.ts`.

### Adding a language

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json` and translate it.
2. Register it in `src/i18n/index.ts`.
3. Add `<code>` to `i18n.locales` in `astro.config.mjs`.
4. Create `src/pages/<code>/index.astro` (copy of `src/pages/en/index.astro` with `lang="<code>"`).

TypeScript reports an error if a language file is missing keys.

## Hosting on AWS

Infrastructure is AWS CDK (TypeScript) in `infra/`:

- **S3 bucket** (eu-central-1, private, encrypted, versioned). It holds all HTML, images and videos.
- **CloudFront** with Origin Access Control (the bucket is never public), HTTPS, HTTP/2+3, compression, security headers, and a small CloudFront Function that maps `/en/` → `/en/index.html`. Price class 100 (EU + NA edges).
- **IAM role for GitHub Actions** via OIDC (no AWS keys stored in GitHub). It can only upload to this bucket and invalidate this distribution, and only from `main`.
- Optional: an **ACM certificate** plus **Route 53** records for a custom domain. CloudFront requires the certificate to be in `us-east-1`, so it goes in a separate tiny stack. It contains no content.

### One-time setup

You need AWS credentials for your account (e.g. `aws configure sso` or `aws configure` with a profile). The AWS CLI is optional for CDK but handy.

```sh
cd infra
nvm use
npm install

# 1. Bootstrap CDK once per account/region
AWS_PROFILE=<profile> npx cdk bootstrap aws://<ACCOUNT_ID>/eu-central-1
#    (with a custom domain, also: aws://<ACCOUNT_ID>/us-east-1)

# 2. Deploy (starts on the *.cloudfront.net URL)
AWS_PROFILE=<profile> npx cdk deploy --all
```

If your account **already has a GitHub OIDC provider** (`token.actions.githubusercontent.com`), deploy with `-c createGithubOidcProvider=false`.

**Custom domain (later):** if the domain's DNS is in Route 53, deploy with

```sh
npx cdk deploy --all -c domainName=www.tsv-steinsfurt.de -c hostedZoneId=Z0123… -c hostedZoneName=tsv-steinsfurt.de
```

(or put these values into `infra/cdk.json`). Then update `site` in `astro.config.mjs`.

### Cost alarm

An account-wide monthly budget (6 USD ≈ 5 €) e-mails you at 80 % and 100 % of actual spend, and when AWS forecasts the month will go over. The e-mail address is passed at deploy time and kept out of the (public) repo:

```sh
AWS_PROFILE=<profile> npx cdk deploy TsvSteinsfurtBudget -c budgetEmail=you@example.com [-c budgetLimitUsd=6]
```

`cdk deploy --all` without `budgetEmail` leaves the existing budget untouched.

### Connect GitHub

Copy the stack outputs into **GitHub → Settings → Secrets and variables → Actions → Variables**:

| Variable | Stack output |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` |
| `AWS_S3_BUCKET` | `BucketName` |
| `AWS_CLOUDFRONT_DISTRIBUTION_ID` | `DistributionId` |

From then on, every push to `main` builds the site, uploads it to S3 (hashed assets cached forever, media for 1 day, HTML always revalidated) and invalidates CloudFront. Pull requests are only built and type-checked.

## Project structure

```
src/
  pages/index.astro, pages/en/index.astro   # both render the same OnePage
  components/OnePage.astro                  # section order
  components/sections/*.astro               # Hero, About, Teams, Offer, Gallery, Testimonials, Training, Contact, Footer
  components/ui/                            # VideoClip, Wave divider
  i18n/                                     # texts + helpers
  lib/images.ts                             # image key → photo/placeholder lookup
  scripts/interactions.ts                   # scroll reveal, in-view video, counters, lightbox, dialogs
  styles/global.css                         # design tokens + base styles
public/media/videos/                        # clips + posters
infra/                                      # AWS CDK app
.github/workflows/deploy.yml                # CI/CD
```
