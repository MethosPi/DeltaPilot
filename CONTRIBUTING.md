# Contributing to DeltaPilot

## Prerequisites

- Node.js >= 22
- pnpm >= 9

## Setup

```bash
git clone https://github.com/MethosPi/DeltaPilot.git
cd DeltaPilot
pnpm install
pnpm build
pnpm test
```

## Running locally

```bash
cp .env.example .env
# edit .env: set DP_REPO to an absolute path of a git repo on your machine
node scripts/register-agent.mjs   # prints your DP_AGENT_ID
pnpm demo
```

## Development workflow

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Write tests first (packages live in `packages/`, tests alongside source)
3. `pnpm test` must pass before opening a PR
4. Open a PR against `main` — describe the problem and your approach

## Reporting bugs

Open a [GitHub issue](https://github.com/MethosPi/DeltaPilot/issues). Include:
- Node and pnpm versions
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing you agree your contributions are licensed under MIT.
