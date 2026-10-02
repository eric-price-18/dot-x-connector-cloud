# Integrating with a supported Sites starter

The custom overlay was verified locally on a freshly generated supported Vinext starter; it was not registered or deployed.

The frontend core contains ordinary JavaScript modules. Its UI expects a private, owner-authenticated Site with a D1 binding. The public package omits platform build helpers, authentication implementations, connector-runtime helpers, generated project metadata and starter UI libraries.

## Integration points

1. Create a private Site using the currently supported starter in your own account. Keep its generated authentication and hosting components.
2. Add the custom connector modules and a minimal owner setup page. Add only the declared npm dependencies using the generated starter's supported package workflow.
3. Add the connector's `service_identity` schema to the Site database and apply the empty-schema migration. Do not import anyone else's database.
4. Route `POST /mcp` to the custom MCP handler. Route `/api/service-setup` to the custom setup handler before the normal application handler. Preserve the response wrapper that denies framing and suppresses referrer leakage.
5. Retain the starter's trusted, server-injected owner identity. A public server that simply accepts client-supplied `oai-authenticated-*` headers is unsafe. Do not treat a client header, email argument or supplied account ID as authentication.
6. Set the frontend configuration to your own origin, owner identity and fixed backend endpoints. Use the same public issuer, subject, audience and paths on both sides.
7. Initialize the frontend key through the authenticated owner setup flow. Only its public key is copied to the backend pin. Do not copy test fixtures or another deployment's pin.
8. Run the exported core tests and backend/frontend interoperability tests. Build and check the full generated Site with all live/write flags off. Confirm anonymous and other-user rejection before any enablement.

The custom setup wrapper contains only the connector-specific routing and security additions. It does not replace the generated starter's request context or authentication implementation.

## Verification boundary

The backend and connector-core tests are independently testable. Full frontend reproducibility also requires the supported starter and private hosting/authentication access. This is an overlay workflow rather than a standalone frontend deployment. The shipped helper rejects a changed starter Worker shape instead of guessing how to patch it.

## Exact local verification sequence

Generate an empty, unregistered supported starter through the platform's current
workflow. From the public `frontend` directory, apply the overlay with
`node scripts/apply-sites-overlay.mjs /absolute/path/to/fresh-starter`.
Inside that starter, synchronize its changed lockfile with
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then use
the supported dependency installer. The tested starter has no `typecheck`
script: use its installed compiler with `npm exec -- tsc --noEmit`, then
`npm run build`. Back in the public `frontend` directory, run
`node scripts/check-sites-overlay.mjs /absolute/path/to/built-starter`.

These operations are local only. Registration, deployment, D1 provisioning,
private sharing, key initialization and OAuth consent are separate steps.
