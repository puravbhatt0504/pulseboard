import type { RequestHandler } from "express";
import { verifyAccess } from "./jwt.js";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return void res.status(401).json({ error: "unauthorized" });
  try {
    req.userId = verifyAccess(token).userId;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
};
