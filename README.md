<p align="center"><img src="web/munin-mark.svg" width="72" alt="Munin"></p>

# Munin

Project timelines for a research group: where a project started, what was decided and why, what was done and what it gave, with threads on every entry. The owner of a timeline chooses who may view, comment or edit.

## Install

```sh
cp munin.example.json data/munin.json   # set origin and the OpenID Connect provider
docker compose up -d --build
```

## Documentation

[docs/running.md](docs/running.md) and [docs/design.md](docs/design.md).

## Build

```sh
npm ci && npm test && npm run build
node dist/main.js serve --config munin.dev.json
```

## Related repositories

[bifrost](https://github.com/kineuro/bifrost), [nils](https://github.com/kineuro/nils)

## License

AGPL-3.0-only. See [CONTRIBUTING.md](CONTRIBUTING.md).
