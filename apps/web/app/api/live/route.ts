/** The ledger's live feed: every click on the author's newest links. */
import { forward, SSE_HEADERS } from '../../../lib/proxy';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return forward(request, '/live', SSE_HEADERS);
}
