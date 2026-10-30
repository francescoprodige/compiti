# Compiti di casa

App per vedere e spuntare i compiti presi dal registro Nuvola.

- `index.html`: l'app (GitHub Pages). Si apre col link di famiglia che contiene il codice di accesso.
- `scraper/nuvola.mjs`: legge Nuvola e aggiorna i dati. Gira da solo con GitHub Actions.

Segreti necessari (Settings → Secrets and variables → Actions):
`NUVOLA_USER`, `NUVOLA_PASS`, `IMPORT_SECRET`.
