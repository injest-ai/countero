import { z } from 'zod';

export const configSchema = z.object({
  redis: z.object({
    url: z.string().url(),
  }),
  mongodb: z.object({
    uri: z.string(),
    collectionName: z.string().default('counters'),
  }),
  stream: z.object({
    key: z.string().default('counter-bridge:events'),
    consumerGroup: z.string().default('counter-bridge-group'),
    consumerId: z.string().default(`consumer-${process.pid}`),
  }).default({}),
  batching: z.object({
    maxWaitMs: z.number().int().positive().default(500),
    maxMessages: z.number().int().positive().default(1000),
  }).default({}),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),
  health: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().positive().default(9090),
  }).default({}),
});

export type ValidatedConfig = z.infer<typeof configSchema>;
