import jwt, { type JwtPayload } from "jsonwebtoken";

function secret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET") {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const signAccess = ({ userId }: { userId: string }) =>
  jwt.sign({ sub: userId }, secret("JWT_ACCESS_SECRET"), { expiresIn: "15m" });

export const signRefresh = ({ userId, tokenId }: { userId: string; tokenId: string }) =>
  jwt.sign({ sub: userId, jti: tokenId }, secret("JWT_REFRESH_SECRET"), { expiresIn: "7d" });

// Both throw on bad signature / expiry.
export function verifyAccess(token: string) {
  const p = jwt.verify(token, secret("JWT_ACCESS_SECRET"), { algorithms: ["HS256"] }) as JwtPayload;
  return { userId: p.sub! };
}

export function verifyRefresh(token: string) {
  const p = jwt.verify(token, secret("JWT_REFRESH_SECRET"), { algorithms: ["HS256"] }) as JwtPayload;
  return { userId: p.sub!, tokenId: p.jti! };
}
