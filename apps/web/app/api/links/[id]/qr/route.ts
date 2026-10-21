/** A link's QR code (SVG or PNG), straight from the API. */
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
    format: url.searchParams.get('format'),
    size: url.searchParams.get('size'),
    download: url.searchParams.get('download'),
  });
  return forward(request, `/links/${id}/qr${q}`);
}
