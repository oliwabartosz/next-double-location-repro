# Duplicate `location` / `link` headers on an on-demand prerender (cacheComponents)

With `cacheComponents: true`, a dynamic App Router page that is prerendered on demand at
runtime (`next start`, cache MISS) sends every header the prerender set **twice**. For a page
that calls `permanentRedirect()` this means a 308 with two `location` lines; with a
`next/font/google` font in the layout, every such page (200 or 308) also sends two `link`
preload lines. The next request for the same URL (cache HIT) sends each header once.

RFC 9110 allows a single `Location`. Node's `fetch` (undici) joins the two lines into
`"/r/bar, /r/bar"`, which is not a valid URL reference.

Reproduces on `next@16.4.0`, `16.4.1`, `16.5.0-canary.11` and `16.5.0-canary.12`
(react/react-dom 19.3.0, Node 24.21.0, Linux x64).

## The app

- `next.config.ts`: `cacheComponents: true`, nothing else.
- `app/layout.tsx`: root layout with `Geist` from `next/font/google` (source of the `link`
  preload header; the build fetches it from Google Fonts). Removing the font still
  reproduces the doubled `location`.
- `app/r/[slug]/page.tsx`: `generateStaticParams` returns one placeholder param, so every
  real slug is prerendered on its first request. The page awaits `params`, calls a
  `'use cache'` function (`cacheLife('days')`, `cacheTag(...)`) that returns
  `{ kind: 'page' | 'redirect' | 'not-found' }`, then calls `permanentRedirect()` /
  `notFound()` outside the cache scope, before any JSX. Slugs ending in `-old` redirect to
  the slug without the suffix. No `loading.tsx`, no Suspense.

## Steps

```sh
npm install
npx next build
npx next start -p 3101

# first request for the slug (MISS), then the same URL again (HIT)
curl -sS -D - -o /dev/null http://localhost:3101/r/foo-old
curl -sS -D - -o /dev/null http://localhost:3101/r/foo-old

# what a fetch client sees, on a slug not requested before
node -e "const go=()=>fetch('http://localhost:3101/r/bar-old',{redirect:'manual'}).then(r=>console.log(r.status, JSON.stringify(r.headers.get('location')), r.headers.get('x-nextjs-cache')));go().then(go)"
```

## Expected

Every response carries one `location: /r/foo` (and one `link`), MISS or HIT.

## Actual

MISS (first request):

```
HTTP/1.1 308 Permanent Redirect
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
location: /r/foo
location: /r/foo
link: </_next/static/media/caa3a2e1cccd8315-s.p.0wgildi0cnwt9.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"
link: </_next/static/media/caa3a2e1cccd8315-s.p.0wgildi0cnwt9.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"
x-nextjs-cache: MISS
x-nextjs-prerender: 1
x-nextjs-stale-time: 300
X-Powered-By: Next.js
Cache-Control: s-maxage=86400, stale-while-revalidate=518400
ETag: "ezthijjbnf4x9"
Content-Type: text/html; charset=utf-8
Content-Length: 6381
```

HIT (second request):

```
HTTP/1.1 308 Permanent Redirect
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
x-nextjs-cache: HIT
x-nextjs-prerender: 1
location: /r/foo
link: </_next/static/media/caa3a2e1cccd8315-s.p.0wgildi0cnwt9.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"
x-nextjs-stale-time: 300
X-Powered-By: Next.js
Cache-Control: s-maxage=86400, stale-while-revalidate=518400
ETag: "ezthijjbnf4x9"
Content-Type: text/html; charset=utf-8
Content-Length: 6381
```

fetch:

```
308 "/r/bar, /r/bar" MISS
308 "/r/bar" HIT
```

A 200 page on its first request (`/r/baz`) gets the same doubled `link` header.

## Cause

On a MISS the runtime renders the prerender against the live response. In
`next/dist/server/app-render/app-render.js` (16.4.0, around line 5218) the prerender's
`setHeader` both calls `res.setHeader(name, value)` and records the header in
`metadata.headers`. `next/dist/build/templates/app-page-runtime.js` (around line 1360,
`if (cachedData.headers) {`) then replays the new cache entry's headers onto the same `res`
with `res.appendHeader`, so each one is sent twice. A HIT only replays, so it sends one.

Skipping a replayed header that `res` already carries with the same value
(`if (res.hasHeader(key) && String(res.getHeader(key)) === String(value)) continue;` in
that loop, in both the CJS and ESM templates, before `next build`) brings the MISS down to
one `location` and one `link`.

## Variants tried (all on 16.4.0)

| Variant | Result |
| --- | --- |
| This app (font in the layout) | `location` and `link` doubled on MISS, single on HIT; `link` doubled on a 200 MISS too |
| Without the font | `location` doubled on MISS, single on HIT |
| Without the font and without `'use cache'` (plain async function) | `location` doubled on MISS, single on HIT |
| This app plus `partialPrefetching: true`, `export const ensureStatic = 'navigation'`, `export const instant = false` | same as this app |
| Without `generateStaticParams` | build fails (blocking-prerender error) |
| Without `generateStaticParams`, with `instant = false` | no ISR entry: 200 with `x-nextjs-postponed: 1`, no 308 |
| This app plus `partialPrefetching: true` alone | first request 200 (`x-nextjs-postponed: 1`, the redirect only in the stream); later requests 308 HIT with **no** `location` header at all (a separate issue) |
