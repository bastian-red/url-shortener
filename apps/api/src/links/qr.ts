/**
 * QR codes for a short link.
 *
 * Black on white with a 4-module quiet zone, whatever the app's theme: scanner
 * apps are tuned for dark-on-light, and a "branded" low-contrast code is a code
 * that fails in a dim room. Error correction M (15%) survives a crease or a
 * sticker corner without making the code denser than a short URL needs.
 *
 * The encoded text is the short URL, never the destination, so the code keeps
 * working when the owner edits where the link goes. The E2E suite decodes the
 * PNG and asserts exactly that.
 */
import QRCode from 'qrcode';

export type QrFormat = 'svg' | 'png';

const OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 4,
  color: { dark: '#000000', light: '#ffffff' },
} as const;

export async function renderQr(text: string, format: QrFormat, size: number): Promise<Buffer> {
  if (format === 'svg') {
    return Buffer.from(
      await QRCode.toString(text, { ...OPTIONS, type: 'svg', width: size }),
      'utf8',
    );
  }
  return QRCode.toBuffer(text, { ...OPTIONS, type: 'png', width: size });
}
