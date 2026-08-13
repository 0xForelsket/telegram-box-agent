export interface ToolCall {
  id: string;
  index?: number;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageURLContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type MessageContentPart = TextContentPart | ImageURLContentPart;
export type MessageContent = string | MessageContentPart[];

export interface Message {
  role: MessageRole;
  content: MessageContent | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  enum?: readonly JsonValue[];
  const?: JsonValue;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  format?: string;
  default?: JsonValue;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export type ToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

export interface ChatCompletionMessage {
  role: MessageRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}
