# dsh-phalanx development

Follow `docs/architecture.md`, including all ten laws. Integrate the external
DeepSeek Harness only through its official CLI, configuration, HTTP and
WebSocket seams. The supported revision is declared in `runtime-versions.json`;
do not edit, vendor or import its private implementation.

Run affected acceptance and regression tests, typecheck, lint and both builds
before committing. Preserve quick fake-port use-case tests and public-entry
acceptance. Run the complete quick suite for broad changes. Actual DSH behavior
requires real DSH tests; container and installed-host claims require Linux.
Use deterministic handshakes or injected clocks for functional assertions.

Keep credentials, real deployment configuration, host identities and user data
out of source and history. Use fictional values in examples and fixtures.
Review changes independently for architecture and intended behavior, fix
findings, and repeat affected checks. Keep commit identities public.
