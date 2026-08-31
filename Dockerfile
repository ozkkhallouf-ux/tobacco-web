# syntax=docker/dockerfile:1

# tobacco-web is a static, build-free site (no bundler, no runtime npm deps —
# scripts/serve.mjs only uses Node's built-in http/fs modules). This Dockerfile
# containerizes only that static dev server. playwright (the sole devDependency,
# used by `npm run check` / `npm run generate` for PDF generation) needs a
# Chromium install and is intentionally NOT installed here — those commands stay
# on the host per the approved scope (Dockerfile + .dockerignore + compose only).

# Pinned by digest (not just the "24-alpine" tag) so a rebuild always gets the
# exact same base image bytes — that tag is mutable upstream and can point to a
# different image tomorrow. To update deliberately later: `docker pull
# node:24-alpine`, read the new digest from `docker inspect node:24-alpine
# --format '{{index .RepoDigests 0}}'`, and paste it in below (or let a bot like
# Renovate/Dependabot do this automatically — both support digest pinning).
ARG NODE_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# ---- build stage: assemble the app files that the runtime actually serves ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY index.html 404.html privacy-policy.html terms-of-use.html receipt.html \
     robots.txt sitemap.xml service-worker.js ./
COPY src ./src
COPY public ./public
COPY scripts/serve.mjs ./scripts/serve.mjs

# ---- runtime stage: minimal, non-root, only what's needed to serve ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node:24-alpine already ships an unprivileged "node" user (uid 1000); give it
# ownership of the files it serves instead of leaving them root-owned.
COPY --from=build --chown=node:node /app ./

USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
