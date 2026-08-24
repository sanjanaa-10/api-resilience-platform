import type { Request, Response } from 'express';
import { healthService } from '../services/health.service';

/**
 * HTTP adapter for health checks — no business logic here.
 * Returns the exact payload contract defined in types/index.ts.
 */
export function getHealth(_req: Request, res: Response): void {
  res.status(200).json(healthService.getHealth());
}

export const healthController = { getHealth } as const;
