import { Env } from './env';
import TelegramBot from './api/telegram';
import { dashboardHtml } from './dashboard/dashboard';
import { LockContentionError } from './utils/redis';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/dashboard' && request.method === 'GET') {
        return dashboardHtml();
      }

      const bot = new TelegramBot(env, ctx);
      if (url.pathname === '/webhook') {
        return await bot.handleWebhook(request);
      }

      if (url.pathname === '/box/callback') {
        return await bot.handleBoxCompletion(request);
      }

      if (url.pathname === '/box/schedule-callback') {
        return await bot.handleBoxScheduleCompletion(request);
      }

      if (url.pathname === '/box/artifacts/authorize') {
        return await bot.handleBoxArtifactAuthorization(request);
      }

      const uploadMatch = url.pathname.match(/^\/box\/artifacts\/upload\/(ba_[a-z0-9_-]+)$/);
      if (uploadMatch) {
        return await bot.handleBoxArtifactUpload(request, uploadMatch[1]);
      }

      const artifactMatch = url.pathname.match(/^\/artifacts\/(ba_[a-z0-9_-]+)$/);
      if (artifactMatch) {
        return await bot.handleArtifactDownload(request, artifactMatch[1]);
      }

      if (url.pathname === '/dashboard/api' && request.method === 'GET') {
        return await bot.handleDashboardApi(request);
      }

      if (url.pathname === '/' || url.pathname === '') {
        return new Response('Hello! This is your Telegram bot worker.', { 
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      return new Response('Not Found', { 
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    } catch (error) {
      console.error('Error processing request:', error);
      if (error instanceof LockContentionError) {
        // Contention is transient. Tell the caller to retry instead of
        // reporting a fault it cannot act on.
        return new Response('Service Busy', {
          status: 503,
          headers: { 'Content-Type': 'text/plain', 'Retry-After': '2' },
        });
      }
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const bot = new TelegramBot(env, ctx);
    ctx.waitUntil(bot.processScheduledTasks());
  },
};
