## In an Orb

- Run `.agents/setup` to install locked packages and Chromium, fetch keyless assets and build. `.agents/resume` only checks the built entry and asset manifest; rerun setup to repair them.
- Use `npm run fetch:assets` to regenerate `public/assets/`. The manifest records source URLs and fallbacks; do not check generated downloads into Git.
- Run `npm run typecheck` and `npm run build`, then `amp orb services ensure` to serve the **built** game on the `gt3-sim` portal. Rebuild after changing source; `npm run dev` is the separate Vite development server.
- Run `npm run verify:orb` against the running preview. Screenshots and measured telemetry go to ignored `qa-artifacts/`.
