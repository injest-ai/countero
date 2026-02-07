export interface ShutdownContext {
  onShutdown: () => Promise<void>;
  logger: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void };
}

export function setupSignalHandlers(ctx: ShutdownContext): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) {
      ctx.logger.warn('Forced exit on second signal', { signal });
      process.exit(1);
    }

    shuttingDown = true;
    ctx.logger.info('Received shutdown signal', { signal });

    try {
      await ctx.onShutdown();
      process.exit(0);
    } catch (err) {
      ctx.logger.warn('Error during shutdown', { error: String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
