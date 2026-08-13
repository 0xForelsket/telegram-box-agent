import { getConfig } from "../../env";
import { BotSettings } from "../../config/command_types";
import { DurableMemory } from "../../memory/durable_memory";
import {
  ActiveTopic,
  PersonCard,
  SeenMember,
} from "../../memory/prompt_memory";
import {
  ChatCompletionResponse,
  Message,
  ToolChoice,
  ToolDefinition,
} from "../chat_types";

export type AppConfig = ReturnType<typeof getConfig>;

export interface MemoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface FeedSubscription {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface ActiveTaskRecord {
  id: string;
  type: string;
  status: "running" | "cancelled";
  startedAt: string;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface ExtractedMemoryPayload {
  summary: string;
  group_profile_additions?: string[];
  person_cards?: Array<{
    name: string;
    notes: string[];
  }>;
  active_topics?: Array<{
    topic: string;
    status?: string;
  }>;
}

export type StaticProviderId =
  | "openai"
  | "google"
  | "groq"
  | "claude"
  | "azure";

export interface ImageCapableAPI {
  analyzeImage(
    imageUrl: string,
    prompt: string,
    model: string,
  ): Promise<string>;
}

export interface ChatCompletionClient {
  createChatCompletion(
    messages: Message[],
    model?: string,
    options?: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
  ): Promise<ChatCompletionResponse>;
  createStreamingChatCompletion?(
    messages: Message[],
    model: string | undefined,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse>;
}

export interface PromptState {
  botSettings: BotSettings;
  groupProfile: string | null;
  personCards: PersonCard[];
  activeTopics: ActiveTopic[];
  conversationSummary: string | null;
  recentTurns: MemoryTurn[];
  ambientMessages: string[];
  seenMembers: SeenMember[];
  durableMemories?: DurableMemory[];
  currentModel: string;
}

export type ReplyStyle = BotSettings["replyStyle"];
export type ModelRole = "utility" | "summary" | "research" | "vision";
