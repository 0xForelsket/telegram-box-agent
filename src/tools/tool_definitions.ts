import { ToolDefinition } from "../api/chat_types";

/**
 * Tool schemas advertised to the model.
 *
 * These are data, not behaviour: none of them referenced bot state while they
 * lived as methods on TelegramBot. Keeping the catalogue in one place makes it
 * readable without scrolling past request-handling code.
 */

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the live web for current facts, breaking news, recent events, recent product changes, live prices, or anything likely to have changed recently.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A concise search query for the current information you need.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const STOCK_QUOTE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'stock_quote',
    description: 'Get a current stock, ETF, fund, or market-index quote. Use a ticker when known; otherwise provide the company or instrument name.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Ticker symbol or company/instrument name, for example "INTC", "SIVE.ST", or "Intel".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const CALCULATOR_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Evaluate exact arithmetic. Use this instead of mental arithmetic when a numeric result matters. Supports +, -, *, /, %, ^, and parentheses.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Arithmetic expression, for example "(1250 * 1.06) / 12".' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
};

export const WEATHER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'weather_forecast',
    description: 'Get current conditions and a three-day forecast for a city or postal code.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City, region, or postal code, for example "Kuala Lumpur".' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
};

export const CURRENCY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'currency_convert',
    description: 'Convert money using the latest available reference exchange rate.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to convert.' },
        from: { type: 'string', description: 'Three-letter source currency code, for example USD.' },
        to: { type: 'string', description: 'Three-letter destination currency code, for example MYR.' },
      },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
  },
};

export const GITHUB_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'github_repository',
    description: 'Inspect a public GitHub repository summary, latest releases, or open issues using structured GitHub data.',
    parameters: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Repository in owner/name format.' },
        view: { type: 'string', enum: ['summary', 'releases', 'issues'], description: 'Information to retrieve.' },
      },
      required: ['repository', 'view'],
      additionalProperties: false,
    },
  },
};

export const ARXIV_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'arxiv_search',
    description: 'Search recent arXiv research papers by topic and return titles, authors, dates, abstracts, and links.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research topic or keywords.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const REMINDER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_reminders',
    description: 'Create, list, or cancel Telegram reminders for this chat. Times are interpreted in Asia/Kuala_Lumpur. Only mutate reminders when the user clearly requests it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        schedule: { type: 'string', description: 'For create: "in 20m", "tomorrow 09:00", "daily 09:00", "weekly mon 09:00", or "YYYY-MM-DD HH:MM".' },
        text: { type: 'string', description: 'For create: reminder message.' },
        id: { type: 'string', description: 'For cancel: reminder ID returned by create or list.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

export const MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_memory',
    description: 'Explicitly save, recall, or forget durable facts and preferences for this chat. Only save or delete memory when the user clearly asks; recall when past preferences or facts are relevant.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'recall', 'forget'] },
        text: { type: 'string', description: 'Fact/preference to remember, or query/ID to recall or forget.' },
      },
      required: ['action', 'text'],
      additionalProperties: false,
    },
  },
};

export const AGENT_JOB_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_agent_jobs',
    description: 'Queue, list, or cancel a one-off background agent job persisted in Redis. Use create only when the user explicitly asks Bob to work in the background, continue later, or handle a task asynchronously. Do not queue ordinary questions that can be answered in the current reply. Queued jobs normally start on the next five-minute cron wake.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        goal: { type: 'string', description: 'For create: a self-contained goal with the requested final deliverable.' },
        id: { type: 'string', description: 'For cancel: agent job ID returned by create or list.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

export const READ_URL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_url',
    description: 'Open and read a specific HTTP or HTTPS page supplied by the user. Use this when a linked page is central to the request; if the site blocks direct reading, the tool can recover indexed evidence through web search.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The complete HTTP or HTTPS URL to read.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
};

export const WIKIPEDIA_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'wikipedia_lookup',
    description: 'Look up a person, place, event, concept, or work on Wikipedia for an encyclopedic summary. Best for stable facts, not breaking news.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The subject to look up. Prefer a concise noun phrase, e.g. "Magnus Carlsen" or "Battle of Mactan".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};
