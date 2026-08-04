import { type LoaderFunctionArgs } from '@remix-run/cloudflare';

export async function loader({ context, request }: LoaderFunctionArgs) {
  const env = context.cloudflare?.env as Record<string, string>;
  const url = new URL(request.url);
  const base = url.searchParams.get('base') ?? '';

  const response = await fetch(`${env.PERSISTENCE_API_URL}/chats/meta/next-url-id?base=${encodeURIComponent(base)}`, {
    headers: { 'x-api-secret': env.PERSISTENCE_API_SECRET },
  });
  const body = await response.text();

  return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
}
