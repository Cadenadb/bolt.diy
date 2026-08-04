import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';

function persistenceConfig(env: Record<string, string>) {
  return { baseUrl: env.PERSISTENCE_API_URL, secret: env.PERSISTENCE_API_SECRET };
}

export async function loader({ context, params }: LoaderFunctionArgs) {
  const { baseUrl, secret } = persistenceConfig(context.cloudflare?.env as Record<string, string>);
  const response = await fetch(`${baseUrl}/snapshots/${encodeURIComponent(params.chatId!)}`, {
    headers: { 'x-api-secret': secret },
  });
  const body = await response.text();

  return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
}

export async function action({ context, params, request }: ActionFunctionArgs) {
  const { baseUrl, secret } = persistenceConfig(context.cloudflare?.env as Record<string, string>);
  const chatId = encodeURIComponent(params.chatId!);

  if (request.method === 'PUT') {
    const body = await request.text();
    const response = await fetch(`${baseUrl}/snapshots/${chatId}`, {
      method: 'PUT',
      headers: { 'x-api-secret': secret, 'Content-Type': 'application/json' },
      body,
    });
    const respBody = await response.text();

    return new Response(respBody, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'DELETE') {
    const response = await fetch(`${baseUrl}/snapshots/${chatId}`, {
      method: 'DELETE',
      headers: { 'x-api-secret': secret },
    });
    const respBody = await response.text();

    return new Response(respBody, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}
