# Estate Landscapers — Website

Static site with a zero-dependency build. Deployed to Cloudflare via Wrangler on every
push to `main`.

## Structure — where to edit what

```
src/
  layout.html         The page shell every normal page is wrapped in
  partials/           Shared chrome — EDIT HERE, every page updates on next build
    util-bar.html       top bar (licence line + email)
    nav-*.html          residential / commercial / shared navigation
    footer-*.html       the three footers
    infra-*.html        the Infra Landscapers handoff bands
  pages/              One file per page: a CONFIG header + that page's content only
build.js              node build.js → regenerates public/ (no dependencies)
public/               BUILT OUTPUT + static files. Only this folder is served.
  assets/               site.css, site.js, logos
  robots.txt, llms.txt  AI/search crawler files
  _headers              staging noindex — DELETE AT GO-LIVE
```

**Golden rule: never hand-edit a built HTML page in `public/`.** Edit `src/` and run
`node build.js`. The build overwrites `public/**/index.html` and `404.html`; hand edits
there are lost on the next build. Static files (assets, robots, llms, _headers) are not
touched by the build.

## Deploying

Push to `main`. Cloudflare runs the deploy command. Two options for the Cloudflare
build/deploy setting:

- Current: `npx wrangler deploy` — works because `public/` is committed pre-built.
- Better: `node build.js && npx wrangler deploy` — rebuilds from src on every deploy,
  so a src-only commit can never ship stale pages. One-line change in the Cloudflare
  project settings.

## Before go-live

- [ ] **Delete the noindex block in `public/_headers`** — while it exists Google and AI
      crawlers ignore the site. Deliberate for staging, fatal at launch.
- [ ] Replace photo slots (search `PHOTO SLOT` in src/pages)
- [ ] Swap PNG logos for SVG when vector artwork is available
- [ ] DNS cutover per `estate-dns-zone-reference.md`
- [ ] Submit sitemap.xml in Search Console (see INTEGRATION-SETUP.md §8)

## Build stages

1. ✅ Sitemap + front door
2. ✅ Residential landing + commercial landing
3. ✅ Modular build system · retaining-walls + builders-developers templates ·
      The Estate Standard · About · branded 404
4. ✅ Forms → Railway quote tool → OneDrive → acknowledgement emails
   (tool-side code ships in estate-quote-app-DEPLOY.zip — deploy both together)
5. ✅ All service + sector pages, area pages ×10, capabilities, Insights ×3,
      garden care, contact, privacy, terms, projects (noindex), sitemap.xml auto-generated
6. Mobile QA, Core Web Vitals, accessibility
7. DNS cutover

## Conventions

- Real URLs, folder-per-page, trailing slash; canonical host `www.estatelandscapers.com.au`
- Brand: `#1E5BFF` blue, black, white, `#F5F5F5`, Montserrat
- No stock photography of other people's landscaping; no unverified figures
- Every page: one `<h1>`, JSON-LD schema, FAQ in visible text where the page warrants it
