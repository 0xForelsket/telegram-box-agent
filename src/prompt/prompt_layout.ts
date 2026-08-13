import { Message } from '../api/chat_types';

export interface PromptLayoutInput {
  soul: string;
  baseInstructions: string;
  replyStyle: string;
  stableMemory?: string | null;
  recentTurns: Message[];
  volatileContext?: string | null;
  dateTimeContext?: string | null;
  userMessage: string;
}

export function buildPromptLayout(input: PromptLayoutInput): Message[] {
  return [
    { role: 'system', content: input.soul },
    { role: 'system', content: input.baseInstructions },
    { role: 'system', content: input.replyStyle },
    ...(input.stableMemory ? [{ role: 'system' as const, content: input.stableMemory }] : []),
    ...input.recentTurns,
    ...(input.volatileContext ? [{ role: 'system' as const, content: input.volatileContext }] : []),
    ...(input.dateTimeContext ? [{ role: 'system' as const, content: input.dateTimeContext }] : []),
    { role: 'user', content: input.userMessage },
  ];
}
