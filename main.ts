// LLMTrader AI Trading Oracle: CRE Workflow
// Each AI model is queried via its native API endpoint (no OpenRouter middleman)
// Tracks top 30 tokens by market cap for full market context

import {
  CronCapability,
  ConfidentialHTTPClient,
  EVMClient,
  HTTPClient,
  consensusIdenticalAggregation,
  getNetwork,
  handler,
  ok,
  prepareReportRequest,
  Runner,
  text,
  TxStatus,
  bytesToHex,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toBytes,
} from 'viem';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const providerSchema = z.object({
  name: z.string(),
  model: z.string(),
  url: z.string().url(),
  secretKey: z.string(), // vault secret name, e.g. "ANTHROPIC_API_KEY"
  type: z.enum(['anthropic', 'openai_compat', 'google']),
});

const configSchema = z.object({
  schedule: z.string(),
  coinGeckoBaseUrl: z.string().url(),
  quoteCurrencies: z.string(),
  tokens: z.record(z.string()),
  providers: z.array(providerSchema).min(1),
  evms: z.array(
    z.object({
      oracleAddress: z.string(),
      chainSelectorName: z.string(),
      gasLimit: z.string(),
      isTestnet: z.boolean(),
    })
  ),
});
export type Config = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Direction = 'BUY' | 'SELL' | 'HOLD';

interface ModelSignal {
  model: string;
  modelId: `0x${string}`;
  direction: Direction;
  confidence: number;
}

interface TokenPrice {
  symbol: string;
  coingeckoId: string;
  tokenId: `0x${string}`;
  price: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIRECTION_MAP: Record<Direction, number> = { HOLD: 0, BUY: 1, SELL: 2 };

function modelNameToId(name: string): `0x${string}` {
  return keccak256(toBytes(name));
}

function tokenSymbolToId(symbol: string): `0x${string}` {
  return keccak256(toBytes(symbol));
}

function parseSignal(raw: string, model: string): ModelSignal {
  const modelId = modelNameToId(model);
  const jsonMatch = raw.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    return { model, modelId, direction: 'HOLD', confidence: 0 };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const direction = ['BUY', 'SELL', 'HOLD'].includes(parsed.direction)
      ? (parsed.direction as Direction)
      : 'HOLD';
    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
    return { model, modelId, direction, confidence };
  } catch {
    return { model, modelId, direction: 'HOLD', confidence: 0 };
  }
}

// ---------------------------------------------------------------------------
// Build request body per provider type
// ---------------------------------------------------------------------------

function buildRequestBody(provider: z.infer<typeof providerSchema>, prompt: string): string {
  if (provider.type === 'anthropic') {
    return JSON.stringify({
      model: provider.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });
  }

  if (provider.type === 'google') {
    return JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 100, temperature: 0 },
    });
  }

  // openai_compat: DeepSeek, Qwen/DashScope, Groq, Mistral, xAI
  return JSON.stringify({
    model: provider.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 100,
    temperature: 0,
  });
}

function buildAuthHeader(provider: z.infer<typeof providerSchema>): Record<string, { values: string[] }> {
  if (provider.type === 'anthropic') {
    return {
      'Content-Type': { values: ['application/json'] },
      'x-api-key': { values: [`{{${provider.secretKey}}}`] },
      'anthropic-version': { values: ['2023-06-01'] },
    };
  }

  // google: key goes in URL query param, but CRE ConfidentialHTTP uses headers
  // For AI Studio, the key is in the URL: ?key={{GOOGLE_API_KEY}}
  if (provider.type === 'google') {
    return {
      'Content-Type': { values: ['application/json'] },
    };
  }

  // openai_compat
  return {
    'Content-Type': { values: ['application/json'] },
    'Authorization': { values: [`Bearer {{${provider.secretKey}}}`] },
  };
}

