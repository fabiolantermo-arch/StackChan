export type Secrets = { ROBOT_API_TOKEN?: string };
export async function authorized(request: Request, token?: string) {
  if (!token || token.length < 32) return false;
  const encode = new TextEncoder();
  const [a,b] = await Promise.all([request.headers.get('authorization') ?? '', 'Bearer ' + token].map(s => crypto.subtle.digest('SHA-256',encode.encode(s))));
  return crypto.subtle.timingSafeEqual(a,b);
}
