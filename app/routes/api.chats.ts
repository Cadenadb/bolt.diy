import { type LoaderFunctionArgs } from '@remix-run/cloudflare';

export async function loader({ context }: LoaderFunctionArgs) {
  const env = context.cloudflare?.env as Record<string, string>;
  const response = await fetch(`${env.PERSISTENCE_API_URL}/chats`, {
    headers: { 'x-api-secret': env.PERSISTENCE_API_SECRET },
  });
  const body = await response.text();

  return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
}