function parseModelResponse(provider: z.infer<typeof providerSchema>, body: string): string {
  const parsed = JSON.parse(body);

  if (provider.type === 'anthropic') {
    return parsed.content?.[0]?.text ?? '';
  }

  if (provider.type === 'google') {
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // openai_compat
  return parsed.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Node-level: fetch prices from CoinGecko (public API, no secrets)
// ---------------------------------------------------------------------------

function fetchPrices(sendRequester: HTTPSendRequester, url: string): string {
  const response = sendRequester
    .sendRequest({ url, method: 'GET' })
    .result();

  if (!ok(response)) {
    throw new Error(`CoinGecko failed: ${response.statusCode}`);
  }
  return text(response);
}

// ---------------------------------------------------------------------------
// Workflow callback
// ---------------------------------------------------------------------------

export function onCronTrigger(runtime: Runtime<Config>) {
  runtime.log('AI Trading Oracle: triggered');

  const httpClient = new HTTPClient();
  const confidentialClient = new ConfidentialHTTPClient();
  const cfg = runtime.config;

  // 1. Fetch prices from CoinGecko
  const ids = Object.keys(cfg.tokens).join(',');
  const coinGeckoUrl = `${cfg.coinGeckoBaseUrl}?ids=${ids}&vs_currencies=${cfg.quoteCurrencies}`;

  const priceJson = httpClient
    .sendRequest(runtime, fetchPrices, consensusIdenticalAggregation())
    (coinGeckoUrl)
    .result();

  const priceData = JSON.parse(priceJson);

  // 2. Parse prices: prefer USDC, fall back to USD
  const tokenPrices: TokenPrice[] = [];
  for (const [coingeckoId, symbol] of Object.entries(cfg.tokens)) {
    const data = priceData[coingeckoId];
    const price = data?.usdc ?? data?.usd ?? 0;
    tokenPrices.push({
      symbol,
      coingeckoId,
      tokenId: tokenSymbolToId(symbol),
      price,
    });
  }

  runtime.log(`Fetched ${tokenPrices.length} token prices`);

  // 3. Build prompt
  const priceLines = tokenPrices
    .filter(t => t.price > 0)
    .map(t => `${t.symbol}: $${t.price}`)
    .join(' | ');

  const prompt = [
    'You are a crypto trading analyst. Based on the current market prices across the top tokens,',
    'provide a trading signal for the overall crypto market.',
    '',
    priceLines,
    '',
    'Respond with EXACTLY one JSON object (no markdown, no explanation):',
    '{"direction": "BUY" | "SELL" | "HOLD", "confidence": <number 0-100>}',
  ].join('\n');

  // 4. Query each provider via its native API (ConfidentialHTTP keeps keys secure)
  const signals: ModelSignal[] = [];

  for (const provider of cfg.providers) {
    try {
      // Google AI Studio puts the key in the URL
      let url = provider.url;
      if (provider.type === 'google') {
        url = `${provider.url}?key={{${provider.secretKey}}}`;
      }

      const response = confidentialClient.sendRequest(runtime, {
        vaultDonSecrets: [{ key: provider.secretKey }],
        request: {
          url,
          method: 'POST',
          multiHeaders: buildAuthHeader(provider),
          bodyString: buildRequestBody(provider, prompt),
        },
      }).result();

      if (!ok(response)) {
        runtime.log(`${provider.name}: HTTP ${response.statusCode}, defaulting to HOLD`);
        signals.push({ model: provider.name, modelId: modelNameToId(provider.name), direction: 'HOLD', confidence: 0 });
        continue;
      }

      const raw = parseModelResponse(provider, text(response));
      const signal = parseSignal(raw, provider.name);
      signals.push(signal);
      runtime.log(`${provider.name}: ${signal.direction} (${signal.confidence}%)`);
    } catch {
      runtime.log(`${provider.name}: failed, defaulting to HOLD`);
      signals.push({ model: provider.name, modelId: modelNameToId(provider.name), direction: 'HOLD', confidence: 0 });
    }
  }

  // 5. Encode report: token prices + per-model signals
  const reportData = encodeAbiParameters(
    parseAbiParameters('bytes32[], uint256[], uint8, bytes32[], uint8[], uint8[]'),
    [
      tokenPrices.map(t => t.tokenId),
      tokenPrices.map(t => BigInt(Math.round(t.price * 1e8))),
      signals.length,
      signals.map(s => s.modelId),
      signals.map(s => DIRECTION_MAP[s.direction]),
      signals.map(s => s.confidence),
    ]
  );

  // 6. Sign report + write to chain
  const report = runtime.report(prepareReportRequest(reportData)).result();

  for (const evm of cfg.evms) {
    const network = getNetwork({
      chainFamily: 'evm',
      chainSelectorName: evm.chainSelectorName,
      isTestnet: evm.isTestnet ?? false,
    });
    if (!network) {
      runtime.log(`Unknown chain: ${evm.chainSelectorName}`);
      continue;
    }

    const evmClient = new EVMClient(network.chainSelector.selector);
    const resp = evmClient
      .writeReport(runtime, {
        receiver: evm.oracleAddress,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(`Write to ${evm.chainSelectorName} failed: ${resp.txStatus}`);
    } else {
      const hash = resp.txHash ? bytesToHex(resp.txHash) : 'unknown';
      runtime.log(`${tokenPrices.length} prices + ${signals.length} signals written: tx=${hash}`);
    }
  }

  return signals.map(s => `${s.model}=${s.direction}`).join(', ');
}

// ---------------------------------------------------------------------------
// Workflow entry point
// ---------------------------------------------------------------------------

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
