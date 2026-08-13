import { Message } from './chat_types';

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface ModelResponse {
  content: string;
  usage?: ModelUsage;
  resolvedModel?: string;
}

export interface ModelAPIInterface {
  generateResponse(messages: Message[], model?: string): Promise<string>;
  generateResponseWithMetadata?(messages: Message[], model?: string): Promise<ModelResponse>;
  isValidModel(model: string): boolean;
  getDefaultModel(): string;
  getAvailableModels(): string[];
  getModels?(): Promise<string[]>;
  analyzeImage?(imageUrl: string, prompt: string, model: string): Promise<string>;
}
