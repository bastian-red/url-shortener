/** One link's live feed, for the tape on its page. */
import { forward, SSE_HEADERS, validId } from '../../../../../lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!validId(id)) return new Response(null, { status: 404 });
  return forward(request, `/links/${id}/live`, SSE_HEADERS);
}
