import { request as httpRequest } from "node:http";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Express 4 doesn't forward rejected promises to the error handler.
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export function requireString(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${field} must be 1-${max} chars`);
  return v.trim();
}

// Prod serves web and API on one host, so every API route (and the refresh cookie) lives under /api there.
export const apiBasePath = () => process.env.API_BASE_PATH ?? "";

// Single-origin deploys (Render): the API fronts the web app and streams every non-API request to it.
export function proxyTo(upstream: string): RequestHandler {
  const target = new URL(upstream);
  return (req, res) => {
    const upstreamReq = httpRequest(
      { hostname: target.hostname, port: target.port, path: req.originalUrl, method: req.method, headers: { ...req.headers, host: target.host } },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "web unavailable" });
    });
    req.pipe(upstreamReq);
  };
}
