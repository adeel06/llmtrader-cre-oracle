# LLMTrader CRE - AI Trading Oracle

Chainlink CRE (Compute Runtime Environment) workflow that queries multiple frontier AI models for independent BUY/SELL/HOLD trading signals, then writes all signals + token prices on-chain via the LLMTraderOracle contract.

## Architecture

1. **Cron trigger** fires every 5 minutes
2. **CoinGecko** fetches live prices for 30 tokens (top by market cap)
3. **OpenRouter** queries 3-6 AI models (DeepSeek, Qwen, Claude, Gemini, etc.) with market context
4. Each model returns an independent `{direction, confidence}` signal
5. **ABI-encoded report** (token prices + per-model signals) is signed by CRE DON
6. **On-chain write** to LLMTraderOracle contract on each configured EVM chain

## Setup

```bash
bun install
```

## Simulate

```bash
cre workflow simulate . --target=staging-settings
```

## Test

```bash
bun test
```

## Deploy

```bash
cre workflow deploy . --target=production-settings
```

## Config

- `config.staging.json` - 3 models, Sepolia testnet
- `config.production.json` - 6 models, multi-chain

## Contract

`contracts/LLMTraderOracle.sol` - Ownable2Step + Pausable, receives ABI-decoded reports with token prices and per-model signals.
