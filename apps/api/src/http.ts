import type { Request, Response, NextFunction, RequestHandler } from "express";

// Express 4 doesn't forward rejected promises to the error handler.
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);
