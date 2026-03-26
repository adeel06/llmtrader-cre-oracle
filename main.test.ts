import { describe, expect } from "bun:test";
import { test } from "@chainlink/cre-sdk/test";
import { initWorkflow } from "./main";
import type { Config } from "./main";

const testConfig: Config = {
  schedule: "*/5 * * * *",
  coinGeckoBaseUrl: "https://api.coingecko.com/api/v3/simple/price",
  quoteCurrencies: "usd,usdc",
  tokens: { bitcoin: "BTC", ethereum: "ETH" },
  providers: [
    {
      name: "deepseek/deepseek-chat-v4",
      model: "deepseek-chat",
      url: "https://api.deepseek.com/v1/chat/completions",
      secretKey: "DEEPSEEK_API_KEY",
      type: "openai_compat",
    },
  ],
  evms: [
    {
      oracleAddress: "0x0000000000000000000000000000000000000000",
      chainSelectorName: "ethereum-testnet-sepolia",
      gasLimit: "500000",
      isTestnet: true,
    },
  ],
};

describe("initWorkflow", () => {
  test("returns one handler", async () => {
    const handlers = initWorkflow(testConfig);

    expect(handlers).toBeArray();
    expect(handlers).toHaveLength(1);
  });
});
