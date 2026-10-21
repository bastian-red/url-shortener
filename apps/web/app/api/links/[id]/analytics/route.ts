/**
 * A report over a sub-range, for the breakdowns when the author brushes the
 * timeline. The API validates the range; this only forwards it.
 */
import { query } from '../../../../../lib/api';
import { forward, validId } from '../../../../../lib/proxy';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!validId(id)) return new Response(null, { status: 404 });
  const url = new URL(request.url);
  const q = query({
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    tz: url.searchParams.get('tz'),
    includeBots: url.searchParams.get('includeBots'),
  });
  return forward(request, `/links/${id}/analytics${q}`);
}
