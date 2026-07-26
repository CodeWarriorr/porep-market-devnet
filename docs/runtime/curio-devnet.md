# Curio DevNet runtime

This is a local, test-only Filecoin/Curio machine. The generated keys and
contracts are not production credentials or deployments.

## Lifecycle

```sh
just bootstrap
just build
just up
just status
just deploy
just test-contracts
just test-e2e suite=contract
just test-all
just test-fresh
just logs
just down
just reset
```

`up` and `down` preserve bind-mounted chain, miner, Curio, database, and
contract-bootstrap state. `reset` keeps bounded logs and identity JSON under
`.runtime/reset-evidence/`, deletes disposable chain/private identity state,
creates a new runtime generation, and preserves public deployment revisions,
scenario runs, managed sources, images, the build manifest, and proof
parameters.

## Endpoints

- Filecoin/FEVM JSON-RPC: `http://127.0.0.1:2234/rpc/v1`
- Lotus Miner API: `127.0.0.1:22345`
- Curio API: `127.0.0.1:22300`
- Curio Market 2.0: `http://127.0.0.1:22310`
- Curio UI: `http://127.0.0.1:24701`
- piece server: `http://127.0.0.1:22320`
- Yugabyte YSQL/UI: `127.0.0.1:25433` / `http://127.0.0.1:25434`
- indexer ports: `127.0.0.1:23000-23003`

The chain ID is `31415926` (`0x1df5e76`). Do not assume a provider actor ID;
read `.runtime/devnet/status/latest.json`:

```sh
jq -r '.miner.provider' .runtime/devnet/status/latest.json
```

## Bundled CLI access

Use the project Compose file and generated environment; no global Lotus,
Curio, or Foundry installation is required:

```sh
docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T lotus lotus chain head --height

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T lotus lotus state miner-info \
  "$(jq -r '.miner.provider' .runtime/devnet/status/latest.json)"

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T curio curio cli --machine curio:12300 info

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T piece-server sptool --help

docker compose --env-file .runtime/devnet/compose.env \
  --project-name porep-market-curio-devnet \
  --file docker/compose.curio-devnet.yaml \
  exec -T contracts-bootstrap cast --version
```

The `contracts-bootstrap` service normally exits successfully after startup.
Use `docker compose run --rm --no-deps --entrypoint cast contracts-bootstrap
...` if a later manual `cast` invocation is needed while it is stopped.

## Runtime evidence

- image IDs and source commits: `.runtime/devnet/build/images.json`
- latest validated readiness: `.runtime/devnet/status/latest.json`
- active generation: `.runtime/devnet/generation`
- service/build/status logs: `.runtime/devnet/logs/`
- bounded reset evidence: `.runtime/reset-evidence/`
- active deployment selector: `.runtime/deployments/active.json`
- deployment revisions: `.runtime/deployments/<deployment-id>/revisions/`
- active sector fixture: `.runtime/fixtures/<generation>/active-sector.json`
- scenario and matrix reports: `.runtime/runs/`

## Measured arm64 run

Measurements were taken on an Apple arm64 host with 10 CPUs, 24 GiB host RAM,
7.65 GiB Docker memory, and Docker 29.2.1:

- corrected cold image build: 467 seconds;
- first chain startup through NV28 and validated status: about 12 minutes;
- non-destructive `down -> up -> status`: about 28 seconds;
- project reset through a new genesis, provider, and NV28 status: about
  14 minutes;
- proof parameter cache after the live gates: 5.8 GiB;
- active runtime data: about 450 MiB;
- steady six-service memory after reset: about 1.9 GiB total; sampled CPU was
  about 19%, dominated by Yugabyte.

The first validated chain used provider `t01003`. Restart preserved its
generation and genesis while the head advanced from 254 to 265. The scoped
reset changed the genesis from
`bafy2bzacec7prtzexq5yud2azjz3qbpvhftly6vofg3wgd7r25qtm5u7hyepe` to
`bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw`,
changed the runtime generation, created provider `t01004`, and passed
NV28/actors-v18 status at epoch 201. The unrelated Boost Compose container IDs
were unchanged.

## Whole-system proof

`just test-all` preserves the current chain, runs the selected PoRep Market
checkout's canonical Foundry tests, creates a new contract graph, and runs the
selected suite. `just test-fresh` is the destructive qualification path:
reset, locked clean deployment, contract and Curio suites, and runtime identity
verification. Those suites already contain every security-tagged scenario. The
contract suite is the fast non-sealing development loop; Curio and focused
security suites may perform real sealing or restart work. Use individual
lifecycle and suite commands during normal development.

Contract deployment and upgrade Forge processes use a private loopback RPC
adapter that represents Lotus null epochs as empty Ethereum-shaped blocks.
This prevents Foundry's block lookup retries from stalling deployment while
leaving Lotus, Curio, and scenario RPC traffic unchanged.
