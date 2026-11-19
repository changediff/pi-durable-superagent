/** pi-ai provider catalog for the port: one Zhipu GLM provider, OpenAI Chat Completions transport. */
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { Config } from './config.ts'

export function buildModels(cfg: Config) {
  const models = createModels()
  const api = openAICompletionsApi()
  const entry = (id: string, name: string) => ({
    id,
    name,
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: 'openai-completions',
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
  })
  models.setProvider(createProvider({
    id: cfg.provider,
    name: 'Zhipu GLM',
    baseUrl: cfg.baseUrl,
    auth: { apiKey: envApiKeyAuth('Zhipu', [cfg.apiKeyEnv]) },
    // The watchdog model defaults to the worker's, so it is usually already listed; dedupe for the explicit case.
    models: [...new Set([cfg.model, cfg.workerModel, cfg.watchdog.model])].map(id => entry(id, `GLM ${id}`)),
    api,
  }))
  return models
}
