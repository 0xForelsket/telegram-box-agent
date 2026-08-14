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
    description: 'Search the live web for current facts, breaking news, recent events, recent product changes, live prices, or anything likely to have changed recently. Use depth "deep" for a question that needs several searches cross-checked against each other rather than one lookup.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A concise search query for the current information you need.',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'deep'],
          // `deep` reaches the multi-query research flow, which the retired
          // /research command was the only way to trigger. Kept as a parameter
          // rather than a second tool so the catalogue does not grow.
          description: 'Defaults to quick. "deep" runs several ranked searches and reads the best pages; it is slower and costs more.',
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
    // Widened rather than split into four tools: every tool schema ships in
    // every prompt, so one `operation` enum costs far less than three more
    // entries in the catalogue.
    description: 'Exact deterministic computation: arithmetic, unit conversion, clock time in a timezone, and date arithmetic. Use this instead of working any of them out yourself when the result matters.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['arithmetic', 'convert', 'time', 'date'],
          description: 'Defaults to arithmetic when omitted.',
        },
        expression: {
          type: 'string',
          description: 'arithmetic: "(1250 * 1.06) / 12". convert: "12 km to miles". time: an IANA zone such as "Asia/Tokyo". date: "days between 2026-01-01 and 2026-08-14" or "2026-08-14 plus 90 days".',
        },
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
    // Reminders and digests are the same durable scheduler subsystem, so they
    // share one tool rather than duplicating the schema under another name.
    description: "Create, list, or cancel this chat's scheduled work: one-off and recurring reminders, and recurring feed/search/stock digests. Times are interpreted in the bot's configured timezone. Only mutate schedules when the user clearly requests it.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        kind: {
          type: 'string',
          enum: ['reminder', 'digest'],
          description: 'Defaults to reminder when omitted.',
        },
        schedule: { type: 'string', description: 'For create: "in 20m", "tomorrow 09:00", "daily 09:00", "weekly mon 09:00", or "YYYY-MM-DD HH:MM". Digests must be daily or weekly.' },
        text: { type: 'string', description: 'For a reminder: the message. For a digest: "feeds", "search <topic>", or "stock <symbol>".' },
        id: { type: 'string', description: 'For cancel: ID returned by create or list.' },
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
    // Bookmarks and feed subscriptions are saved-for-later state like durable
    // facts, so they extend this tool instead of adding two more schemas.
    description: "Explicitly save, recall, or forget this chat's durable state: facts and preferences, saved bookmarks, and followed RSS/Atom feeds. Only save or delete when the user clearly asks; recall when past preferences, links, or facts are relevant.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'recall', 'forget'] },
        kind: {
          type: 'string',
          enum: ['fact', 'bookmark', 'feed'],
          description: 'Defaults to fact when omitted.',
        },
        text: { type: 'string', description: 'Fact to remember, URL to bookmark or follow, or a query/ID to recall or forget. Bookmarks may append a title after the URL.' },
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
